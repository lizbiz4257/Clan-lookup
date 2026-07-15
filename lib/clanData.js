// lib/clanData.js
// Shared helpers for talking to the Royale API. Used by both api/lookup.js
// (on-demand searches) and api/sync-to-sheet.js (scheduled sheet sync).

const API_BASE = 'https://proxy.royaleapi.dev/v1';

const FAMILY_TAGS = [
  '#YQJPR2V9', '#L0PQ2ULQ', '#YRVC9QVJ', '#G9LRRP82',
  '#GURCRRY9', '#QJU8P80C', '#GY0QQGYY',
  '#QVY92JLV', '#GQ20UQR8'
];

// Same two clans: manually-supplied day-level data lets us exclude Day 4
// entirely (use D1+D2+D3 only) for weeks where that data has been provided.
// Data lives in data/day-corrections.json, keyed by clan tag then by week
// label (e.g. "134-1", matching the same notation you already use).
const DAY_CORRECTION_TAGS = ['#YRVC9QVJ', '#YQJPR2V9'];

let dayCorrectionsCache = null;
async function loadDayCorrections() {
  if (dayCorrectionsCache) return dayCorrectionsCache;
  try {
    const resp = await fetch(
      'https://raw.githubusercontent.com/' + process.env.GITHUB_REPO + '/main/data/day-corrections.json'
    );
    dayCorrectionsCache = resp.ok ? await resp.json() : {};
  } catch (err) {
    dayCorrectionsCache = {};
  }
  return dayCorrectionsCache;
}

// Builds the same "134-1" style label used elsewhere, from a riverracelog
// race entry, so corrections can be matched to the right week reliably even
// as weeks roll forward (instead of relying on array position).
function raceWeekLabel(race) {
  if (race.seasonId != null && race.sectionIndex != null) {
    return race.seasonId + '-' + race.sectionIndex;
  }
  return null;
}

// Short-lived cache so the same endpoint isn't fetched twice within a few
// seconds of each other — this matters a lot now that buildFamilyIndex and
// lookupOneClan both request the same clans' data in a single search.
const apiCache = new Map();
const CACHE_TTL_MS = 15000;

async function royaleApiGet(endpoint) {
  const cached = apiCache.get(endpoint);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.data;
  }

  const resp = await fetch(API_BASE + endpoint, {
    headers: { Authorization: 'Bearer ' + process.env.ROYALE_API_TOKEN }
  });
  if (!resp.ok) {
    throw new Error('Royale API error ' + resp.status + ' for ' + endpoint + ': ' + (await resp.text()));
  }
  const data = await resp.json();
  apiCache.set(endpoint, { data, time: Date.now() });
  return data;
}

function normalizeClanTag(input) {
  let t = String(input || '').trim().toUpperCase();
  if (!t) return '';
  if (t.charAt(0) !== '#') t = '#' + t;
  return t;
}

