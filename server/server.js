'use strict';

/* Kitchen Whiteboard — standalone server.
 *
 * Mirror of the Gas Leak Sheet standalone pattern: this server does
 * three jobs:
 *   1. Serve the static client (client/index.html — the whole app).
 *   2. Keep the whiteboard contents (server/data/data.json): one flat
 *      list of items, each belonging to one of the three columns
 *      (groceries, misc, chores), with text and a done flag, an
 *      optional quantity/note (detail) and brand, an optional emoji,
 *      a position/size (x, y, w, h) on the freeform board, and —
 *      chores only — an optional assignee from the household roster
 *      — plus the family's freehand marker strokes on that board.
 *   3. Expose that data behind a small JSON API (/api/board,
 *      /api/items, /api/strokes, /api/clear-checked,
 *      /api/clear-strokes) with basic sanity checks on writes,
 *      because this sits on the public internet with no logins —
 *      anyone with the link can edit the board, by design.
 *
 * State is server-side and shared: every visitor reads and writes
 * the same data.json, so the whole family sees one board.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.json');

const COLUMNS = ['groceries', 'misc', 'chores'];
/* Every area an item can live in: the three kitchen columns plus
   'fun' — the Announcements tab's freeform board. Fun items never
   show in the List or Shop views. */
const ITEM_COLUMNS = COLUMNS.concat(['fun']);
const MAX_BODY = 6 * 1024 * 1024;

/* Freeform board geometry — must match the client canvas. Notes are
   positioned in this coordinate space; each column has a home area
   where new notes start, in a tidy two-across stack, until someone
   drags them wherever they like. */
const BOARD_W = 1680;
const BOARD_H = 1100;
const HOME_X = { groceries: 30, misc: 590, chores: 1150, fun: 30 };
const NOTE_W = 220;
const NOTE_H = 96;

/* Marker colors for sketching, echoing whiteboard markers. */
const STROKE_COLORS = ['#222222', '#2e8b3a', '#2456c8', '#c0392b'];
const MAX_STROKE_POINTS = 3000;

/* Who a chore can be handed to — the household roster. A chores
   item may carry one of these names as its assignee, or null for
   unassigned. Other columns never carry an assignee. */
const ASSIGNEES = ['Ary', 'Tyson', 'Lily', 'Maria', 'Dad'];

/* Photos: two corner slots on the kitchen Board ('slot1', 'slot2')
   and free postings on the fun board ('fun', capped). Image files
   live next to the data file, under photos/; data.json holds only
   metadata. Photos are the ephemeral part of the board: anything
   older than 72 hours is swept away automatically. */
const PHOTO_SLOTS = ['slot1', 'slot2', 'fun'];
const PHOTO_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_FUN_PHOTOS = 8;
const PHOTOS_DIR = path.join(path.dirname(DATA_FILE), 'photos');

/* Weather for Taft, CA, from Open-Meteo (free, no key), fetched
   server-side and cached so the board never waits on it. */
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=35.14&longitude=-119.45&daily=weather_code,temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=3';
const WEATHER_TTL_MS = 3 * 60 * 60 * 1000;
let weatherCache = null; // { fetchedAt, days }

function weatherLabel(code) {
  if (code === 0) return ['☀️', 'Clear'];
  if (code === 1 || code === 2) return ['⛅', 'Partly cloudy'];
  if (code === 3) return ['☁️', 'Cloudy'];
  if (code === 45 || code === 48) return ['🌫️', 'Fog'];
  if (code === 51 || code === 53 || code === 55) return ['🌦️', 'Drizzle'];
  if (code === 56 || code === 57) return ['🌦️', 'Freezing drizzle'];
  if (code === 61 || code === 63 || code === 65) return ['🌧️', 'Rain'];
  if (code === 66 || code === 67) return ['🌧️', 'Freezing rain'];
  if (code === 71 || code === 73 || code === 75 || code === 77) return ['🌨️', 'Snow'];
  if (code === 80 || code === 81 || code === 82) return ['🌧️', 'Showers'];
  if (code === 85 || code === 86) return ['🌨️', 'Snow'];
  if (code === 95) return ['⛈️', 'Thunderstorm'];
  if (code === 96 || code === 99) return ['⛈️', 'Thunderstorm'];
  return ['🌡️', '—'];
}

