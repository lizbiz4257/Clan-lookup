// api/rosters.js
// Usage: /api/rosters?group=5k | 4k | bak3 | 35-40
//
// Powers the website's Rosters tab — the same 4 groupings as the Google
// Sheets tabs (5k Rosters, 4k Rosters, Bak3, 3.5/4.0).
//
// The sheet (lib/sheetRoster.js) is the SOURCE OF TRUTH here: it already
// bakes in day-corrections.json exclusions and any manual fixes made after
// the fact, which a fresh Royale API pull can't know about. So for any
// player the sheet has a row for, the sheet's In Clan, Last Clan, Total
// 5k/4k/3k, Elo, 5wa, and this-week Score/Played all WIN over the live
// Royale API numbers. The live API (lookupOneClan) only fills in: (a)
// fields the sheet has no source for at all (week-by-week history,
// 5kP/5kG/5kPPG), and (b) every field, as a fallback, for a player who
// isn't in the sheet yet at all (brand new, not rostered).

const { lookupOneClan, buildFamilyIndex } = require('../lib/clanData');
const { fetchRosterOverlay } = require('../lib/sheetRoster');

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
    const [familyIndex, overlay] = await Promise.all([
      buildFamilyIndex(),
      fetchRosterOverlay(groupKey).catch((err) => {
        // Sheet overlay is the source of truth here — but if the sheet is
        // unreachable (sharing changed, network hiccup, etc.) still return
        // the live API stats rather than failing the whole request.
        console.error('Roster overlay fetch failed for ' + groupKey + ':', err.message);
        return {};
      })
    ]);

    const clanResults = await Promise.all(
      group.tags.map((tag) => lookupOneClan(tag, familyIndex).catch((err) => ({ clanTag: tag, error: err.message })))
    );
    const clans = clanResults.filter((r) => !r.error);
    const failedClans = clanResults.filter((r) => r.error);

    const rows = clans.flatMap((c) => c.rows).map((r) => {
      const meta = overlay[r.tag];
      return Object.assign({}, r, {
        discordName: meta ? meta.player : null,
        rostered: meta ? meta.rostered : null,
        // The sheet's own "In Clan"/"Last Clan" text (e.g. "1 TKO", "2 B2.0",
        // "B2") — distinct from the live-computed `inClan`/`clanName` above,
        // which stay as a fallback for players the sheet doesn't have yet.
        sheetInClan: meta && meta.inClan != null ? meta.inClan : null,
        sheetLastClan: meta && meta.lastClan != null ? meta.lastClan : null,
        // Sheet wins for these whenever it has a value — see file header.
        total5k: meta && meta.total != null ? meta.total : r.total5k,
        elo: meta && meta.elo != null ? meta.elo : r.elo,
        fivewa: meta && meta.fivewa != null ? meta.fivewa : r.fivewa,
        thisWeekScore: meta && meta.score != null ? meta.score : r.thisWeekScore,
        thisWeekAttacks: meta && meta.played != null ? meta.played : r.thisWeekAttacks,
        coloScore: meta ? meta.coloScore : null,
        coloBattles: meta ? meta.coloBattles : null
      });
    });

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