function looksLikeTag(input) {
  const t = String(input || '').trim().toUpperCase().replace(/^#/, '');
  return /^[0289PYLQGRJCUV]{3,14}$/.test(t);
}

async function getPlayerInfo(playerTag) {
  return royaleApiGet('/players/' + encodeURIComponent(playerTag));
}

// Builds a lightweight index across ALL family clans: for every player tag,
// which family clan they're currently in (if any), their score/attack history
// in each clan, and (if not currently in any) which family clan they most
// recently appeared in. Powers both "last known family clan" and "new joiner
// prior history" without extra live lookups per player.
async function buildFamilyIndex() {
  const perClan = await Promise.all(FAMILY_TAGS.map(async (tag) => {
    const encTag = encodeURIComponent(tag);
    let clanInfo;
    try {
      clanInfo = await royaleApiGet('/clans/' + encTag);
    } catch (err) {
      return null;
    }

    const currentMembers = {};
    (clanInfo.memberList || []).forEach((m) => { currentMembers[m.tag] = true; });

    let races = [];
    try {
      const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
      races = (log.items || []).slice(0, 5);
    } catch (err) { /* no history available */ }

    const lastSeenWeek = {};   // playerTag -> weekIndex, 0 = most recent
    const scoresByPlayer = {}; // playerTag -> { scores: [], attacks: [] }
    races.forEach((race, weekIndex) => {
      const standing = (race.standings || []).find((s) => s.clan.tag === tag);
      if (!standing) return;
      const participants = standing.clan.participants || [];

      participants.forEach((p) => {
        if (!(p.tag in lastSeenWeek)) lastSeenWeek[p.tag] = weekIndex;
        if (!scoresByPlayer[p.tag]) scoresByPlayer[p.tag] = { scores: [], attacks: [] };
        scoresByPlayer[p.tag].scores.push(p.fame);
        scoresByPlayer[p.tag].attacks.push(p.decksUsed);
      });
    });

    return { tag, name: clanInfo.name, currentMembers, lastSeenWeek, scoresByPlayer, warTrophies: clanInfo.clanWarTrophies || 0 };
  }));

  return perClan.filter(Boolean);
}

// Given a player tag and the family index, finds their last-known family clan
// — preferring a clan they're CURRENTLY in (if it's a different one than the
// one being viewed), otherwise the most recent clan they appeared in history.
// Returns null if they don't show up anywhere in the family at all.
function resolveLastFamilyClan(playerTag, familyIndex, excludeTag) {
  const currentElsewhere = familyIndex.find((c) => c.tag !== excludeTag && c.currentMembers[playerTag]);
  if (currentElsewhere) return currentElsewhere.name;

  let best = null;
  familyIndex.forEach((c) => {
    if (playerTag in c.lastSeenWeek) {
      if (!best || c.lastSeenWeek[playerTag] < best.week) {
        best = { name: c.name, week: c.lastSeenWeek[playerTag] };
      }
    }
  });
  return best ? best.name : null;
}

// For a NEW joiner (someone with no history in the clan they just joined),
// finds their most recent OTHER family clan and returns their 5-week score
// history from there — but ONLY if that clan is in the EXACT SAME league
// (same 1000-trophy bucket, e.g. both 5000-5999 or both 4000-4999) as the
// clan they just joined (or, for non-current-members, whichever clan they were
// last active in). requireSameLeague controls whether trophy-tier matching is
// enforced — true for genuine new joiners, false to allow cross-tier movement
// (e.g. someone who's currently in 4.0 but was in 2.0 last week should still
// show that, even though those are different leagues).
function resolvePriorClanHistory(playerTag, familyIndex, excludeTag, currentClanWarTrophies, requireSameLeague) {
  const currentLeague = Math.floor((currentClanWarTrophies || 0) / 1000);

  let best = null;
  familyIndex.forEach((c) => {
    if (c.tag === excludeTag) return;
    if (requireSameLeague) {
      const priorLeague = Math.floor((c.warTrophies || 0) / 1000);
      if (priorLeague !== currentLeague) return; // different league — skip
    }
    if (playerTag in c.lastSeenWeek) {
      if (!best || c.lastSeenWeek[playerTag] < best.week) {
        best = { clanName: c.name, week: c.lastSeenWeek[playerTag], data: c.scoresByPlayer[playerTag] };
      }
    }
  });
  if (!best) return null;

  const scores = best.data.scores;
  const attacks = best.data.attacks;
  const totalScore = scores.reduce((a, b) => a + b, 0);
  const totalAttacks = attacks.reduce((a, b) => a + b, 0);

  return {
    priorClanName: best.clanName,
    priorAvgScore: scores.length ? Math.round((totalScore / scores.length) * 100) / 100 : null,
    priorAvgAttacks: attacks.length ? Math.round((totalAttacks / attacks.length) * 100) / 100 : null,
    priorWeeksTracked: scores.length,
    priorWeeks: scores.map((s, i) => ({ score: s, attacks: attacks[i] })) // full week-by-week, most recent first
  };
}

// Fetches and computes rows for ONE clan. Returns { clanTag, clanName, memberCount, rows }.
// familyIndex is optional — pass one in (from buildFamilyIndex) to enable the
// "last known family clan" column for anyone not currently a member here.
async function lookupOneClan(tag, familyIndex) {
  const encTag = encodeURIComponent(tag);
  const clanInfo = await royaleApiGet('/clans/' + encTag);

  let currentParticipants = {};
  try {
    const currentRace = await royaleApiGet('/clans/' + encTag + '/currentriverrace');
    // Only show live scores during an actual battle day — periodType is
    // "warDay" when attacks count, or "training" during non-battle periods
    // (including the gap between one war ending and the next starting).
    if (currentRace.periodType === 'warDay') {
      (currentRace.clan.participants || []).forEach((p) => {
        currentParticipants[p.tag] = { name: p.name, attacks: p.decksUsed, score: p.fame };
      });
    }
  } catch (err) {
    // no race currently running
  }

  // Manually-supplied day-level data, for TKO and !Baked! 2.0 only — lets us
  // use D1+D2+D3 (excluding Day 4 entirely) for weeks where it's available.
  const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
  const races = (log.items || []).slice(0, 5);

  const dayCorrections = DAY_CORRECTION_TAGS.includes(tag) ? await loadDayCorrections() : {};
  const clanCorrections = dayCorrections[tag] || {};

  const history = {};

  races.forEach((race, weekIndex) => {
    const standing = (race.standings || []).find((s) => s.clan.tag === tag);
    if (!standing) return;
    const participants = standing.clan.participants || [];

    const weekLabel = raceWeekLabel(race);
    const correctionForWeek = weekLabel ? clanCorrections[weekLabel] : null;

    participants.forEach((p) => {
      if (!history[p.tag]) history[p.tag] = { name: p.name, scores: [], attacks: [], byWeek: [] };

      // If day-level data was supplied for this exact week, use D1+D2+D3
      // only (excluding Day 4) instead of the API's full-week total.
      const playerCorrection = correctionForWeek && correctionForWeek.players && correctionForWeek.players[p.tag];
      const effectiveScore = playerCorrection
        ? (playerCorrection.d1.fame + playerCorrection.d2.fame + playerCorrection.d3.fame)
        : p.fame;
      const effectiveAttacks = playerCorrection
        ? (playerCorrection.d1.attacks + playerCorrection.d2.attacks + playerCorrection.d3.attacks)
        : p.decksUsed;

      history[p.tag].scores.push(effectiveScore);
      history[p.tag].attacks.push(effectiveAttacks);
      history[p.tag].byWeek[weekIndex] = { score: effectiveScore, attacks: effectiveAttacks, day4Excluded: !!playerCorrection };
    });
  });

  const currentMemberTags = {};
  (clanInfo.memberList || []).forEach((m) => { currentMemberTags[m.tag] = m.name; });

  // Show everyone who's either a current member OR appeared in the last 2
  // weeks of war history — so people who've recently left still show up,
  // with inClan marking whether they're still actually in the clan today.
  const memberTagList = Array.from(new Set([
    ...Object.keys(currentMemberTags),
    ...Object.keys(history)
  ]));

  const rows = memberTagList.map((playerTag) => {
    const h = history[playerTag] || { scores: [], attacks: [], byWeek: [] };
    const totalScore = h.scores.reduce((a, b) => a + b, 0);   // 5kP — total of all scores overall
    const totalAttacks = h.attacks.reduce((a, b) => a + b, 0); // 5kG — total of all attacks used
    const cur = currentParticipants[playerTag];
    const isCurrentMember = currentMemberTags.hasOwnProperty(playerTag);

    // If there's no active war right now, show last week's completed data
    // in this slot instead of leaving it blank — so there's always something
    // real to look at rather than an empty column between wars.
    const thisWeekScore = cur ? cur.score : null;
    const thisWeekAttacks = cur ? cur.attacks : null;

    // Total 5k = total of all scores ÷ total number of attacks
    const total5k = totalAttacks ? Math.round((totalScore / totalAttacks) * 100) / 100 : null;

    // 5wa = this week's score ÷ this week's attacks (played)
    const fivewa = (thisWeekScore != null && thisWeekAttacks) ? Math.round((thisWeekScore / thisWeekAttacks) * 100) / 100 : null;

    // Elo = (this week's score ÷ this week's attacks) ÷ Total 5k  [same as 5wa ÷ Total 5k]
    const elo = (fivewa != null && total5k) ? Math.round((fivewa / total5k) * 100) / 100 : null;

    // 5kPPG = 5kP ÷ 5kG (same value as Total 5k, kept as its own named field to match your sheet naming)
    const fiveKPPG = total5k;

    // Last family clan they were in, if not currently here
    const lastFamilyClan = (!isCurrentMember && familyIndex)
      ? resolveLastFamilyClan(playerTag, familyIndex, tag)
      : null;

    // How many of the 5 possible weeks does this player actually have LOCAL
    // data for in this clan? (byWeek[0] = most recent; a recent joiner will
    // have data starting at index 0 and running out partway through.)
    const localWeeks = [0, 1, 2, 3, 4].map((i) => h.byWeek[i] || null);
    // Find their OLDEST week with real local data — a null at index 0 just
    // means they didn't attack the most recent week (not that they're new).
    // Only weeks OLDER than their earliest known local activity represent
    // "before they joined this clan" and are candidates for prior-clan fill.
    let oldestLocalIndex = -1;
    for (let i = 4; i >= 0; i--) {
      if (localWeeks[i]) { oldestLocalIndex = i; break; }
    }
    const needsFill = oldestLocalIndex < 4; // there's room for older weeks to be filled in

    const isNew = isCurrentMember && oldestLocalIndex === -1; // truly zero local history anywhere — drives the "New?" column
    const isRecentJoiner = isCurrentMember && needsFill; // still building up their first 5 weeks here

    // Prior clan history: pulled for anyone with room to fill older weeks —
    // either a recent/new joiner filling in the gap, or someone who's not
    // even a current member (found via family cross-referencing).
    // Recent/new joiners require the same trophy league; everyone else has
    // no league restriction.
    let priorClan = null;
    if (needsFill && familyIndex) {
      priorClan = resolvePriorClanHistory(playerTag, familyIndex, tag, clanInfo.clanWarTrophies, isRecentJoiner);
    }

    // Fill only the OLDER empty slots (beyond their earliest local week) with
    // the prior clan's weeks — never overwrite an interior null with prior
    // clan data, since that represents a real week they just didn't attack.
    const weeks = localWeeks.slice();
    if (priorClan && priorClan.priorWeeks) {
      for (let i = oldestLocalIndex + 1, j = 0; i < 5 && j < priorClan.priorWeeks.length; i++, j++) {
        weeks[i] = { score: priorClan.priorWeeks[j].score, attacks: priorClan.priorWeeks[j].attacks, fromPriorClan: true };
      }
    }
    // Any remaining interior null within their known tenure (0 to
    // oldestLocalIndex) means they just didn't attack that week — show it
    // as a real 0/0 rather than leaving it blank, since we know they were
    // a member then.
    if (isCurrentMember) {
      for (let i = 0; i <= oldestLocalIndex; i++) {
        if (!weeks[i]) weeks[i] = { score: 0, attacks: 0 };
      }
    }

    const row = {
      tag: playerTag,           // shown as a visible column so the right player can be confirmed
      name: currentMemberTags[playerTag] || h.name || (cur && cur.name) || '(unknown)',
      clanTag: tag,
      clanName: isCurrentMember ? clanInfo.name : lastFamilyClan, // current clan, or last known family clan if not here
      inClan: isCurrentMember ? 'Yes' : 'No',
      isNew,
      thisWeekScore,       // Score this week
      thisWeekAttacks,     // Cards played this week
      total5k,             // Total 5k
      elo,                 // Elo
      fivewa,              // 5wa
      fiveKP: totalScore,  // 5kP
      fiveKG: totalAttacks,// 5kG
      fiveKPPG,            // 5kPPG
      weeks                // full 5-week breakdown, blended with prior clan if needed
    };

    if (priorClan) {
      row.priorClanName = priorClan.priorClanName;
      row.priorAvgScore = priorClan.priorAvgScore;
      row.priorAvgAttacks = priorClan.priorAvgAttacks;
      row.priorWeeksTracked = priorClan.priorWeeksTracked;
      row.priorWeeks = priorClan.priorWeeks;
    }

    return row;
  });

  rows.sort((a, b) => {
    if (a.inClan !== b.inClan) return a.inClan === 'Yes' ? -1 : 1;
    return (b.total5k || 0) - (a.total5k || 0);
  });

  const weekLabels = races.map((race) => raceWeekLabel(race) || null);

  return { clanTag: tag, clanName: clanInfo.name, memberCount: Object.keys(currentMemberTags).length, rows, weekLabels };
}

module.exports = {
  FAMILY_TAGS,
  royaleApiGet,
  normalizeClanTag,
  looksLikeTag,
  getPlayerInfo,
  lookupOneClan,
  buildFamilyIndex,
  resolvePriorClanHistory
};