async function getWeather() {
  if (weatherCache && Date.now() - weatherCache.fetchedAt < WEATHER_TTL_MS) {
    return weatherCache.days;
  }
  try {
    const r = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('weather HTTP ' + r.status);
    const j = await r.json();
    const d = j && j.daily;
    if (!d || !Array.isArray(d.time)) throw new Error('weather shape');
    const days = d.time.map(function (date, i) {
      const wl = weatherLabel(Number(d.weather_code[i]));
      return {
        date: date, code: Number(d.weather_code[i]),
        emoji: wl[0], label: wl[1],
        hi: Math.round(Number(d.temperature_2m_max[i])),
        lo: Math.round(Number(d.temperature_2m_min[i]))
      };
    });
    weatherCache = { fetchedAt: Date.now(), days: days };
    return days;
  } catch (e) {
    return weatherCache ? weatherCache.days : null;
  }
}

/* The board's contents as photographed 2026-10-23, in board order.
   Seeded on first boot only; after that the family manages the
   board in the app and the seed never overwrites it. */
const SEED_ITEMS = [
  ['groceries', 'Eggs'],
  ['groceries', 'Sauces (Zesty, Asian, BBQ)'],
  ['groceries', 'Mayo'],
  ['groceries', 'Black Pepper'],
  ['groceries', 'Frozen Avocados — No Guac'],
  ['groceries', 'Tomatoes'],
  ['groceries', 'Bananas'],
  ['chores', 'Put Dishes UP!'],
  ['chores', 'Run Dishwasher'],
  ['chores', 'Shampoo dog']
];

/* ================= Data storage ================= */

/* Where a new note in this column starts on the freeform board:
   its column's home area, two-across, stacking down. */
function homePosition(column, items) {
  const n = items.filter(function (it) { return it.column === column; }).length;
  const x = HOME_X[column] + (n % 2) * (NOTE_W + 20);
  const y = 84 + Math.floor(n / 2) * (NOTE_H + 16);
  return { x: x, y: Math.min(y, BOARD_H - NOTE_H - 12) };
}

function seedData() {
  const items = [];
  SEED_ITEMS.forEach(function (pair, i) {
    const pos = homePosition(pair[0], items);
    items.push({
      id: i + 1, column: pair[0], text: pair[1], done: false, detail: '', brand: '',
      assignee: null,
      x: pos.x, y: pos.y, w: NOTE_W, h: NOTE_H, emoji: ''
    });
  });
  return {
    nextItemId: items.length + 1, nextStrokeId: 1, nextPhotoId: 1,
    items: items, strokes: [], photos: []
  };
}

