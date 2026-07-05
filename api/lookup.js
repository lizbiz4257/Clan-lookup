// api/lookup.js
// Usage:
//   /api/lookup?tag=XXXXXXXX                  -> single clan
//   /api/lookup?tags=TAG1,TAG2,...            -> multiple clans combined
//   /api/lookup?player=NAME_OR_TAG            -> single player war stats
//   /api/lookup?player=NAME&tags=TAG_OR_NAME  -> find that player, but only
//                                                 within the given clan(s)

const {
  FAMILY_TAGS,
  normalizeClanTag,
  looksLikeTag,
  getPlayerInfo,
  lookupOneClan,
  buildFamilyIndex,
  royaleApiGet
} = require('../lib/clanData');

// Resolves a clan query (comma-separated tags, OR a clan name like "Baked")
// into an array of actual clan tags. Returns [] if a name search matched nothing.
async function resolveClanTags(clanQuery) {
  const rawInputs = String(clanQuery).split(',').map((s) => s.trim()).filter(Boolean);
  const allLookLikeTags = rawInputs.every(looksLikeTag);

  if (allLookLikeTags) {
    return rawInputs.map(normalizeClanTag);
  }

  // Treat as a clan NAME search — only searchable within your family clans
  // (the API has no global clan-name search).
  const needle = rawInputs.join(' ').toLowerCase();
  const nameChecks = await Promise.all(
    FAMILY_TAGS.map((tag) =>
      royaleApiGet('/clans/' + encodeURIComponent(tag))
        .then((info) => ({ tag, name: info.name }))
        .catch(() => null)
    )
  );
  return nameChecks
    .filter((c) => c && c.name.toLowerCase().includes(needle))
    .map((c) => c.tag);
}

module.exports = async function handler(req, res) {
  const playerQuery = req.query.player;
  const clanQuery = req.query.tags || req.query.tag;

  try {
    // Built once per request, reused everywhere below — this is what powers
    // "last known family clan" without a per-player live lookup.
    const familyIndex = await buildFamilyIndex();

    // ---- PLAYER SEARCH (by tag or name) ----
    if (playerQuery) {
      const raw = String(playerQuery).trim();

      if (looksLikeTag(raw)) {
        const tag = normalizeClanTag(raw);
        let playerInfo;
        try {
          playerInfo = await getPlayerInfo(tag);
        } catch (err) {
          res.status(200).json({ clans: [], failedClans: [], totalMembers: 0, rows: [], notFound: true });
          return;
        }

        if (!playerInfo.clan || !playerInfo.clan.tag) {
          res.status(200).json({
            clans: [],
            failedClans: [],
            totalMembers: 1,
            rows: [{
              tag: playerInfo.tag,
              name: playerInfo.name,
              clanTag: null,
              clanName: null,
              inClan: 'No',
              lastFamilyClan: null,
              thisWeekScore: null,
              thisWeekAttacks: null,
              total5k: null,
              elo: null,
              fivewa: null,
              fiveKP: null,
              fiveKG: null,
              fiveKPPG: null
            }]
          });
          return;
        }

        const clanResult = await lookupOneClan(playerInfo.clan.tag, familyIndex);
        const row = clanResult.rows.find((r) => r.tag === playerInfo.tag);

        res.status(200).json({
          clans: [{ clanTag: clanResult.clanTag, clanName: clanResult.clanName, memberCount: clanResult.memberCount }],
          failedClans: [],
          totalMembers: row ? 1 : 0,
          rows: row ? [row] : []
        });
        return;
      }

      // Name search — scoped to specific clan(s) if the clan box was also
      // filled in, otherwise across all 9 family clans.
      let searchTags = FAMILY_TAGS;
      if (clanQuery) {
        searchTags = await resolveClanTags(clanQuery);
        if (searchTags.length === 0) {
          res.status(200).json({ clans: [], failedClans: [], totalMembers: 0, rows: [], noClanNameMatch: true });
          return;
        }
      }

      const results = await Promise.all(
        searchTags.map((tag) => lookupOneClan(tag, familyIndex).catch((err) => ({ clanTag: tag, error: err.message })))
      );
      const clans = results.filter((r) => !r.error);
      const failedClans = results.filter((r) => r.error);
      const needle = raw.toLowerCase();
      const allMatches = clans.flatMap((c) => c.rows).filter((r) => r.name.toLowerCase().includes(needle));

      // A player can show up once per clan they have ANY trace in (current
      // membership or recent history) — collapse to one row per player,
      // preferring whichever row shows them as a current member.
      const byTag = {};
      allMatches.forEach((r) => {
        const existing = byTag[r.tag];
        if (!existing || (r.inClan === 'Yes' && existing.inClan !== 'Yes')) {
          byTag[r.tag] = r;
        }
      });
      const rows = Object.values(byTag);

      res.status(200).json({
        clans: clans.map((c) => ({ clanTag: c.clanTag, clanName: c.clanName, memberCount: c.memberCount })),
        failedClans,
        totalMembers: rows.length,
        rows,
        nameSearch: true
      });
      return;
    }

    // ---- CLAN SEARCH (by tag(s), or by clan name) ----
    if (!clanQuery) {
      res.status(400).json({ error: 'Missing clan tag(s) or player search.' });
      return;
    }

    const tags = await resolveClanTags(clanQuery);
    if (tags.length === 0) {
      res.status(200).json({ clans: [], failedClans: [], totalMembers: 0, rows: [], noClanNameMatch: true });
      return;
    }

    const results = await Promise.all(
      tags.map((tag) => lookupOneClan(tag, familyIndex).catch((err) => ({ clanTag: tag, error: err.message })))
    );

    const clans = results.filter((r) => !r.error);
    const failedClans = results.filter((r) => r.error);
    const rows = clans.flatMap((c) => c.rows);
    rows.sort((a, b) => (b.total5k || 0) - (a.total5k || 0));

    res.status(200).json({
      clans: clans.map((c) => ({ clanTag: c.clanTag, clanName: c.clanName, memberCount: c.memberCount })),
      failedClans,
      totalMembers: rows.length,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
