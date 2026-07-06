// api/daily-snapshot.js
// Runs automatically once a day (see vercel.json). Captures each Baked 2.0
// player's cumulative war fame, diffs it against yesterday's stored total to
// get "today's" contribution, and flags days where 15+ players show exactly
// 400 (the known sync-glitch value) so bad days don't pollute the record.
//
// Storage: a single JSON file committed directly into this same GitHub repo
// (data/baked2-daily.json) — no separate database or account needed.
//
// SETUP REQUIRED:
//   1. On GitHub, go to Settings (your account, not the repo) -> Developer
//      settings -> Personal access tokens -> Tokens (classic) -> Generate new token
//   2. Give it the "repo" scope (full control of private/public repos)
//   3. Copy the token (starts with ghp_...) — you only see it once
//   4. In Vercel -> Settings -> Environment Variables, add:
//        GITHUB_TOKEN   = the token you just copied
//        GITHUB_REPO    = yourusername/clan-lookup   (your actual repo path)

const { royaleApiGet } = require('../lib/clanData');

const BAKED_2_TAG = '#YRVC9QVJ';
const FILE_PATH = 'data/baked2-daily.json';

async function githubGetFile() {
  const resp = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + FILE_PATH, {
    headers: {
      Authorization: 'token ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json'
    }
  });

  if (resp.status === 404) {
    return { data: { baseline: {}, log: {} }, sha: null };
  }
  if (!resp.ok) {
    throw new Error('GitHub read error ' + resp.status + ': ' + (await resp.text()));
  }

  const json = await resp.json();
  const decoded = Buffer.from(json.content, 'base64').toString('utf-8');
  return { data: JSON.parse(decoded), sha: json.sha };
}

async function githubPutFile(data, sha) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = {
    message: 'Update Baked 2.0 daily snapshot — ' + new Date().toISOString().slice(0, 10),
    content
  };
  if (sha) body.sha = sha;

  const resp = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + FILE_PATH, {
    method: 'PUT',
    headers: {
      Authorization: 'token ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    throw new Error('GitHub write error ' + resp.status + ': ' + (await resp.text()));
  }
}

module.exports = async function handler(req, res) {
  // Simple protection so randoms on the internet can't trigger this repeatedly
  const providedSecret = req.headers['authorization'] || req.query.secret;
  if (process.env.CRON_SECRET && providedSecret !== 'Bearer ' + process.env.CRON_SECRET && providedSecret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Two cron triggers fire each day (covering both possible UTC offsets for
  // 5:30pm Eastern, since DST shifts it) — only actually run the capture on
  // whichever one lands at the real local time, computed via the proper
  // Eastern timezone (handles DST automatically, no manual adjustment needed).
  const easternNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const [easternHour, easternMinute] = easternNow.split(':').map(Number);
  const isTargetTime = easternHour === 17 && easternMinute >= 25 && easternMinute <= 35;

  if (!isTargetTime && !req.query.force) {
    res.status(200).json({ message: 'Skipped — not the target local time (currently ' + easternNow + ' Eastern).' });
    return;
  }

  try {
    const currentRace = await royaleApiGet('/clans/' + encodeURIComponent(BAKED_2_TAG) + '/currentriverrace');
    const participants = currentRace.clan.participants || [];

    const { data, sha } = await githubGetFile();
    let baseline = data.baseline || {};
    const today = new Date().toISOString().slice(0, 10);

    // Detect a new war week: fame resets to 0 in the game at the start of
    // each week, so if most players' current fame is LESS than their stored
    // baseline, that's a fresh week — reset the baseline instead of treating
    // it as everyone losing points.
    const matched = participants.filter((p) => baseline[p.tag] !== undefined);
    const droppedCount = matched.filter((p) => p.fame < baseline[p.tag]).length;
    if (matched.length > 0 && droppedCount > matched.length / 2) {
      baseline = {};
    }

    let suspiciousCount = 0;
    const contributions = participants.map((p) => {
      const prevFame = baseline[p.tag] || 0;
      const todayFame = p.fame - prevFame;
      if (todayFame === 400) suspiciousCount++;
      return { tag: p.tag, name: p.name, totalFame: p.fame, todayFame };
    });

    if (suspiciousCount > 15) {
      // Bad day — record it as skipped, don't touch the baseline
      data.log[today] = { status: 'skipped', suspiciousCount };
      await githubPutFile(data, sha);
      res.status(200).json({ message: 'Skipped ' + today + ' — ' + suspiciousCount + ' players showed exactly 400 (glitch).' });
      return;
    }

    // Good day — record it and advance the baseline
    data.log[today] = { status: 'ok', contributions };
    const newBaseline = {};
    contributions.forEach((c) => { newBaseline[c.tag] = c.totalFame; });
    data.baseline = newBaseline;

    await githubPutFile(data, sha);
    res.status(200).json({ message: 'Captured ' + today + ' for ' + contributions.length + ' players.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
