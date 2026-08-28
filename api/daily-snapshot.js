// api/daily-snapshot.js
// Runs automatically once a day (see vercel.json, 5:30pm Eastern, Thu-Sun).
// Captures each tracked clan's players' cumulative war fame, diffs it against
// yesterday's stored total to get "today's" contribution, and writes it
// directly into data/day-corrections.json — the SAME file and format used for
// the manually-supplied weeks, so everything lives in one place automatically
// from here on. No more manual screenshots needed.
//
// TRACKED CLANS: Team Knockouts, !Baked! 2.0, !Baked! 1.0, !Baked! 1.5,
// !Baked! 3.0 (5k + 4k + Bak3). Add or remove clans by editing TRACKED_TAGS
// below — nothing else needs to change.
//
// RETENTION: only the most recent MAX_WEEKS_TO_KEEP (10) weeks are kept per
// clan; older weeks are pruned automatically on each run.
//
// MEMBERSHIP / TENURE: each run also records who is in every family clan into
// data/members-history.json (firstSeen / lastSeen per player), so "how long
// they've been in the clan" can be computed later. This is data collection
// only — nothing is shown on the website yet. Tenure can only be measured from
// when tracking starts (Clash's API has no join date).
//
// WHEN it runs: a war day doesn't close until ~5:30am ET the NEXT morning, so
// this captures the MORNING AFTER each war day (Fri/Sat/Sun/Mon, ~6:30-7:30am
// ET) — that's the only time the day's numbers are actually complete. (The old
// 5:30pm capture only ever grabbed a partial, mid-war day.)
//
// How it figures out which day (D1/D2/D3/D4) it's writing: it maps the capture
// MORNING to the war day that just closed —
//   Fri morning -> Thu's war day  = D1
//   Sat morning -> Fri's war day  = D2
//   Sun morning -> Sat's war day  = D3
//   Mon morning -> Sun's war day  = D4
// Mapping by real weekday (not a run counter) means a missed run never shifts
// the other days — the missed day just stays blank.
//
// To avoid double-counting, each clan is captured at most ONCE per Eastern
// calendar day (meta.lastCaptureDate). That once-per-day guard — not a tight
// clock window — is what keeps the backup cron from writing twice.
//
// D4 caveat: Sunday's war day closes Monday ~5:30am, right around when the live
// river race rolls to next week. So on the Monday (D4) run we only write if the
// live race is STILL the week we've been filling; if it has already rolled we
// skip D4 rather than corrupt the week with next week's reset numbers.
//
// SETUP REQUIRED (same as before):
//   1. On GitHub: Settings -> Developer settings -> Personal access tokens
//      -> Tokens (classic) -> Generate new token, "repo" scope
//   2. In Vercel -> Settings -> Environment Variables:
//        GITHUB_TOKEN = your token
//        GITHUB_REPO  = yourusername/clan-lookup

const { royaleApiGet } = require('../lib/clanData');

const TRACKED_TAGS = [
  '#YRVC9QVJ', // !Baked! 2.0
  '#YQJPR2V9', // Team Knockouts (TKO)
  '#GURCRRY9', // !Baked! 1.0
  '#LUCQVPRV', // !Baked! 1.5
  '#QJU8P80C'  // !Baked! 3.0
];

const FILE_PATH = 'data/day-corrections.json';

// Keep only the most recent N weeks per clan; older weeks are removed on each
// run so the file doesn't grow forever. Raise this if you ever want more
// history retained.
const MAX_WEEKS_TO_KEEP = 10;

// ---- MEMBERSHIP / TENURE TRACKING ----
// Separate from scores: each run records who is currently in every family clan,
// stamping a "firstSeen" date the first time we see a player and updating
// "lastSeen" each run, so "how long they've been in the clan" can be computed
// later (days since firstSeen). Clash's API has no join date, so this can only
// measure tenure from when tracking started. Written to its own file; NOT shown
// on the website yet — this is just data collection for now.
const MEMBERS_FILE_PATH = 'data/members-history.json';
// If we haven't seen a player for more than this many days, treat their return
// as a NEW stint and reset firstSeen (handles someone leaving and rejoining).
// Set generously because captures only happen on war days (Thu-Sun), so a normal
// gap between runs is a few days.
const MEMBER_GAP_RESET_DAYS = 14;
// Every clan in the family — membership is tracked for ALL of these.
const FAMILY_CLANS_FOR_MEMBERS = [
  { tag: '#YQJPR2V9', name: 'Team Knockouts' },
  { tag: '#YRVC9QVJ', name: '!Baked! 2.0' },
  { tag: '#GURCRRY9', name: '!Baked! 1.0' },
  { tag: '#LUCQVPRV', name: '!Baked! 1.5' },
  { tag: '#QJU8P80C', name: '!Baked! 3.0' },
  { tag: '#QVY92JLV', name: 'Baked 3.5' },
  { tag: '#GQ20UQR8', name: 'Baked 4.0' },
  { tag: '#GY0QQGYY', name: 'Just Peachy' },
  { tag: '#L0PQ2ULQ', name: 'Dudes Reunited' },
  { tag: '#G9LRRP82', name: '!Baked! 2.5' },
  { tag: '#RYJ2V8V2', name: 'Team Lockouts' },
  { tag: '#QLUUVQ',   name: 'BBN' },
  { tag: '#QC2LY9CY', name: '!Baked! Retired' }
];

