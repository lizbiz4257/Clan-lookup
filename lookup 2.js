// api/lookup.js
// Serverless function (runs on Vercel). Keeps the Royale API token on the
// server side — the browser never sees it. Set ROYALE_API_TOKEN as an
// Environment Variable in your Vercel project settings (not in this file).

const API_BASE = 'https://proxy.royaleapi.dev/v1';

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

module.exports = async function handler(req, res) {
  const tag = normalizeClanTag(req.query.tag);
  if (!tag) {
    res.status(400).json({ error: 'Missing or invalid clan tag.' });
    return;
  }

  try {
    const encTag = encodeURIComponent(tag);
    const clanInfo = await royaleApiGet('/clans/' + encTag);

    let currentParticipants = {};
    let thisWeekAvailable = false;
    try {
      const currentRace = await royaleApiGet('/clans/' + encTag + '/currentriverrace');
      thisWeekAvailable = true;
      (currentRace.clan.participants || []).forEach((p) => {
        currentParticipants[p.tag] = { name: p.name, attacks: p.decksUsed, score: p.fame };
      });
    } catch (err) {
      // no race currently running — fine, just skip "this week" columns
    }

    const log = await royaleApiGet('/clans/' + encTag + '/riverracelog?limit=5');
    const races = (log.items || []).slice(0, 5);
    const history = {};

    races.forEach((race) => {
      const standing = (race.standings || []).find((s) => s.clan.tag === tag);
      if (!standing) return;
      (standing.clan.participants || []).forEach((p) => {
        if (!history[p.tag]) history[p.tag] = { name: p.name, scores: [], attacks: [] };
        history[p.tag].scores.push(p.fame);
        history[p.tag].attacks.push(p.decksUsed);
      });
    });

    const currentMemberTags = {};
    (clanInfo.memberList || []).forEach((m) => { currentMemberTags[m.tag] = m.name; });

    const allTags = new Set([...Object.keys(currentMemberTags), ...Object.keys(history)]);

    const rows = [];
    allTags.forEach((playerTag) => {
      const h = history[playerTag] || { scores: [], attacks: [] };
      const racesCounted = h.scores.length;
      const totalScore = h.scores.reduce((a, b) => a + b, 0);
      const totalAttacks = h.attacks.reduce((a, b) => a + b, 0);
      const cur = currentParticipants[playerTag];

      rows.push({
        tag: playerTag,
        name: currentMemberTags[playerTag] || h.name || (cur && cur.name) || '(unknown)',
        inClan: currentMemberTags.hasOwnProperty(playerTag) ? 'Yes' : 'No',
        thisWeekAttacks: cur ? cur.attacks : null,
        thisWeekScore: cur ? cur.score : null,
        fiveWeekAvgAttacks: racesCounted ? Math.round((totalAttacks / racesCounted) * 100) / 100 : null,
        fiveWeekAvgScore: racesCounted ? Math.round((totalScore / racesCounted) * 100) / 100 : null,
        racesCounted
      });
    });

    rows.sort((a, b) => {
      if (a.inClan !== b.inClan) return a.inClan === 'Yes' ? -1 : 1;
      return (b.fiveWeekAvgScore || 0) - (a.fiveWeekAvgScore || 0);
    });

    res.status(200).json({
      clanTag: tag,
      clanName: clanInfo.name,
      memberCount: (clanInfo.memberList || []).length,
      thisWeekAvailable,
      rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
