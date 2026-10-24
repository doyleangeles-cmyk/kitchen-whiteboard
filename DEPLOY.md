# Kitchen Whiteboard: Deploy Notes

A shared family whiteboard. The server serves the page and keeps the
board behind a small JSON API; every visitor reads and writes the
same server-side data, so the whole family sees one board.

## Status (2026-10-23)

Built and fully verified **locally** (test suites 44/44 — API +
classifier — plus live smoke tests: seeded board renders, add +
check + delete work, quantity/brand save, state survives a server
restart). **Not yet deployed** — creating
the GitHub repo and the Render service needs the account owner's
logged-in browser (the VM has no GitHub credentials: `gh` is not
logged in and SSH to GitHub is blocked by the network proxy). The
remaining steps below take about five minutes, mirroring exactly
how `gas-leak-sheet` was deployed.

## Finish the deploy (owner, in browser)

1. **Create the GitHub repo.** On github.com (account
   `doyleangeles-cmyk`): New repository, name `kitchen-whiteboard`,
   no README/.gitignore (the project already has them). Or from a
   machine with `gh` logged in: `gh repo create kitchen-whiteboard
   --public --source . --push` from this folder.
2. **Push this folder** (a git repo is already initialized here,
   branch `main`):
   - `git add -A && git commit -m "Kitchen Whiteboard"`
   - `git remote add origin https://github.com/doyleangeles-cmyk/kitchen-whiteboard.git`
   - `git push -u origin main`
   (or upload the files through the GitHub web UI, same as the other
   projects).
3. **Create the Render service.** On dashboard.render.com: New →
   Web Service → connect the `kitchen-whiteboard` repo.
   - Runtime: Node
   - Build command: leave default (`npm install` is harmless — there
     are no dependencies)
   - Start command: `npm start`
   - Instance type: Free
   - Name it `kitchen-whiteboard` and the URL becomes
     `https://kitchen-whiteboard.onrender.com`
4. **Smoke test** (below) on the live URL, then share the link with
   the family.

## Runtime

- **Node.js >= 18** (per `package.json` engines; developed/tested on
  Node 24).
- **No dependencies.** Nothing to install.
- **Start command:** `npm start` (equivalently `node server/server.js`).
- **Port:** the `PORT` environment variable, default **8080**.
  Render supplies `PORT` itself.

## Data persistence

- Everything persists to **`server/data/data.json`** (rewritten
  atomically on every change). On first boot the file is seeded with
  the physical kitchen board's contents as photographed 2026-10-23
  (Groceries ×7, Chores ×3, Misc. empty); after that the family
  manages the board in the app and the seed never overwrites it.
  (`DATA_FILE` env var can point storage elsewhere; used by tests.)
- **Free-tier caveat (same as the Gas Leak Sheet app):** Render's
  free tier has an ephemeral filesystem and spins the service down
  when idle. The board survives normal use and page reloads while
  the service is up, but a redeploy — and sometimes a spin-down
  restart — can reset `data.json` back to the seed. First load after
  idle can also take up to a minute while the service wakes. To make
  the board permanent, attach a Render persistent disk mounted at
  `server/data/` (paid) or move storage to a hosted database.

## API

- `GET /api/board` — every item: `{id, column, text, done, detail,
  brand}` (`detail` is the quantity/note, `brand` the saved brand
  preference; both may be empty strings).
- `POST /api/items` — add one (`{column, text}`; column is
  `groceries`, `misc`, or `chores`).
- `PATCH /api/items` — update one: check/uncheck (`{id, done}`),
  set/clear the quantity/note (`{id, detail}`), set/clear the brand
  (`{id, brand}`); fields can be combined.
- `DELETE /api/items?id=N` — remove one.
- `POST /api/clear-checked` — remove all checked items in a column
  (`{column}`).

There are no accounts by design: anyone with the link can edit.
Item text is capped at 120 characters, detail/brand at 60, and text
is HTML-escaped in the client.

## Layout

- `client/index.html` — the app (single file): three whiteboard
  columns with per-column add box, ✎ quantity/note edit, and Clear
  checked button; quiet auto-refresh every 20s so family edits show
  up. The 🛒 Shop view groups groceries by store section in
  store-flow order (keyword classifier in the page, exercised by
  `test/test-classify.js`) and offers brand-preference chips per
  item from a small built-in brand map.
- `server/server.js` — static serving + the JSON API.
- `server/data/data.json` — the data file (seeded on first boot).
- `test/test-api.js`, `test/test-classify.js` — test suites:
  `npm test`.

## Smoke test after deploying

1. Open the site — three columns: Groceries with Eggs, Sauces
   (Zesty, Asian, BBQ), Mayo, Black Pepper, Frozen Avocados — No
   Guac, Tomatoes, Bananas; Chores with Put Dishes UP!, Run
   Dishwasher, Shampoo dog; Misc. empty.
2. Add an item from a phone, check it off on a second device, and
   confirm both see the same board.
3. Reload — the checked item is still there, still checked.
4. Tap 🛒 Shop, pick a store: groceries should appear grouped in
   store order (Produce first … Sauces & Condiments last for the
   seeded list), and tapping a brand chip on Mayo (e.g. Best Foods)
   should still show on the item back on the board.
