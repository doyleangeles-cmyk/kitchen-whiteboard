'use strict';

/* Kitchen Whiteboard — standalone server.
 *
 * Mirror of the Gas Leak Sheet standalone pattern: this server does
 * three jobs:
 *   1. Serve the static client (client/index.html — the whole app).
 *   2. Keep the whiteboard contents (server/data/data.json): one flat
 *      list of items, each belonging to one of the three columns
 *      (groceries, misc, chores), with text and a done flag.
 *   3. Expose that data behind a small JSON API (/api/board,
 *      /api/items, /api/clear-checked) with basic sanity checks on
 *      writes, because this sits on the public internet with no
 *      logins — anyone with the link can edit the board, by design.
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
const MAX_BODY = 32 * 1024;

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

function seedData() {
  const items = SEED_ITEMS.map(function (pair, i) {
    return { id: i + 1, column: pair[0], text: pair[1], done: false, detail: '', brand: '' };
  });
  return { nextItemId: items.length + 1, items: items };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.items)) return seedData();
    if (typeof d.nextItemId !== 'number') d.nextItemId = d.items.length + 1;
    d.items = d.items.filter(function (it) {
      return it && COLUMNS.indexOf(it.column) !== -1 && typeof it.text === 'string';
    });
    d.items.forEach(function (it) {
      if (typeof it.done !== 'boolean') it.done = false;
      if (typeof it.detail !== 'string') it.detail = '';
      if (typeof it.brand !== 'string') it.brand = '';
    });
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

/* ================= Validation helpers ================= */

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().slice(0, maxLen);
  return cleaned.length ? cleaned : null;
}

function cleanColumn(v) {
  return COLUMNS.indexOf(v) !== -1 ? v : null;
}

function cleanId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function findItem(id) {
  return data.items.find(function (it) { return it.id === id; }) || null;
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
      sendJson(res, 200, { items: data.items });
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
        const text = body && cleanText(body.text, 120);
        if (!column) { sendJson(res, 400, { error: 'Unknown column.' }); return; }
        if (!text) { sendJson(res, 400, { error: 'Item text is required.' }); return; }
        const item = { id: data.nextItemId++, column: column, text: text, done: false, detail: '', brand: '' };
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
