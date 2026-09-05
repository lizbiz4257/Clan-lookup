// lib/sheetRoster.js
//
// Pulls the handful of columns on the live "Project Shithouse" roster sheet
// that have NO Royale API source at all — Player (Discord display name),
// Rostered (manual roster assignment, separate from live In Clan status),
// and Colosseum stats (a different game mode the river race API doesn't
// cover). Everything else shown on the website's Rosters tab (In Clan, Last
// Clan, Total 5k, Elo, 5wa, Score/Played, week history, 5kP/5kG/5kPPG) comes
// live from the Royale API via lookupOneClan in clanData.js instead, so the
// site keeps auto-updating during an active war without waiting on this
// sheet. This file only overlays the few fields that are genuinely
// manual-only, matched onto that live data by Player Tag.
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

// Overlay data only changes when someone manually edits the sheet, so a
// short cache avoids re-fetching Google Sheets on every single page view.
const cache = new Map(); // gid -> { time, overlay }
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

// Returns { [playerTag]: { player, rostered, coloScore, coloBattles } } for
// one roster tab. Tabs that don't have a given column (e.g. Bak3 and 3.5/4.0
// have no Colo Score/Colo Battles columns) just get null for that field.
async function fetchRosterOverlay(groupKey) {
  const gid = TAB_GIDS[groupKey];
  if (!gid) throw new Error('Unknown roster group: ' + groupKey);

  const cached = cache.get(gid);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.overlay;

  const csvText = await fetchTabCsv(gid);
  const rows = parseCsv(csvText);
  const header = rows[0] || [];
  const col = (name) => header.indexOf(name);

  const idx = {
    tag: col('Player Tag'),
    player: col('Player'),
    rostered: col('Rostered'),
    coloScore: col('Colo Score'),
    coloBattles: col('Colo Battles')
  };

  const overlay = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const tag = idx.tag >= 0 ? String(row[idx.tag] || '').trim().toUpperCase() : '';
    if (!tag || tag.charAt(0) !== '#') continue; // skip blank/summary/header-ish rows

    const coloScoreRaw = idx.coloScore >= 0 ? row[idx.coloScore] : '';
    const coloBattlesRaw = idx.coloBattles >= 0 ? row[idx.coloBattles] : '';

    overlay[tag] = {
      player: idx.player >= 0 ? (String(row[idx.player] || '').trim() || null) : null,
      rostered: idx.rostered >= 0 ? (String(row[idx.rostered] || '').trim() || null) : null,
      coloScore: coloScoreRaw !== '' && !isNaN(Number(coloScoreRaw)) ? Number(coloScoreRaw) : null,
      coloBattles: coloBattlesRaw !== '' && !isNaN(Number(coloBattlesRaw)) ? Number(coloBattlesRaw) : null
    };
  }

  cache.set(gid, { time: Date.now(), overlay });
  return overlay;
}

module.exports = { fetchRosterOverlay, TAB_GIDS, SPREADSHEET_ID };