function validStroke(s) {
  return s && typeof s.id === 'number' && typeof s.color === 'string' &&
    Array.isArray(s.points) && s.points.length >= 2 &&
    s.points.every(function (p) {
      return Array.isArray(p) && p.length === 2 &&
        Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
    });
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.items)) return seedData();
    if (typeof d.nextItemId !== 'number') d.nextItemId = d.items.length + 1;
    d.items = d.items.filter(function (it) {
      return it && ITEM_COLUMNS.indexOf(it.column) !== -1 && typeof it.text === 'string';
    });
    d.items.forEach(function (it) {
      if (typeof it.done !== 'boolean') it.done = false;
      if (typeof it.detail !== 'string') it.detail = '';
      if (typeof it.brand !== 'string') it.brand = '';
      /* v1/v2 data has no assignee (or a name no longer on the
         roster): anything not on the list becomes unassigned. */
      if (ASSIGNEES.indexOf(it.assignee) === -1) it.assignee = null;
      if (typeof it.emoji !== 'string') it.emoji = '';
      if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) {
        /* v1 data (or a hand-edited file): park the note in its
           column's home area, after the already-placed ones. */
        const placed = d.items.filter(function (o) {
          return o.column === it.column && Number.isFinite(o.x) && Number.isFinite(o.y);
        });
        const pos = homePosition(it.column, placed);
        it.x = pos.x;
        it.y = pos.y;
      }
      if (!Number.isFinite(it.w)) it.w = NOTE_W;
      if (!Number.isFinite(it.h)) it.h = NOTE_H;
    });
    if (!Array.isArray(d.strokes)) d.strokes = [];
    d.strokes = d.strokes.filter(validStroke);
    /* v2 strokes predate the fun board: they belong to the kitchen. */
    d.strokes.forEach(function (s) { if (s.board !== 'fun') s.board = 'kitchen'; });
    if (typeof d.nextStrokeId !== 'number') d.nextStrokeId = d.strokes.length + 1;
    if (!Array.isArray(d.photos)) d.photos = [];
    d.photos = d.photos.filter(function (ph) {
      return ph && typeof ph.id === 'number' && PHOTO_SLOTS.indexOf(ph.slot) !== -1 &&
        typeof ph.file === 'string' && Number.isFinite(ph.uploadedAt);
    });
    d.photos.forEach(function (ph) {
      if (!Number.isFinite(ph.x)) ph.x = 40;
      if (!Number.isFinite(ph.y)) ph.y = 40;
    });
    if (typeof d.nextPhotoId !== 'number') d.nextPhotoId = d.photos.length + 1;
    return d;
  } catch (e) {
    return seedData();
  }
}

function saveData(d) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let data = loadData();
saveData(data); // persist the seed (or a normalized file) on first boot

/* ---- Photo expiry: photos live 3 days, then sweep themselves ---- */

function photoPath(file) {
  return path.join(PHOTOS_DIR, path.basename(file));
}

function unlinkPhoto(ph) {
  try { fs.unlinkSync(photoPath(ph.file)); } catch (e) { /* already gone */ }
}

function sweepPhotos() {
  const now = Date.now();
  const before = data.photos.length;
  data.photos = data.photos.filter(function (ph) {
    if (now - ph.uploadedAt > PHOTO_TTL_MS) { unlinkPhoto(ph); return false; }
    return true;
  });
  if (data.photos.length !== before) saveData(data);
}

sweepPhotos();

/* ================= Validation helpers ================= */

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().slice(0, maxLen);
  return cleaned.length ? cleaned : null;
}

function cleanColumn(v) {
  return ITEM_COLUMNS.indexOf(v) !== -1 ? v : null;
}

/* Which canvas a stroke or a clear-drawings call belongs to. */
function cleanBoard(v) {
  if (v === undefined || v === 'kitchen') return 'kitchen';
  return v === 'fun' ? 'fun' : null;
}

function cleanId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* A finite number within [min, max], rounded to a whole pixel —
   or null when the value is missing or out of range. */
function cleanNum(v, min, max) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

function cleanEmoji(v) {
  if (typeof v !== 'string') return null;
  return v.trim().slice(0, 16);
}

/* An assignee is one of the household names. null, '' and
   'Unassigned' all mean "clear it" and come back as null; anything
   else is not a valid assignee and comes back as undefined. */
function cleanAssignee(v) {
  if (v === null || v === '' || v === 'Unassigned') return null;
  return ASSIGNEES.indexOf(v) !== -1 ? v : undefined;
}

/* A stroke is a polyline: at least 2 points, each an [x, y] pair of
   finite numbers. Points are rounded to a tenth of a pixel to keep
   the data file lean. */
function cleanStrokePoints(v) {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_STROKE_POINTS) return null;
  const pts = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  return pts;
}

function findItem(id) {
  return data.items.find(function (it) { return it.id === id; }) || null;
}

function findStroke(id) {
  return data.strokes.find(function (s) { return s.id === id; }) || null;
}

function findPhoto(id) {
  return data.photos.find(function (ph) { return ph.id === id; }) || null;
}

/* Sniff the real image type from the file's magic bytes — what the
   client claims it sent is not proof. Returns the file extension
   to store it under, or null when it isn't a JPEG/PNG/WebP. */
function photoExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E &&
      buf[3] === 0x47 && buf[4] === 0x0D && buf[5] === 0x0A) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* ================= HTTP ================= */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', function (chunk) {
    body += chunk;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on('end', function () {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) { /* handled by callers */ }
    cb(parsed);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* ---- Whole board ---- */
  if (p === '/api/board') {
    if (req.method === 'GET') {
      sweepPhotos();
      sendJson(res, 200, { items: data.items, strokes: data.strokes, photos: data.photos });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Weather (Taft, CA; cached server-side) ---- */
  if (p === '/api/weather') {
    if (req.method === 'GET') {
      getWeather().then(function (days) {
        if (days) sendJson(res, 200, { days: days });
        else sendJson(res, 502, { error: 'Weather unavailable right now.' });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Items ---- */
  if (p === '/api/items') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const column = body && cleanColumn(body.column);
        const text = body ? cleanText(body.text, 120) : null;
        const emoji = body ? cleanEmoji(body.emoji) : null;
        if (!column) { sendJson(res, 400, { error: 'Unknown column.' }); return; }
        /* A note can be just an emoji — but not nothing at all. */
        if (!text && !emoji) { sendJson(res, 400, { error: 'Item text or an emoji is required.' }); return; }
        let assignee = null;
        if (body && 'assignee' in body) {
          assignee = cleanAssignee(body.assignee);
          if (assignee === undefined) { sendJson(res, 400, { error: 'Unknown assignee.' }); return; }
        }
        const home = homePosition(column, data.items);
        let x = body ? cleanNum(body.x, -500, BOARD_W + 500) : null;
        let y = body ? cleanNum(body.y, -200, BOARD_H + 500) : null;
        if (x === null) x = home.x;
        if (y === null) y = home.y;
        const w = body ? cleanNum(body.w, 90, 900) : null;
        const h = body ? cleanNum(body.h, 56, 700) : null;
        const item = {
          id: data.nextItemId++, column: column, text: text || '', done: false,
          detail: body && typeof body.detail === 'string' ? body.detail.trim().slice(0, 60) : '',
          brand: body && typeof body.brand === 'string' ? body.brand.trim().slice(0, 60) : '',
          /* Only chores carry a person; an assignee sent for any
             other column is validated above, then dropped. */
          assignee: column === 'chores' ? assignee : null,
          x: x, y: y, w: w === null ? NOTE_W : w, h: h === null ? NOTE_H : h,
          emoji: emoji || ''
        };
        data.items.push(item);
        saveData(data);
        sendJson(res, 201, { item: item });
      });
      return;
    }
    if (req.method === 'PATCH') {
      readBody(req, function (body) {
        const id = body && cleanId(body.id);
        const item = id && findItem(id);
        if (!item) { sendJson(res, 404, { error: 'No such item.' }); return; }
        let touched = false;
        if ('done' in body) {
          if (typeof body.done !== 'boolean') { sendJson(res, 400, { error: 'done must be true or false.' }); return; }
          item.done = body.done;
          touched = true;
        }
        if ('detail' in body) {
          if (typeof body.detail !== 'string') { sendJson(res, 400, { error: 'detail must be text.' }); return; }
          item.detail = body.detail.trim().slice(0, 60);
          touched = true;
        }
        if ('brand' in body) {
          if (typeof body.brand !== 'string') { sendJson(res, 400, { error: 'brand must be text.' }); return; }
          item.brand = body.brand.trim().slice(0, 60);
          touched = true;
        }
        if ('column' in body) {
          const column = cleanColumn(body.column);
          if (!column) { sendJson(res, 400, { error: 'Unknown column.' }); return; }
          item.column = column;
          /* A person only sticks to a chore: moving an item out of
             Chores hands the job back to nobody. */
          if (column !== 'chores') item.assignee = null;
          touched = true;
        }
        if ('assignee' in body) {
          const a = cleanAssignee(body.assignee);
          if (a === undefined) { sendJson(res, 400, { error: 'Unknown assignee.' }); return; }
          item.assignee = item.column === 'chores' ? a : null;
          touched = true;
        }
        /* Text and emoji are validated together: a note may end up
           emoji-only, but never completely blank. */
        if ('text' in body || 'emoji' in body) {
          let text = item.text;
          let emoji = item.emoji;
          if ('text' in body) {
            if (typeof body.text !== 'string') { sendJson(res, 400, { error: 'text must be text.' }); return; }
            text = body.text.trim().slice(0, 120);
          }
          if ('emoji' in body) {
            const e = cleanEmoji(body.emoji);
            if (e === null) { sendJson(res, 400, { error: 'emoji must be text.' }); return; }
            emoji = e;
          }
          if (!text && !emoji) { sendJson(res, 400, { error: 'A note needs text or an emoji.' }); return; }
          item.text = text;
          item.emoji = emoji;
          touched = true;
        }
        /* Freeform geometry: position (x, y) and stretch (w, h).
           Validate all four before applying any of them. */
        const GEO = [['x', -500, BOARD_W + 500], ['y', -200, BOARD_H + 500], ['w', 90, 900], ['h', 56, 700]];
        const geo = {};
        for (let i = 0; i < GEO.length; i++) {
          const key = GEO[i][0];
          if (key in body) {
            const n = cleanNum(body[key], GEO[i][1], GEO[i][2]);
            if (n === null) { sendJson(res, 400, { error: key + ' is out of range.' }); return; }
            geo[key] = n;
          }
        }
        Object.keys(geo).forEach(function (key) { item[key] = geo[key]; touched = true; });
        if (!touched) { sendJson(res, 400, { error: 'Nothing to update.' }); return; }
        saveData(data);
        sendJson(res, 200, { item: item });
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = cleanId(url.searchParams.get('id'));
      const item = id && findItem(id);
      if (!item) { sendJson(res, 404, { error: 'No such item.' }); return; }
      data.items = data.items.filter(function (it) { return it.id !== id; });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Clear checked in one column ---- */
  if (p === '/api/clear-checked') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const column = body && cleanColumn(body.column);
        if (!column) { sendJson(res, 400, { error: 'Unknown column.' }); return; }
        const before = data.items.length;
        data.items = data.items.filter(function (it) {
          return !(it.column === column && it.done);
        });
        saveData(data);
        sendJson(res, 200, { ok: true, removed: before - data.items.length });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Sketch strokes (both boards) ---- */
  if (p === '/api/strokes') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        let color = '#222222';
        if (body && body.color !== undefined) {
          if (STROKE_COLORS.indexOf(body.color) === -1) {
            sendJson(res, 400, { error: 'Unknown marker color.' });
            return;
          }
          color = body.color;
        }
        const board = body ? cleanBoard(body.board) : null;
        if (board === null) { sendJson(res, 400, { error: 'Unknown board.' }); return; }
        const points = body ? cleanStrokePoints(body.points) : null;
        if (!points) { sendJson(res, 400, { error: 'A stroke needs at least 2 [x, y] points.' }); return; }
        const stroke = { id: data.nextStrokeId++, color: color, points: points, board: board };
        data.strokes.push(stroke);
        saveData(data);
        sendJson(res, 201, { stroke: stroke });
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = cleanId(url.searchParams.get('id'));
      const stroke = id && findStroke(id);
      if (!stroke) { sendJson(res, 404, { error: 'No such stroke.' }); return; }
      data.strokes = data.strokes.filter(function (s) { return s.id !== id; });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Clear drawings (one board, or all when no board is named) ---- */
  if (p === '/api/clear-strokes') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        let board = null;
        if (body && body.board !== undefined) {
          board = cleanBoard(body.board);
          if (board === null) { sendJson(res, 400, { error: 'Unknown board.' }); return; }
        }
        const before = data.strokes.length;
        data.strokes = board
          ? data.strokes.filter(function (s) { return s.board !== board; })
          : [];
        saveData(data);
        sendJson(res, 200, { ok: true, removed: before - data.strokes.length });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Photos ---- */
  if (p === '/api/photos') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const slot = body && PHOTO_SLOTS.indexOf(body.slot) !== -1 ? body.slot : null;
        if (!slot) { sendJson(res, 400, { error: 'Unknown photo slot.' }); return; }
        const b64 = typeof body.data === 'string' ? body.data.replace(/^data:[^,]*,/, '') : '';
        let buf = null;
        try { buf = b64 ? Buffer.from(b64, 'base64') : null; } catch (e) { buf = null; }
        if (!buf || !buf.length) { sendJson(res, 400, { error: 'No photo data.' }); return; }
        if (buf.length > MAX_PHOTO_BYTES) { sendJson(res, 400, { error: 'That photo is too big.' }); return; }
        const ext = photoExt(buf);
        if (!ext) { sendJson(res, 400, { error: 'That file is not a photo.' }); return; }
        sweepPhotos();
        let x = 40;
        let y = 40;
        if (slot === 'fun') {
          const fun = data.photos.filter(function (ph) { return ph.slot === 'fun'; });
          if (fun.length >= MAX_FUN_PHOTOS) {
            sendJson(res, 400, { error: 'The fun board already has ' + MAX_FUN_PHOTOS + ' photos.' });
            return;
          }
          /* New fun photos cascade in from the top-left. */
          x = 40 + (fun.length % 4) * 280;
          y = 40 + Math.floor(fun.length / 4) * 230;
          const px = cleanNum(body.x, -100, BOARD_W + 100);
          const py = cleanNum(body.y, -100, BOARD_H + 100);
          if (px !== null) x = px;
          if (py !== null) y = py;
        } else {
          /* A corner slot holds one photo: a new one replaces it. */
          const old = data.photos.find(function (ph) { return ph.slot === slot; });
          if (old) {
            unlinkPhoto(old);
            data.photos = data.photos.filter(function (ph) { return ph !== old; });
          }
        }
        const id = data.nextPhotoId++;
        const file = 'photo-' + id + '.' + ext;
        try {
          fs.mkdirSync(PHOTOS_DIR, { recursive: true });
          fs.writeFileSync(photoPath(file), buf);
        } catch (e) {
          sendJson(res, 500, { error: 'Could not save that photo.' });
          return;
        }
        const photo = { id: id, slot: slot, file: file, uploadedAt: Date.now(), x: x, y: y };
        data.photos.push(photo);
        saveData(data);
        sendJson(res, 201, { photo: photo });
      });
      return;
    }
    if (req.method === 'PATCH') {
      readBody(req, function (body) {
        const id = body && cleanId(body.id);
        const photo = id && findPhoto(id);
        if (!photo) { sendJson(res, 404, { error: 'No such photo.' }); return; }
        let touched = false;
        const dims = [['x', -100, BOARD_W + 100], ['y', -100, BOARD_H + 100]];
        for (let i = 0; i < dims.length; i++) {
          const key = dims[i][0];
          if (key in body) {
            const n = cleanNum(body[key], dims[i][1], dims[i][2]);
            if (n === null) { sendJson(res, 400, { error: key + ' is out of range.' }); return; }
            photo[key] = n;
            touched = true;
          }
        }
        if (!touched) { sendJson(res, 400, { error: 'Nothing to update.' }); return; }
        saveData(data);
        sendJson(res, 200, { photo: photo });
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = cleanId(url.searchParams.get('id'));
      const photo = id && findPhoto(id);
      if (!photo) { sendJson(res, 404, { error: 'No such photo.' }); return; }
      unlinkPhoto(photo);
      data.photos = data.photos.filter(function (ph) { return ph.id !== id; });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- The photo files themselves ---- */
  if (p.indexOf('/photos/') === 0) {
    if (req.method === 'GET') {
      const name = path.basename(p);
      const photo = data.photos.find(function (ph) { return ph.file === name; });
      if (!photo) { sendJson(res, 404, { error: 'No such photo.' }); return; }
      fs.readFile(photoPath(name), function (err, buf) {
        if (err) { sendJson(res, 404, { error: 'Photo file is gone.' }); return; }
        const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
        const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(buf);
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (p.indexOf('/api/') === 0) {
    sendJson(res, 404, { error: 'Unknown API route.' });
    return;
  }

  /* static client — just the one file */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(CLIENT_DIR, 'index.html'), function (err, dataBuf) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Client file missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(dataBuf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, function () {
  console.log('Kitchen Whiteboard server listening on port ' + PORT);
});
