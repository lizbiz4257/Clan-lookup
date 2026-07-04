<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clan Lookup</title>
  <style>
    :root {
      --accent: #2563eb;
      --accent-dark: #1d4ed8;
      --bg: #f7f8fa;
      --card: #ffffff;
      --border: #e3e6eb;
      --text: #1a1d23;
      --muted: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px 16px 60px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 14px;
    }
    input {
      width: 100%; padding: 12px; border: 1px solid var(--border);
      border-radius: 8px; font-size: 15px; margin-bottom: 10px;
    }
    button {
      width: 100%;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:active { background: var(--accent-dark); }
    button:disabled { background: #b9c2d0; cursor: not-allowed; }
    #status { font-size: 13px; margin-top: 8px; min-height: 16px; }
    #status.ok { color: #15803d; }
    #status.err { color: #b91c1c; }
    #status.busy { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; padding: 6px 4px; color: var(--muted); }
    td { padding: 6px 4px; border-top: 1px solid var(--border); }
    .spinner {
      display: inline-block; width: 12px; height: 12px;
      border: 2px solid #cbd5e1; border-top-color: var(--accent);
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: -2px; margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Clan Lookup</h1>
    <p class="sub">Enter any clan tag to see this week's attacks/score, 5-week averages, and who's currently in clan.</p>

    <div class="card">
      <input id="clanTagInput" type="text" placeholder="#XXXXXXX">
      <button onclick="lookupClan()">Look up clan</button>
      <div id="status"></div>
    </div>

    <div id="results"></div>
  </div>

  <script>
    async function lookupClan() {
      const tag = document.getElementById('clanTagInput').value.trim();
      const statusEl = document.getElementById('status');
      const resultsEl = document.getElementById('results');
      resultsEl.innerHTML = '';
      statusEl.className = 'busy';
      statusEl.innerHTML = '<span class="spinner"></span>Looking up…';

      try {
        const resp = await fetch('/api/lookup?tag=' + encodeURIComponent(tag));
        const data = await resp.json();

        if (!resp.ok || data.error) {
          statusEl.className = 'err';
          statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
          return;
        }

        statusEl.className = 'ok';
        statusEl.textContent = data.clanName + ' — ' + data.memberCount + ' members' +
          (data.thisWeekAvailable ? '' : ' (no war currently running — showing 5-week history only)');
        renderTable(data);
      } catch (err) {
        statusEl.className = 'err';
        statusEl.textContent = 'Error: ' + err.message;
      }
    }

    function renderTable(data) {
      const resultsEl = document.getElementById('results');
      let html = '<div class="card"><div style="overflow-x:auto;"><table>';
      html += '<tr><th>Name</th>' +
        '<th>Live Atk</th><th>Live Score</th>' +
        '<th>Wk1 Atk</th><th>Wk1 Score</th>' +
        '<th>Wk2 Atk</th><th>Wk2 Score</th>' +
        '<th>Wk3 Atk</th><th>Wk3 Score</th>' +
        '<th>Wk4 Atk</th><th>Wk4 Score</th>' +
        '<th>5wk Avg Atk</th><th>5wk Avg Score</th></tr>';
      data.rows.forEach((r) => {
        const w = r.weeks || [];
        html += '<tr>' +
          '<td>' + r.name + '</td>' +
          '<td>' + (r.thisWeekAttacks == null ? '–' : r.thisWeekAttacks) + '</td>' +
          '<td>' + (r.thisWeekScore == null ? '–' : r.thisWeekScore) + '</td>';
        for (let i = 0; i < 4; i++) {
          const wk = w[i];
          html += '<td>' + (wk ? wk.attacks : '–') + '</td>' +
                  '<td>' + (wk ? wk.score : '–') + '</td>';
        }
        html += '<td>' + (r.fiveWeekAvgAttacks == null ? '–' : r.fiveWeekAvgAttacks) + '</td>' +
          '<td>' + (r.fiveWeekAvgScore == null ? '–' : r.fiveWeekAvgScore) + '</td>' +
          '</tr>';
      });
      html += '</table></div></div>';
      resultsEl.innerHTML = html;
    }

    document.getElementById('clanTagInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') lookupClan();
    });
  </script>
</body>
</html>
