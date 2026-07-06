// api/export-csv.js
// Same data as /api/lookup, but returned as plain CSV text instead of JSON —
// built specifically so a Google Sheet can pull it live with a formula like:
//   =IMPORTDATA("https://your-site.vercel.app/api/export-csv?tags=TAG")
// No Google login, no service account, no setup on the Sheets side at all.
// Just paste that formula into any cell and it refreshes automatically
// whenever the Sheet recalculates.
//
// Usage (same query params as /api/lookup):
//   /api/export-csv?tag=XXXXXXXX
//   /api/export-csv?tags=TAG1,TAG2,...
//   /api/export-csv?player=NAME_OR_TAG

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(rows) {
  const headers = [
    'Name', 'Tag', 'Clan', 'In Clan', 'New?', 'Score This Week', 'Cards Played',
    'Week 1 Score', 'Week 1 Attacks', 'Week 2 Score', 'Week 2 Attacks',
    'Week 3 Score', 'Week 3 Attacks', 'Week 4 Score', 'Week 4 Attacks',
    'Week 5 Score', 'Week 5 Attacks',
    'Total 5k', 'Elo', '5wa', '5kP', '5kG', '5kPPG',
    'Prior Clan', 'Prior Avg Score', 'Prior Avg Attacks'
  ];

  const lines = [headers.join(',')];

  rows.forEach((r) => {
    const w = r.weeks || [];
    const fields = [
      r.name, r.tag, r.clanName || '', r.inClan, r.isNew ? 'Yes' : '', r.thisWeekScore, r.thisWeekAttacks
    ];
    for (let i = 0; i < 5; i++) {
      fields.push(w[i] ? w[i].score : '', w[i] ? w[i].attacks : '');
    }
    fields.push(r.total5k, r.elo, r.fivewa, r.fiveKP, r.fiveKG, r.fiveKPPG, r.priorClanName || '', r.priorAvgScore, r.priorAvgAttacks);
    lines.push(fields.map(csvEscape).join(','));
  });

  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  try {
    // Reuses the exact same logic as /api/lookup by calling it internally,
    // so both endpoints always return identical data — just different formats.
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const queryString = req.url.split('?')[1] || '';
    const lookupUrl = protocol + '://' + host + '/api/lookup?' + queryString;

    const resp = await fetch(lookupUrl);
    const data = await resp.json();

    if (!resp.ok || data.error) {
      res.status(resp.status).send('Error: ' + (data.error || 'Unknown error'));
      return;
    }

    const csv = rowsToCsv(data.rows || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
}
