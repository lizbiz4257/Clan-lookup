// lib/clanData.js
// Shared helpers for talking to the Royale API. Used by both api/lookup.js
// (on-demand searches) and api/sync-to-sheet.js (scheduled sheet sync).

const API_BASE = 'https://proxy.royaleapi.dev/v1';

const FAMILY_TAGS = [
  '#YQJPR2V9', '#L0PQ2ULQ', '#YRVC9QVJ', '#G9LRRP82',
  '#GURCRRY9', '#QJU8P80C', '#GY0QQGYY',
  '#QVY92JLV', '#GQ20UQR8'
];

async function royaleApiGet(endpoint) {
  const resp = await fetch(API_BASE + endpoint, {
    headers: { Authorization: 'Bearer ' + process.env.ROYALE_API_TOKEN }
  });
  if (!resp.ok) {
    throw new Error('Royale API error ' + resp.status + ' for ' + endpoint + ': ' + (await resp.text()));
  }
  return resp.json();
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

// Fetches and computes rows for ONE clan. Returns { clanTag, clanName, memberCount, rows }.
async function lookupOneClan(tag) {
  const encTag = encodeURIComponent(tag);
  const clanInfo = await royaleApiGet('/clans/' + encTag);

  let currentParticipants = {};
  try {
    const currentRace = await royaleApiGet('/clans/' + encTag + '/currentriverrace');
    (currentRace.clan.participants || []).forEach((p) => {
      currentParticipants[p.tag] = { name: p.name, attacks: p.decksUsed, score: p.fame };
    });
  } catch (err) {
    // no race currently running
  }

  // !Baked! 2.0 occasionally has a race entry where 15+ players show an
  // identical placeholder score of 400 — treat that as bad data and skip
  // back further in the log for a real entry instead. Scoped to this one
  // clan only; every other clan keeps the original "most recent 5" behavior.
  const BAKED_2_TAG = '#YRVC9QVJ';
  let races;
  if (tag === BAKED_2_TAG) {
    const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=15');
    const allRaces = log.items || [];
    const goodRaces = allRaces.filter((race) => {
      const standing = (race.standings || []).find((s) => s.clan.tag === tag);
      if (!standing) return true; // nothing to check, don't discard
      const participants = standing.clan.participants || [];
      const suspiciousCount = participants.filter((p) => p.fame === 400).length;
      return suspiciousCount <= 15;
    });
    races = goodRaces.slice(0, 5);
  } else {
    const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
    races = (log.items || []).slice(0, 5);
  }

  const history = {};

  races.forEach((race, weekIndex) => {
    const standing = (race.standings || []).find((s) => s.clan.tag === tag);
    if (!standing) return;
    (standing.clan.participants || []).forEach((p) => {
      if (!history[p.tag]) history[p.tag] = { name: p.name, scores: [], attacks: [], byWeek: [] };
      history[p.tag].scores.push(p.fame);
      history[p.tag].attacks.push(p.decksUsed);
      history[p.tag].byWeek[weekIndex] = { score: p.fame, attacks: p.decksUsed };
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

    return {
      tag: playerTag,
      name: currentMemberTags[playerTag] || h.name || (cur && cur.name) || '(unknown)',
      clanTag: tag,
      clanName: currentMemberTags.hasOwnProperty(playerTag) ? clanInfo.name : null, // clan name only if currently in it
      inClan: currentMemberTags.hasOwnProperty(playerTag) ? 'Yes' : 'No',
      thisWeekScore,       // Score this week
      thisWeekAttacks,     // Cards played this week
      total5k,             // Total 5k
      elo,                 // Elo
      fivewa,              // 5wa
      fiveKP: totalScore,  // 5kP
      fiveKG: totalAttacks,// 5kG
      fiveKPPG             // 5kPPG
    };
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
  lookupOneClan
};
