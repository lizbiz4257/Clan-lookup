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
// If includeCards is true, also fetches a card-level summary per member (slower — one
// extra API call per player).
async function lookupOneClan(tag, includeCards) {
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

  const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
  const races = (log.items || []).slice(0, 5);
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

  const memberTagList = Object.keys(currentMemberTags);

  // Fetch card summaries for every member in parallel, only if requested.
  let cardSummaries = {};
  if (includeCards) {
    const summaries = await Promise.all(memberTagList.map((t) => getCardSummary(t)));
    memberTagList.forEach((t, i) => { cardSummaries[t] = summaries[i]; });
  }

  const rows = memberTagList.map((playerTag) => {
    const h = history[playerTag] || { scores: [], attacks: [], byWeek: [] };
    const racesCounted = h.scores.length;
    const totalScore = h.scores.reduce((a, b) => a + b, 0);
    const totalAttacks = h.attacks.reduce((a, b) => a + b, 0);
    const cur = currentParticipants[playerTag];
    const weeks = [0, 1, 2, 3].map((i) => h.byWeek[i] || null);

    const row = {
      tag: playerTag,
      name: currentMemberTags[playerTag] || h.name || (cur && cur.name) || '(unknown)',
      clanTag: tag,
      clanName: clanInfo.name,
      thisWeekAttacks: cur ? cur.attacks : null,
      thisWeekScore: cur ? cur.score : null,
      weeks,
      fiveWeekAvgAttacks: racesCounted ? Math.round((totalAttacks / racesCounted) * 100) / 100 : null,
      fiveWeekAvgScore: racesCounted ? Math.round((totalScore / racesCounted) * 100) / 100 : null,
      racesCounted
    };

    if (includeCards) {
      const summary = cardSummaries[playerTag] || {};
      row.avgCardLevel = summary.avgLevel;
      row.maxedCards = summary.maxedCount;
      row.cardCount = summary.cardCount;
    }

    return row;
  });

  return { clanTag: tag, clanName: clanInfo.name, memberCount: rows.length, rows };
}

// Simplified card collection for a player: name, level, maxLevel.
function extractCardCollection(playerInfo) {
  return (playerInfo.cards || []).map((c) => ({
    name: c.name,
    level: c.level,
    maxLevel: c.maxLevel,
    starLevel: c.starLevel || null
  }));
}

// Lightweight summary (avg level, maxed count) rather than the full card list —
// used when showing card info for an entire clan/family at once.
async function getCardSummary(playerTag) {
  try {
    const info = await getPlayerInfo(playerTag);
    const cards = info.cards || [];
    if (cards.length === 0) return { avgLevel: null, maxedCount: 0, cardCount: 0 };
    const avgLevel = cards.reduce((sum, c) => sum + c.level, 0) / cards.length;
    const maxedCount = cards.filter((c) => c.maxLevel && c.level >= c.maxLevel).length;
    return {
      avgLevel: Math.round(avgLevel * 100) / 100,
      maxedCount,
      cardCount: cards.length
    };
  } catch (err) {
    return { avgLevel: null, maxedCount: null, cardCount: null };
  }
}

module.exports = {
  FAMILY_TAGS,
  royaleApiGet,
  normalizeClanTag,
  looksLikeTag,
  getPlayerInfo,
  lookupOneClan,
  extractCardCollection,
  getCardSummary
};
