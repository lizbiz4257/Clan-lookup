// lib/clanData.js
// Shared helpers for talking to the Royale API. Used by both api/lookup.js
// (on-demand searches) and api/sync-to-sheet.js (scheduled sheet sync).

const API_BASE = 'https://proxy.royaleapi.dev/v1';

const FAMILY_TAGS = [
  '#YQJPR2V9', '#L0PQ2ULQ', '#YRVC9QVJ', '#G9LRRP82',
  '#GURCRRY9', '#QJU8P80C', '#GY0QQGYY',
  '#QVY92JLV', '#GQ20UQR8'
];

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
      (standing.clan.participants || []).forEach((p) => {
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
// clan they just joined. Returns null if no qualifying clan is found.
function resolvePriorClanHistory(playerTag, familyIndex, excludeTag, currentClanWarTrophies) {
  const currentLeague = Math.floor((currentClanWarTrophies || 0) / 1000);

  let best = null;
  familyIndex.forEach((c) => {
    if (c.tag === excludeTag) return;
    const priorLeague = Math.floor((c.warTrophies || 0) / 1000);
    if (priorLeague !== currentLeague) return; // different league — skip
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

  // Detect L2W weeks (a deliberate strategy where the clan throws battles —
  // recognizable as 15+ players showing exactly 400 fame that week). Scoped
  // to Team Knockouts and !Baked! 2.0 only. On an L2W week, the SCORE is
  // excluded from Total 5k / Elo / 5wa / 5kP / 5kPPG (so it doesn't drag down
  // performance stats) — but ATTACKS still count normally (still shows as 16
  // if they used all their attacks), and both are still shown in the raw
  // weekly breakdown either way.
  const L2W_ELIGIBLE_TAGS = ['#YRVC9QVJ', '#YQJPR2V9']; // !Baked! 2.0, Team Knockouts
  const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
  const races = (log.items || []).slice(0, 5);

  const history = {};

  races.forEach((race, weekIndex) => {
    const standing = (race.standings || []).find((s) => s.clan.tag === tag);
    if (!standing) return;
    const participants = standing.clan.participants || [];
    const isL2WWeek = L2W_ELIGIBLE_TAGS.includes(tag) && participants.filter((p) => p.fame === 400).length >= 15;

    // If the war finished early (e.g. 3 days instead of 4), nobody could
    // have gotten more than 12 attacks that week. On a normal (non-L2W)
    // early finish, the highest attack count anyone actually hit tells us
    // the real ceiling. But on an L2W week, even the top attacker may have
    // pulled back on the final day as part of the strategy — so inferring
    // the ceiling from the data would be unreliable. For L2W weeks, the
    // ceiling is fixed at 12 (a known 3-day pattern for these clans) rather
    // than guessed from whoever attacked the most.
    const observedMax = participants.length ? Math.max(...participants.map((p) => p.decksUsed)) : 16;
    const weekMaxAttacks = isL2WWeek ? 12 : observedMax;
    const wasEarlyFinish = weekMaxAttacks > 0 && weekMaxAttacks < 16;
    const phantomAttacks = wasEarlyFinish ? (16 - weekMaxAttacks) : 0;

    participants.forEach((p) => {
      if (!history[p.tag]) history[p.tag] = { name: p.name, scores: [], attacks: [], byWeek: [] };
      const normalizedAttacks = p.decksUsed + phantomAttacks;
      if (!isL2WWeek) {
        history[p.tag].scores.push(p.fame);
      }
      history[p.tag].attacks.push(normalizedAttacks); // attacks always counted, even on L2W weeks
      history[p.tag].byWeek[weekIndex] = { score: p.fame, attacks: normalizedAttacks, isL2W: isL2WWeek };
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

    // New joiner = currently a member here, but no history in THIS clan yet
    // (i.e. this is their first tracked week here). If they have history in
    // another family clan, pull their prior 5-week performance from there.
    const isNew = isCurrentMember && h.scores.length === 0;
    let priorClan = null;
    if (isNew && familyIndex) {
      priorClan = resolvePriorClanHistory(playerTag, familyIndex, tag, clanInfo.clanWarTrophies);
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
      weeks: [0, 1, 2, 3, 4].map((i) => h.byWeek[i] || null) // full 5-week breakdown, most recent first
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

  return { clanTag: tag, clanName: clanInfo.name, memberCount: Object.keys(currentMemberTags).length, rows };
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
