// api/sync-to-sheet.js
// Runs automatically on a schedule (see vercel.json) — pulls all 7 family
// clans and writes the combined data into a tab in your roster Google Sheet.
//
// SETUP REQUIRED (see the setup guide for full steps):
//   GOOGLE_CLIENT_EMAIL   - service account email
//   GOOGLE_PRIVATE_KEY    - service account private key
//   GOOGLE_SHEET_ID       - the ID of your roster spreadsheet (from its URL)
//   CRON_SECRET           - a random string only you and Vercel know, to stop
//                           anyone else from triggering this endpoint

const { google } = require('googleapis');
const { FAMILY_TAGS, lookupOneClan, royaleApiGet } = require('../lib/clanData');

const SHEET_TAB_NAME = 'Auto Sync';
const BAKED_2_TAG = '#YRVC9QVJ';
const BAKED_2_SNAPSHOT_TAB = 'Baked2 Daily Snapshot';
const BAKED_2_LOG_TAB = 'Baked2 Daily Log';

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function ensureTabExists(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] }
  });
}

// Reads yesterday's stored cumulative fame per player (tag -> fame), so we
// can diff today's total against it to get just today's contribution.
async function readPreviousSnapshot(sheets, spreadsheetId) {
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: BAKED_2_SNAPSHOT_TAB + '!A2:C'
    });
    const rows = resp.data.values || [];
    const map = {};
    rows.forEach((r) => { map[r[0]] = { name: r[1], fame: parseInt(r[2], 10) || 0 }; });
    return map;
  } catch (err) {
    return {}; // tab doesn't exist yet or is empty — first run
  }
}

async function writeSnapshot(sheets, spreadsheetId, tabName, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: tabName + '!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });
}

async function appendRows(sheets, spreadsheetId, tabName, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: tabName + '!A1',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

// Runs once a day (piggybacking on this same cron): fetches Baked 2.0's
// current cumulative fame per player, diffs it against yesterday's stored
// total to get "today's" contribution, and checks for the 400-anomaly.
// If >15 players show exactly 400 today, treat it as bad data — skip
// advancing the stored baseline so tomorrow's diff still compares against
// the last known-good day, and log the skip instead of the (likely wrong) numbers.
async function processBaked2DailySnapshot(sheets, spreadsheetId) {
  await ensureTabExists(sheets, spreadsheetId, BAKED_2_SNAPSHOT_TAB);
  await ensureTabExists(sheets, spreadsheetId, BAKED_2_LOG_TAB);

  const currentRace = await royaleApiGet('/clans/' + encodeURIComponent(BAKED_2_TAG) + '/currentriverrace');
  const participants = currentRace.clan.participants || [];
  const previous = await readPreviousSnapshot(sheets, spreadsheetId);

  const today = new Date().toISOString().slice(0, 10);
  let suspiciousCount = 0;
  const todayContributions = participants.map((p) => {
    const prevFame = previous[p.tag] ? previous[p.tag].fame : 0;
    const todayFame = p.fame - prevFame;
    if (todayFame === 400) suspiciousCount++;
    return { tag: p.tag, name: p.name, totalFame: p.fame, todayFame };
  });

  if (suspiciousCount > 15) {
    // Bad day — log it, but do NOT overwrite the snapshot baseline.
    await appendRows(sheets, spreadsheetId, BAKED_2_LOG_TAB, [
      [today, 'SKIPPED — ' + suspiciousCount + ' players showed exactly 400 (likely sync glitch)', '', '']
    ]);
    return;
  }

  // Good day — record it and advance the baseline for tomorrow's diff.
  const logRows = todayContributions.map((c) => [today, c.tag, c.name, c.todayFame]);
  await appendRows(sheets, spreadsheetId, BAKED_2_LOG_TAB, logRows);

  const snapshotRows = [['Player Tag', 'Player Name', 'Cumulative Fame (as of ' + today + ')']]
    .concat(todayContributions.map((c) => [c.tag, c.name, c.totalFame]));
  await writeSnapshot(sheets, spreadsheetId, BAKED_2_SNAPSHOT_TAB, snapshotRows);
}

module.exports = async function handler(req, res) {
  // Simple protection so randoms on the internet can't trigger your sync
  const providedSecret = req.headers['authorization'] || req.query.secret;
  if (process.env.CRON_SECRET && providedSecret !== 'Bearer ' + process.env.CRON_SECRET && providedSecret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const results = await Promise.all(
      FAMILY_TAGS.map((tag) => lookupOneClan(tag).catch((err) => ({ clanTag: tag, error: err.message })))
    );
    const clans = results.filter((r) => !r.error);
    const rows = clans.flatMap((c) => c.rows);
    rows.sort((a, b) => (b.total5k || 0) - (a.total5k || 0));

    const headers = [
      'Name', 'Clan', 'In Clan', 'Score This Week', 'Cards Played',
      'Total 5k', 'Elo', '5wa', '5kP', '5kG', '5kPPG', 'Last Synced'
    ];
    const syncedAt = new Date().toISOString();

    const data = rows.map((r) => ([
      r.name, r.clanName || '', r.inClan, r.thisWeekScore, r.thisWeekAttacks,
      r.total5k, r.elo, r.fivewa, r.fiveKP, r.fiveKG, r.fiveKPPG, syncedAt
    ]));

    const sheets = await getSheetsClient();
    await ensureTabExists(sheets, process.env.GOOGLE_SHEET_ID, SHEET_TAB_NAME);
    await writeSnapshot(sheets, process.env.GOOGLE_SHEET_ID, SHEET_TAB_NAME, [headers, ...data]);

    // Piggyback the Baked 2.0 day-by-day capture onto this same daily run.
    let baked2Note = '';
    try {
      await processBaked2DailySnapshot(sheets, process.env.GOOGLE_SHEET_ID);
    } catch (err) {
      baked2Note = ' (Baked2 daily snapshot failed: ' + err.message + ')';
    }

    res.status(200).json({ message: 'Synced ' + rows.length + ' players at ' + syncedAt + baked2Note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
