# Ryder Pick 'Em

A college football odds board — DraftKings lines only, via [TheRundown API](https://therundown.io/) —
with save-able selections. The API key lives only in `.env` on the server; the browser never sees it.

## Accounts & saved picks

- Click **"Log in to save picks"** in the header to sign up or log in — usernames and passwords only, no
  email required. Passwords are hashed with Node's built-in `scrypt` (never stored in plain text) and kept
  in `data/users.json`, a local file (not committed — see `.gitignore`).
- Logged out (**guest mode**), tapped picks still save fine — to that browser only, via `localStorage` —
  but they can't be "saved to profile" (locked into your record) until you log in.
- Logging in **merges** anything you'd already picked as a guest on that browser into your account, then
  clears the guest copy. From then on, saves go to your account and follow you to any device you log into.
- Sessions are cookie-based (`express-session`) and last 30 days, stored in memory — they reset if you
  restart the server. That's fine for personal/local use; for anything longer-lived or multi-instance, swap
  in a real session store (e.g. `connect-redis`) and a real database instead of the JSON file.
- Set `SESSION_SECRET` in `.env` to a random string (the server will warn you and use an insecure default
  if you don't). Changing it later invalidates all existing sessions.

## Saved Bets tab & deleting picks

- A **"Saved Bets"** tab sits between the odds board and the leaderboard — it lists everything you've
  saved to your profile (locked picks only; anything still sitting unsaved in your slip won't show here).
  Requires being logged in to view/manage, same as saving does.
- Each saved pick can be **deleted, but only while its game hasn't kicked off yet** — once kickoff passes,
  the delete button is replaced with a "Kickoff passed — locked in" note and the pick becomes a permanent
  part of your record (this protects the leaderboard from picks being pulled after the fact).
- This works the same way in the bet slip itself — a locked pick shows a **"Delete pick"** button (with a
  confirmation prompt) instead of a plain remove button, right up until kickoff.
- It's enforced in two places: the UI hides/shows the delete option based on kickoff time, and `server.js`
  double-checks on every save — if a request ever tries to drop a locked pick whose game has already
  started (stale UI, a direct API call, whatever), the server silently restores it rather than letting it
  disappear.
- Games with no known kickoff time (displayed as "Time TBD" on the board) are treated as not-yet-started
  through the end of their listed game day — conservative, so a delete is never blocked incorrectly, but
  also never allowed past a reasonable point either.

## Units, saving picks, and the leaderboard

- Tapping a line adds it to your slip as usual — but it starts out **unsaved**, editable, and doesn't count
  toward your record yet.
- Each ticket in the slip has a **units** field (defaults to 1, adjustable in 0.25 steps) — a relative stake
  for tracking a record, not real money.
- Click **"Save picks to profile"** to lock in every currently-unsaved pick at its current units. Locked
  picks are your official record from then on: their units become fixed, and they can't be removed from the
  slip (only picks you haven't saved yet can be cleared with "Clear unsaved selections").
- Saving requires being logged in — if you click it as a guest, the login/signup modal opens instead.
- Once a saved pick's game has had a few hours to finish, the server checks its final score (see "Grading"
  below) and marks it **win**, **loss**, or **push** — you'll see this reflected as a badge on the ticket
  and in the Leaderboard tab.

### Grading

- `server.js` grades picks by fetching `GET /api/v2/events/{id}` for a saved pick's game once enough time
  has passed since kickoff, and comparing the final score against the pick's market/side/point.
- Final scores are cached permanently in `data/graded-events.json` so a finished game is never re-fetched.
- To respect the same strict rate limit as the odds board, each `/api/leaderboard` request grades at most
  a handful of newly-eligible games (`MAX_EVENTS_TO_GRADE_PER_REQUEST` in `server.js`), spaced out
  (`GRADE_EVENT_SPACING_MS`). If you have a lot of picks awaiting grading, it may take a couple of
  leaderboard loads for everything to settle — that's expected, not a bug.

### Leaderboard

- Public — anyone can view it, no login required (only *saving* picks requires an account).
- Shows each user's record (win-loss, plus pushes if any), win percentage, and total units up/down.
- Units up/down account for the odds: a win at `+150` returns more than a win at `-110` on the same stake;
  a loss always costs exactly the units risked; a push is a wash. Only users with at least one **settled**
  (graded) pick appear.

## How it's structured

```
gridiron-odds-app/
├── server.js        Express server: odds proxy + auth + saved picks. Keys/passwords stay server-side.
├── package.json
├── .env             Your API key + session secret live here (not committed — see .gitignore)
├── data/
│   └── users.json   Local user accounts (hashed passwords + saved picks) — created on first run
├── public/
│   └── index.html   The whole frontend: the board, login/signup modal, bet slip, save/persist logic.
```

## Run it

1. Install [Node.js](https://nodejs.org) 18 or newer (needed for built-in `fetch`).
2. Make sure `.env` has both `RUNDOWN_API_KEY` and `SESSION_SECRET` set (a random one's already filled in —
   change it if you want, just know that changing it later logs everyone out).
3. In this folder:
   ```bash
   npm install
   npm start
   ```
4. Open **http://localhost:3000**

## How the odds are fetched

- **Sport**: NCAAF only — sport ID `1` in TheRundown's system.
- **Book**: DraftKings only — affiliate ID `19`. Every other book is filtered out server-side, and any
  game DraftKings hasn't posted a line for is dropped from the response entirely.
- **Markets**: moneyline, point spread, and total (market IDs `1`, `2`, `3`), main line only.
- `server.js` calls `GET /api/v2/sports/1/events/{date}` once per day for the next 14 days (`DAYS_AHEAD`
  in `server.js`), tags each request with `X-TheRundown-Key`, and merges the results into day-based tabs
  — only days that actually have a DraftKings-priced NCAAF game become a tab.
- TheRundown's V2 response uses `0.0001` as a sentinel for "line pulled off the board" — the server never
  passes that through to the page; it's treated the same as "no line yet."

## How the key stays hidden

- `.env` holds `RUNDOWN_API_KEY=...`. `server.js` reads it with `dotenv` and never sends it to the browser.
- The frontend calls its own server at `/api/odds` — a same-origin, key-free request — and gets back
  already-normalized game objects, ready to render.
- `server.js` is the only thing that ever calls `therundown.io`, attaching the key server-side.
- `.gitignore` excludes `.env`, so if you ever push this to GitHub the key won't go with it.

## Notes

- Responses are cached in memory for 5 minutes (`CACHE_TTL_MS` in `server.js`) so casual page reloads
  don't burn through your daily data-point allowance. `DAYS_AHEAD` controls how many days out it scans —
  each day is a separate billed request, so lower it if you're on a tight free-tier limit.
- If the fetch fails for any reason (bad/expired key, quota exhausted, no NCAAF/DraftKings games currently
  in the scan window), the page automatically falls back to bundled sample odds and says so in the banner
  at the top, so it never just looks broken.
- Kickoff times display as "Time TBD" if TheRundown's response for a given event doesn't include a
  recognizable date/time field — the rest of the odds still render normally.
- Guest selections are stored in the browser only; logged-in picks are stored server-side in
  `data/users.json` and follow you across devices.
- **Deploying this on the internet?** See [`DEPLOY.md`](./DEPLOY.md) — the short version is you need
  persistent storage for the `data/` folder (most hosts wipe local files on redeploy), and `DATA_DIR` in
  `server.js` is configurable via env var specifically to make that easy.
