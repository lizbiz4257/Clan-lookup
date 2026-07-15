// api/debug-corrections.js
// Temporary diagnostic endpoint — directly tests fetching data/day-corrections.json
// via the GitHub API and reports exactly what happened (success, error, auth
// problem, etc.) instead of silently returning empty like the main site does.
// Safe to leave in permanently; it doesn't touch or expose anything sensitive
// beyond confirming whether the fetch itself is working.

module.exports = async function handler(req, res) {
  const report = { hasGithubRepo: !!process.env.GITHUB_REPO, hasGithubToken: !!process.env.GITHUB_TOKEN };

  try {
    const resp = await fetch(
      'https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/data/day-corrections.json',
      { headers: { Authorization: 'token ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json' } }
    );

    report.httpStatus = resp.status;
    report.ok = resp.ok;

    if (!resp.ok) {
      report.errorBody = await resp.text();
      res.status(200).json(report);
      return;
    }

    const json = await resp.json();
    const decoded = Buffer.from(json.content, 'base64').toString('utf-8');
    const data = JSON.parse(decoded);

    report.topLevelKeys = Object.keys(data);
    report.tkoWeeks = data['#YQJPR2V9'] ? Object.keys(data['#YQJPR2V9']) : 'MISSING';
    report.baked2Weeks = data['#YRVC9QVJ'] ? Object.keys(data['#YRVC9QVJ']) : 'MISSING';

    res.status(200).json(report);
  } catch (err) {
    report.exception = err.message;
    res.status(200).json(report);
  }
}
