// api/rosters.js
// Usage: /api/rosters?group=5k | 4k | bak3 | 35-40
//
// Powers the website's Rosters tab — the same 4 groupings as the Google
// Sheets tabs (5k Rosters, 4k Rosters, Bak3, 3.5/4.0).
//
// The sheet (lib/sheetRoster.js) is the SOURCE OF TRUTH and drives the row
// list itself: EVERY row on the sheet — main accounts and alts alike —
// becomes a row here, not just whoever the Royale API currently reports as
// a live member of the two tracked clans. That's because a benched/parked
// alt, or someone between clans, can sit on the sheet without currently
// being a live member of either tracked clan — the old live-API-driven
// approach silently dropped those. For any player the sheet has a row for,
// the sheet's In Clan, Last Clan, Total 5k/4k/3k, Elo, 5wa, and this-week
// Score/Played all WIN over the live Royale API numbers (the sheet already
// bakes in day-corrections.json exclusions and manual fixes a fresh API
// pull can't know about). The live API (lookupOneClan) only fills in
// week-by-week history and 5kP/5kG/5kPPG (things the sheet has no separate
// source for), matched onto sheet rows by Player Tag — and, separately, any
// live clan member who isn't on the sheet at all yet (brand new, not added)
// still shows up using live data alone.

const { lookupOneClan, buildFamilyIndex } = require('../lib/clanData');
const { fetchRosterSheet } = require('../lib/sheetRoster');

const GROUPS = {
  '5k':    { label: '5k Rosters', tags: ['#YQJPR2V9', '#YRVC9QVJ'] }, // TKO + !Baked! 2.0
  '4k':    { label: '4k Rosters', tags: ['#GURCRRY9', '#LUCQVPRV'] }, // !Baked! 1.0 + !Baked! 1.5
  bak3:    { label: 'Bak3',       tags: ['#QJU8P80C'] },              // !Baked! 3.0
  '35-40': { label: '3.5/4.0',    tags: ['#QVY92JLV', '#GQ20UQR8'] }  // Baked 3.5 + Baked 4.0
};

module.exports = async function handler(req, res) {
  const groupKey = req.query.group;
  const group = GROUPS[groupKey];
  if (!group) {
    res.status(400).json({ error: 'Unknown or missing group. Use one of: ' + Object.keys(GROUPS).join(', ') });
    return;
  }

  try {
    const [familyIndex, sheetRows] = await Promise.all([
      buildFamilyIndex(),
      fetchRosterSheet(groupKey).catch((err) => {
        // The sheet is the row source here — but if it's unreachable
        // (sharing changed, network hiccup, etc.) fall back to an empty
        // list so live API data still renders instead of a hard failure.
        console.error('Roster sheet fetch failed for ' + groupKey + ':', err.message);
        return [];
      })
    ]);

    const clanResults = await Promise.all(
      group.tags.map((tag) => lookupOneClan(tag, familyIndex).catch((err) => ({ clanTag: tag, error: err.message })))
    );
    const clans = clanResults.filter((r) => !r.error);
    const failedClans = clanResults.filter((r) => r.error);

    const liveByTag = {};
    clans.forEach((c) => c.rows.forEach((r) => { liveByTag[r.tag] = r; }));

    const rows = [];
    const seenTags = new Set();

    sheetRows.forEach((sr) => {
      seenTags.add(sr.tag);
      const live = liveByTag[sr.tag];
      rows.push({
        tag: sr.tag,
        name: live ? live.name : (sr.account || sr.player || sr.tag),
        clanTag: live ? live.clanTag : null,
        clanName: live ? live.clanName : null,
        inClan: live ? live.inClan : null,
        isNew: live ? live.isNew : false,
        // Sheet wins whenever it has a value — see file header.
        thisWeekScore: sr.score != null ? sr.score : (live ? live.thisWeekScore : null),
        thisWeekAttacks: sr.played != null ? sr.played : (live ? live.thisWeekAttacks : null),
        total5k: sr.total != null ? sr.total : (live ? live.total5k : null),
        elo: sr.elo != null ? sr.elo : (live ? live.elo : null),
        fivewa: sr.fivewa != null ? sr.fivewa : (live ? live.fivewa : null),
        // No sheet source for these — live API only.
        fiveKP: live ? live.fiveKP : null,
        fiveKG: live ? live.fiveKG : null,
        fiveKPPG: live ? live.fiveKPPG : null,
        weeks: live ? live.weeks : [],
        discordName: sr.player,
        alt: sr.alt,
        rostered: sr.rostered,
        sheetInClan: sr.inClan,
        sheetLastClan: sr.lastClan,
        coloScore: sr.coloScore,
        coloBattles: sr.coloBattles
      });
    });

    // Live clan members not on the sheet at all yet (brand new, not added) —
    // still show up, just with no sheet-only fields.
    clans.forEach((c) => c.rows.forEach((live) => {
      if (seenTags.has(live.tag)) return;
      seenTags.add(live.tag);
      rows.push(Object.assign({}, live, {
        discordName: null,
        alt: null,
        rostered: null,
        sheetInClan: null,
        sheetLastClan: null,
        coloScore: null,
        coloBattles: null
      }));
    }));

    rows.sort((a, b) => (b.total5k || 0) - (a.total5k || 0));

    res.status(200).json({
      group: groupKey,
      label: group.label,
      clans: clans.map((c) => ({ clanTag: c.clanTag, clanName: c.clanName, memberCount: c.memberCount, weekLabels: c.weekLabels })),
      failedClans,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