function daysBetween(fromYMD, toYMD) {
  const a = new Date(fromYMD + 'T00:00:00Z');
  const b = new Date(toYMD + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

async function githubGetFile(path) {
  const resp = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + path, {
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

async function githubPutFile(path, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha;
  const resp = await fetch('https://api.github.com/repos/' + process.env.GITHUB_REPO + '/contents/' + path, {
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

// Fetches the one piece of history needed to label the current week (split
// out from the label calculation itself so it can be kicked off in PARALLEL
// with the currentriverrace call in the main loop below, instead of after it —
// the two calls don't depend on each other, only the final calculation does).
async function fetchLastRace(tag) {
  try {
    return await royaleApiGet('/clans/' + encodeURIComponent(tag) + '/riverracelog?limit=1');
  } catch (e) {
    return null; // fall through to the dated fallback in computeWeekLabel
  }
}

// Produce the SAME "134-1" (seasonId + 1-based section) week label the Google
// Sheet and the rest of the site use — this is what makes the captured data
// matchable. currentriverrace does NOT expose seasonId, so we read it from the
// most recent COMPLETED week in the war log, and if the live section index has
// wrapped back toward the start, the season has rolled over so we bump it by 1.
function computeWeekLabel(curSection, log) {
  if (curSection == null) return null;
  const last = log && log.items && log.items[0];
  if (last && last.seasonId != null && last.sectionIndex != null) {
    const season = (curSection <= last.sectionIndex) ? last.seasonId + 1 : last.seasonId;
    return season + '-' + (curSection + 1); // e.g. "134-1", matching the sheet
  }
  return null;
}

module.exports = async function handler(req, res) {
  const providedSecret = req.headers['authorization'] || req.query.secret;
  if (process.env.CRON_SECRET && providedSecret !== 'Bearer ' + process.env.CRON_SECRET && providedSecret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Figure out the Eastern date, weekday, and hour in one shot. The weekday
  // picks which just-closed war day we're recording; the date is the once-per-
  // day guard key.
  const eParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const e = Object.fromEntries(eParts.map((p) => [p.type, p.value]));
  const easternDate = e.year + '-' + e.month + '-' + e.day; // e.g. "2026-08-22"
  const easternWeekday = e.weekday;                          // e.g. "Sat"
  const easternHour = Number(e.hour);                        // 0-23

  // Each war day closes ~5:30am ET the next morning, so we capture the MORNING
  // AFTER: Fri->D1 (Thu's war day), Sat->D2, Sun->D3, Mon->D4. Mapping the slot
  // to the real weekday (instead of counting runs) means a skipped day never
  // shifts the others.
  const WAR_DAY_SLOT = { Fri: 1, Sat: 2, Sun: 3, Mon: 4 };
  const warDay = WAR_DAY_SLOT[easternWeekday] || null;

  // Not a capture morning -> nothing to record, even with ?force (no valid slot).
  if (!warDay) {
    res.status(200).json({ message: 'Skipped — ' + easternWeekday + ' is not a capture morning (Fri-Mon only).' });
    return;
  }

  // Only capture in the early-morning window (06:00-11:59 ET), AFTER the ~5:30am
  // war-day close. It's deliberately WIDE: Vercel's Hobby-plan cron fires
  // somewhere within its scheduled hour (and can be delayed), not on the exact
  // minute, so a tight window silently drops whole days. The real "don't capture
  // twice" protection is the once-per-day guard below, not this window. ?force
  // bypasses the window for manual/backfill runs.
  const inWindow = easternHour >= 6 && easternHour <= 11;
  if (!inWindow && !req.query.force) {
    res.status(200).json({ message: 'Skipped — outside the capture window (currently ' + easternWeekday + ' ' + easternHour + ':xx Eastern; window is 06:00-11:59).' });
    return;
  }

  const results = [];
  try {
    const { data, sha: initialSha } = await githubGetFile(FILE_PATH);
    let sha = initialSha;

    // Process all tracked clans CONCURRENTLY rather than one at a time. Each
    // clan needs 2 external calls (currentriverrace + a 1-item riverracelog for
    // the week label); doing 5 clans sequentially meant ~10 round trips back to
    // back before a single byte got written back to GitHub, which on a
    // Vercel Hobby-plan function (short default execution time limit) risks the
    // whole run being killed mid-way — silently, with NOTHING committed, since
    // the write only happens once at the very end. Running clans in parallel
    // (and, within a clan, its 2 calls in parallel) cuts the wall-clock time to
    // roughly that of the SLOWEST single call instead of the sum of all of them.
    // Each clan only ever touches its own slice of `data`/`data._meta`, so
    // there's no shared-state race between clans running concurrently.
    await Promise.all(TRACKED_TAGS.map(async (tag) => {
      try {
        const [currentRace, lastRaceLog] = await Promise.all([
          royaleApiGet('/clans/' + encodeURIComponent(tag) + '/currentriverrace'),
          fetchLastRace(tag)
        ]);
        const participants = currentRace.clan.participants || [];
        const weekLabel = computeWeekLabel(currentRace.sectionIndex, lastRaceLog) || 'unlabeled-' + new Date().toISOString().slice(0, 10);

        if (!data[tag]) data[tag] = {};
        if (!data._meta) data._meta = {};
        if (!data._meta[tag]) data._meta[tag] = { baseline: {}, currentWeekLabel: null, lastCaptureDate: null };
        const meta = data._meta[tag];

        // Decide which week this capture belongs to.
        if (warDay <= 3) {
          // Fri/Sat/Sun mornings: the war is still ongoing, so the live race IS
          // this week. Start a fresh cycle (reset baseline) the first time we see
          // a new week — this also recovers gracefully if an earlier day was
          // missed (that slot just stays blank; the running totals stay right).
          if (meta.currentWeekLabel !== weekLabel) {
            meta.baseline = {};
            meta.currentWeekLabel = weekLabel;
            meta.lastCaptureDate = null;
          }
        } else {
          // D4 (Monday), AFTER Sunday's war day closes — the live race has often
          // already rolled to next week by now. Only record D4 if the live race
          // is STILL the week we've been filling; otherwise skip so we never
          // write next week's freshly-reset numbers into this week's D4.
          if (meta.currentWeekLabel !== weekLabel) {
            results.push(tag + ': race already rolled (live ' + weekLabel + ' vs filling ' + (meta.currentWeekLabel || 'none') + ') — D4 skipped to avoid corruption');
            return; // was `continue` under the old sequential for-loop; this now runs inside Promise.all(map(...))
          }
        }
        const targetWeek = meta.currentWeekLabel;

        // Once-per-day guard: if this clan was already captured today, skip it
        // so a second (backup) cron fire doesn't double-count. ?force overrides.
        if (meta.lastCaptureDate === easternDate && !req.query.force) {
          results.push(tag + ': already captured today (' + easternDate + '), skipped');
          return; // was `continue` under the old sequential for-loop; this now runs inside Promise.all(map(...))
        }

        const dayKey = 'd' + warDay; // Fri->d1, Sat->d2, Sun->d3, Mon->d4

        if (!data[tag][targetWeek]) data[tag][targetWeek] = { players: {} };
        let flaggedThisRun = 0;
        participants.forEach((p) => {
          // Both fame and decksUsed from the API are CUMULATIVE for the week, so
          // today's contribution is the difference from yesterday's stored total
          // for BOTH. (Older baselines stored just a fame number; handle either.)
          const prev = meta.baseline[p.tag];
          const prevFame  = (prev && typeof prev === 'object' ? prev.fame  : prev) || 0;
          const prevDecks = (prev && typeof prev === 'object' ? prev.decks : 0)    || 0;
          const todayFame    = p.fame - prevFame;
          const todayAttacks = p.decksUsed - prevDecks;

          // SANITY GUARD: a single war day allows at most 4 deck uses. If the
          // diff exceeds that, `meta.baseline[p.tag]` was stale going into this
          // capture (a prior day's run failed/was skipped for this player, or
          // they were briefly missing from `participants`), so this delta is
          // actually TWO OR MORE days of fame/attacks stacked into one — the
          // exact "impossible score" bug confirmed in week 135-3 (e.g. a player
          // showing 8 decks / ~1500 fame on a single day). We still WRITE the
          // value (dropping it silently would lose real data) and still advance
          // the baseline below (skipping that would only compound the error
          // into the NEXT day too) — but we flag it loudly in both the response
          // message and a persisted `_flags` list so it's caught the same
          // morning instead of sitting wrong in the sheet for a week. Flagged
          // rows need a manual spot-check against RoyaleAPI/CW2 Stats to split
          // correctly — see day-corrections.json's `_flags` array.
          if (todayAttacks > 4) {
            flaggedThisRun++;
            if (!data._flags) data._flags = [];
            data._flags.push({
              capturedAt: easternDate, clan: tag, week: targetWeek, day: dayKey,
              tag: p.tag, name: p.name, fame: todayFame, attacks: todayAttacks,
              note: 'exceeds 4 decks in one war day — baseline was likely stale; this day probably has a prior missed day\'s fame/attacks stacked in. Spot-check against RoyaleAPI before trusting this number.'
            });
          }

          if (!data[tag][targetWeek].players[p.tag]) {
            data[tag][targetWeek].players[p.tag] = {
              d1: { fame: 0, attacks: 0 }, d2: { fame: 0, attacks: 0 },
              d3: { fame: 0, attacks: 0 }, d4: { fame: 0, attacks: 0 }
            };
          }
          data[tag][targetWeek].players[p.tag].name = p.name; // for the Daily Scores display; the sheet ignores this field
          data[tag][targetWeek].players[p.tag][dayKey] = { fame: todayFame, attacks: todayAttacks };
          meta.baseline[p.tag] = { fame: p.fame, decks: p.decksUsed };
        });

        // Keep _flags from growing forever — same idea as the per-clan week
        // pruning below, just a flat cap since flags aren't grouped by clan/week.
        if (data._flags && data._flags.length > 200) {
          data._flags = data._flags.slice(data._flags.length - 200);
        }

        meta.lastCaptureDate = easternDate; // mark this clan done for today
        results.push(tag + ': captured ' + targetWeek + ' ' + dayKey + ' for ' + participants.length + ' players' +
          (flaggedThisRun ? ' — ⚠️ ' + flaggedThisRun + ' FLAGGED as impossible (>4 decks/day), check _flags in day-corrections.json' : ''));
      } catch (err) {
        results.push(tag + ': FAILED — ' + err.message);
      }
    }));

    // Prune old weeks — keep only the most recent MAX_WEEKS_TO_KEEP per clan.
    // Weeks are stored in the order they were first captured (oldest first),
    // so the oldest weeks are simply the leading keys and can be dropped.
    Object.keys(data).forEach((tag) => {
      if (tag === '_meta') return;
      const weeks = Object.keys(data[tag]);
      if (weeks.length > MAX_WEEKS_TO_KEEP) {
        const removeCount = weeks.length - MAX_WEEKS_TO_KEEP;
        weeks.slice(0, removeCount).forEach((wk) => { delete data[tag][wk]; });
        results.push(tag + ': pruned ' + removeCount + ' old week(s), keeping last ' + MAX_WEEKS_TO_KEEP);
      }
    });

    sha = await githubPutFile(FILE_PATH, data, sha, 'Automatic daily capture — ' + new Date().toISOString().slice(0, 10));

    // ---- MEMBERSHIP / TENURE SNAPSHOT (all family clans) ----
    // Recorded to its own file. Not shown on the website yet — collection only.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: members, sha: membersSha } = await githubGetFile(MEMBERS_FILE_PATH);
      // Same reasoning as the tracked-clan loop above: 13 family clans hit
      // sequentially was 13 more back-to-back round trips added onto the same
      // single function invocation. Each clan only touches its own
      // members[clan.tag] entry, so running them concurrently is safe.
      await Promise.all(FAMILY_CLANS_FOR_MEMBERS.map(async (clan) => {
        try {
          const info = await royaleApiGet('/clans/' + encodeURIComponent(clan.tag));
          const list = info.memberList || [];
          if (!members[clan.tag]) members[clan.tag] = { name: clan.name, members: {} };
          members[clan.tag].name = clan.name;
          const rec = members[clan.tag].members;
          list.forEach((m) => {
            const existing = rec[m.tag];
            let firstSeen = today;
            if (existing && existing.firstSeen) {
              const gap = daysBetween(existing.lastSeen || existing.firstSeen, today);
              // Long gap since we last saw them -> treat as a fresh stint.
              firstSeen = (gap > MEMBER_GAP_RESET_DAYS) ? today : existing.firstSeen;
            }
            rec[m.tag] = { name: m.name, firstSeen: firstSeen, lastSeen: today };
          });
          results.push(clan.tag + ' members: ' + list.length + ' recorded');
        } catch (err) {
          results.push(clan.tag + ' members: FAILED — ' + err.message);
        }
      }));
      await githubPutFile(MEMBERS_FILE_PATH, members, membersSha, 'Daily member snapshot — ' + today);
    } catch (err) {
      results.push('member tracking FAILED — ' + err.message);
    }

    res.status(200).json({ message: results.join(' | ') });
  } catch (err) {
    res.status(500).json({ error: err.message, partial: results });
  }
}
