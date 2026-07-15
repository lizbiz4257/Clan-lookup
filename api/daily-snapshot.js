// api/daily-snapshot.js
// Runs automatically once a day (see vercel.json, 5:30pm Eastern, Thu-Sun).
// Captures each TKO and !Baked! 2.0 player's cumulative war fame, diffs it
// against yesterday's stored total to get "today's" contribution, and
// writes it directly into data/day-corrections.json — the SAME file and
// format used for the manually-supplied weeks, so everything lives in one
// place automatically from here on. No more manual screenshots needed.
//
// How it figures out which day (D1/D2/D3/D4) it's writing: it just counts
// how many times it's successfully captured within the current week
// (tracked per clan), resetting to 1 whenever the week label changes. Since
// this runs once per active war day, that count lines up with D1, D2, D3, D4
// in order.
//
// SETUP REQUIRED (same as before):
//   1. On GitHub: Settings -> Developer settings -> Personal access tokens
//      -> Tokens (classic) -> Generate new token, "repo" scope
//   2. In Vercel -> Settings -> Environment Variables:
//        GITHUB_TOKEN = your token
//        GITHUB_REPO  = yourusername/clan-lookup

const { royaleApiGet } = require('../lib/clanData');

const TRACKED_TAGS = ['#YRVC9QVJ', '#YQJPR2V9']; // !Baked! 2.0, Team Knockouts
const FILE_PATH = 'data/day-corrections.json';

async function githubGetFile() {
  const resp = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + FILE_PATH, {
    headers: {
      Authorization: 'token ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json'
    }
  });

  if (resp.status === 404) {
    return { data: {}, sha: null };
  }
  if (!resp.ok) {
    throw new Error('GitHub read error ' + resp.status + ': ' + (await resp.text()));
  }

  const json = await resp.json();
  const decoded = Buffer.from(json.content, 'base64').toString('utf-8');
  return { data: JSON.parse(decoded), sha: json.sha };
}

async function githubPutFile(data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message, content };
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
  return (await resp.json()).content.sha;
}

function weekLabelFromRace(race) {
  if (race.sectionIndex != null) {
    // currentriverrace doesn't expose seasonId the same way riverracelog
    // does — periodIndex/sectionIndex combination approximates the same
    // "134-1" style label used elsewhere once matched against the log.
    return (race.periodIndex != null ? race.periodIndex : '?') + '-' + race.sectionIndex;
  }
  return null;
}

module.exports = async function handler(req, res) {
  const providedSecret = req.headers['authorization'] || req.query.secret;
  if (process.env.CRON_SECRET && providedSecret !== 'Bearer ' + process.env.CRON_SECRET && providedSecret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const easternNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const [easternHour, easternMinute] = easternNow.split(':').map(Number);
  const isTargetTime = easternHour === 17 && easternMinute >= 25 && easternMinute <= 35;

  if (!isTargetTime && !req.query.force) {
    res.status(200).json({ message: 'Skipped — not the target local time (currently ' + easternNow + ' Eastern).' });
    return;
  }

  const results = [];

  try {
    const { data, sha: initialSha } = await githubGetFile();
    let sha = initialSha;

    for (const tag of TRACKED_TAGS) {
      try {
        const currentRace = await royaleApiGet('/clans/' + encodeURIComponent(tag) + '/currentriverrace');
        const participants = currentRace.clan.participants || [];
        const weekLabel = weekLabelFromRace(currentRace) || 'unlabeled-' + new Date().toISOString().slice(0, 10);

        if (!data[tag]) data[tag] = {};
        if (!data._meta) data._meta = {};
        if (!data._meta[tag]) data._meta[tag] = { baseline: {}, currentWeekLabel: null, dayCount: 0 };

        const meta = data._meta[tag];

        // New week started — reset baseline and day counter
        if (meta.currentWeekLabel !== weekLabel) {
          meta.baseline = {};
          meta.currentWeekLabel = weekLabel;
          meta.dayCount = 0;
        }

        meta.dayCount = Math.min(meta.dayCount + 1, 4); // cap at D4
        const dayKey = 'd' + meta.dayCount;

        if (!data[tag][weekLabel]) data[tag][weekLabel] = { players: {} };

        participants.forEach((p) => {
          const prevFame = meta.baseline[p.tag] || 0;
          const todayFame = p.fame - prevFame;

          if (!data[tag][weekLabel].players[p.tag]) {
            data[tag][weekLabel].players[p.tag] = {
              d1: { fame: 0, attacks: 0 }, d2: { fame: 0, attacks: 0 },
              d3: { fame: 0, attacks: 0 }, d4: { fame: 0, attacks: 0 }
            };
          }
          data[tag][weekLabel].players[p.tag][dayKey] = { fame: todayFame, attacks: p.decksUsed };
          meta.baseline[p.tag] = p.fame;
        });

        results.push(tag + ': captured ' + weekLabel + ' ' + dayKey + ' for ' + participants.length + ' players');
      } catch (err) {
        results.push(tag + ': FAILED — ' + err.message);
      }
    }

    sha = await githubPutFile(data, sha, 'Automatic daily capture — ' + new Date().toISOString().slice(0, 10));
    res.status(200).json({ message: results.join(' | ') });
  } catch (err) {
    res.status(500).json({ error: err.message, partial: results });
  }
}
