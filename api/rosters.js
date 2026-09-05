// api/rosters.js
// Usage: /api/rosters?group=5k | 4k | bak3 | 35-40
//
// Powers the website's Rosters tab — the same 4 groupings as the Google
// Sheets tabs (5k Rosters, 4k Rosters, Bak3, 3.5/4.0). Live war stats (In
// Clan, Last Clan, Total 5k, Elo, 5wa, Score/Played, week history,
// 5kP/5kG/5kPPG) come from the Royale API via lookupOneClan — same as the
// Lookup tab. Player (Discord name), Rostered, and Colosseum stats have no
// Royale API source at all, so those come from the live sheet via
// lib/sheetRoster.js and are merged in here by Player Tag.

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
        // Sheet overlay is a nice-to-have on top of live API data — if the
        // sheet is unreachable (sharing changed, network hiccup, etc.) still
        // return the live stats rather than failing the whole request.
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
        coloScore: meta ? meta.coloScore : null,
        coloBattles: meta ? meta.coloBattles : null
      });
    });

    rows.sort((a, b) => {
      if (a.inClan !== b.inClan) return a.inClan === 'Yes' ? -1 : 1;
      return (b.total5k || 0) - (a.total5k || 0);
    });

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
