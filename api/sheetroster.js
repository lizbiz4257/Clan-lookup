// lib/sheetRoster.js
//
// Reads the live "Project Shithouse" roster sheet for the website's Rosters
// tab. The sheet is the SOURCE OF TRUTH here — not just an overlay: every
// row on the sheet (mains AND alts) becomes a row on the website, because
// the sheet already bakes in day-corrections.json exclusions and any manual
// fixes made after the fact, which a fresh Royale API pull (lookupOneClan)
// doesn't know about. api/rosters.js drives its row list off this file's
// output, then enriches each row with live API data (week history,
// 5kP/5kG/5kPPG) by matching Player Tag, and separately appends any live
// clan member who isn't in the sheet at all yet (brand new, not added).
//
// Requires the sheet's General access to be "Anyone with the link – Viewer"
// (set 2026-09-05) — Google Sheets sharing is whole-file, so this exposes
// every tab on "Project Shithouse", not just the 4 roster tabs.

const SPREADSHEET_ID = '1Y3nQqrxVisGTbbr4-E5s0HXBlYq8igDYmKIRnQ-2ufY';

// gid (tab id) for each of the 4 roster tabs — confirmed directly from the
// sheet's own tab URLs on 2026-09-05. These do NOT change unless someone
// deletes and recreates a tab (renaming a tab does not change its gid).
const TAB_GIDS = {
  '5k': 1039365154,   // 5k Rosters
  '4k': 1360048934,   // 4k Rosters
  bak3: 352291386,    // Bak3
  '35-40': 1097256106 // 3.5/4.0
};

// The "Total ##k" column is named differently per tab.
const TOTAL_COL_BY_GROUP = {
  '5k': 'Total 5k',
  '4k': 'Total 4k',
  bak3: 'Total 3k',
  '35-40': 'Total 5k'
};

// Sheet data only changes when someone manually edits it, so a short cache
// avoids re-fetching Google Sheets on every single page view.
const cache = new Map(); // gid -> { time, rows }
const CACHE_TTL_MS = 60 * 1000;

// Minimal CSV parser for Google Sheets' own CSV export (handles quoted
// fields with embedded commas/quotes, e.g. "36,500"). Not a general-purpose
// CSV library — just enough for this one well-formed, known source.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip — the paired \n handles the actual line break
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchTabCsv(gid) {
  // Google issues a 302 to a signed, time-limited googleusercontent.com URL —
  // fetch() follows redirects by default, so this one call is all that's
  // needed (no need to capture/reuse the signed URL, which expires anyway).
  const url = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/export?format=csv&gid=' + gid;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error('Sheet export error ' + resp.status + ' for gid ' + gid + ' — check that "Project Shithouse" is still shared as "Anyone with the link".');
  }
  return resp.text();
}

function toNumberOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).trim().replace(/,/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

// Returns EVERY row on one roster tab (mains and alts alike) as an array:
// [{ tag, account, player, alt, rostered, inClan, lastClan, total, elo,
//    fivewa, score, played, coloScore, coloBattles }, ...]
// in the same order they appear on the sheet. Tabs that don't have a given
// column (e.g. Bak3 and 3.5/4.0 have no Colo Score/Colo Battles columns;
// 3.5/4.0 has no dedicated In Clan column) just get null for that field.
async function fetchRosterSheet(groupKey) {
  const gid = TAB_GIDS[groupKey];
  if (!gid) throw new Error('Unknown roster group: ' + groupKey);

  const cached = cache.get(gid);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.rows;

  const csvText = await fetchTabCsv(gid);
  const parsed = parseCsv(csvText);
  const header = parsed[0] || [];
  const col = (name) => header.indexOf(name);
  const totalColName = TOTAL_COL_BY_GROUP[groupKey] || 'Total 5k';

  const idx = {
    account: col('Account'),
    tag: col('Player Tag'),
    player: col('Player'),
    alt: col('Alt'),
    rostered: col('Rostered'),
    inClan: col('In Clan'),
    lastClan: col('Last Clan') >= 0 ? col('Last Clan') : col('Clan'), // 3.5/4.0 uses "Clan" instead
    total: col(totalColName),
    elo: col('Elo'),
    fivewa: col('5wa'),
    score: col('Score'),
    played: col('Played'),
    coloScore: col('Colo Score'),
    coloBattles: col('Colo Battles')
  };

  const rows = [];
  for (let r = 1; r < parsed.length; r++) {
    const row = parsed[r];
    const tag = idx.tag >= 0 ? String(row[idx.tag] || '').trim().toUpperCase() : '';
    if (!tag || tag.charAt(0) !== '#') continue; // skip blank/summary/header-ish rows

    rows.push({
      tag: tag,
      account: idx.account >= 0 ? (String(row[idx.account] || '').trim() || null) : null,
      player: idx.player >= 0 ? (String(row[idx.player] || '').trim() || null) : null,
      alt: idx.alt >= 0 ? (String(row[idx.alt] || '').trim() || null) : null,
      rostered: idx.rostered >= 0 ? (String(row[idx.rostered] || '').trim() || null) : null,
      inClan: idx.inClan >= 0 ? (String(row[idx.inClan] || '').trim() || null) : null,
      lastClan: idx.lastClan >= 0 ? (String(row[idx.lastClan] || '').trim() || null) : null,
      total: toNumberOrNull(idx.total >= 0 ? row[idx.total] : null),
      elo: toNumberOrNull(idx.elo >= 0 ? row[idx.elo] : null),
      fivewa: toNumberOrNull(idx.fivewa >= 0 ? row[idx.fivewa] : null),
      score: toNumberOrNull(idx.score >= 0 ? row[idx.score] : null),
      played: toNumberOrNull(idx.played >= 0 ? row[idx.played] : null),
      coloScore: toNumberOrNull(idx.coloScore >= 0 ? row[idx.coloScore] : null),
      coloBattles: toNumberOrNull(idx.coloBattles >= 0 ? row[idx.coloBattles] : null)
    });
  }

  cache.set(gid, { time: Date.now(), rows });
  return rows;
}

module.exports = { fetchRosterSheet, TAB_GIDS, SPREADSHEET_ID };
