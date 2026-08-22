require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const RUNDOWN_KEY = process.env.RUNDOWN_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;

const SPORT_ID = 1;                 // NCAAF, per TheRundown's sport ID reference
const DRAFTKINGS_AFFILIATE_ID = '19'; // DraftKings, per TheRundown's affiliate ID reference
const DAYS_AHEAD = 14;              // scan the next 2 weeks for games with DK odds posted
const REQUEST_SPACING_MS = 2000;    // gap between each day's request — your plan allows ~1 req/sec
const MAX_RETRIES = 3;              // retries per date if we still get rate-limited
const RETRY_BACKOFF_MS = 3000;      // base backoff when TheRundown doesn't send a Retry-After header
const GRADE_EVENT_SPACING_MS = 2000;      // same spacing rule applies to score lookups
const MAX_EVENTS_TO_GRADE_PER_REQUEST = 5; // cap per leaderboard load so it doesn't take forever
const GRADE_ELIGIBLE_BUFFER_MS = 4 * 60 * 60 * 1000; // wait 4h past kickoff before checking a score

if (!RUNDOWN_KEY) {
  console.warn(
    '\n[warning] RUNDOWN_API_KEY is not set.\n' +
    'Create a .env file in this folder with:\n  RUNDOWN_API_KEY=your_key_here\n'
  );
}

if (!SESSION_SECRET) {
  console.warn(
    '\n[warning] SESSION_SECRET is not set in .env — using an insecure default.\n' +
    'Add a random string to .env, e.g.:\n  SESSION_SECRET=' + crypto.randomBytes(24).toString('hex') + '\n' +
    '(Changing this value later will log everyone out.)\n'
  );
}

// --- Body parsing + sessions (needed for login/signup and saving picks) ---
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET || 'gridiron-slate-insecure-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// Serve the frontend (public/index.html and friends)
app.use(express.static(path.join(__dirname, 'public')));

// --- User accounts ---------------------------------------------------
// Stored in a local JSON file rather than a database — simple, no extra
// dependency, fine for a personal/local-use app. Passwords are hashed
// with Node's built-in scrypt (no native module to compile), never
// stored or logged in plain text.
// Configurable so a hosting platform's persistent disk (mounted somewhere
// like /var/data) can be pointed at without editing code — see DEPLOY.md.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureUsersFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
}
ensureUsersFile();

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || [];
  } catch (err) {
    console.error('Could not read users.json, starting with an empty user list:', err.message);
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

// --- Graded events (cached final scores) --------------------------------
// Once a game is confirmed final, its score is cached here permanently so
// grading never has to re-fetch it — saves API quota and respects the rate
// limit on repeat leaderboard loads.
const GRADED_EVENTS_FILE = path.join(DATA_DIR, 'graded-events.json');

function ensureGradedEventsFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GRADED_EVENTS_FILE)) fs.writeFileSync(GRADED_EVENTS_FILE, JSON.stringify({ events: {} }, null, 2));
}
ensureGradedEventsFile();

function readGradedEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(GRADED_EVENTS_FILE, 'utf8'));
    return parsed.events ? parsed : { events: {} };
  } catch (err) {
    console.error('Could not read graded-events.json, starting fresh:', err.message);
    return { events: {} };
  }
}

function writeGradedEvents(data) {
  fs.writeFileSync(GRADED_EVENTS_FILE, JSON.stringify(data, null, 2));
}

// In-memory cache so repeated page loads don't burn through your daily
// data-point allowance. College football lines don't need per-second
// freshness for a browsing board — tune CACHE_TTL_MS if you want it
// fresher or cheaper.
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// TheRundown uses 0.0001 as a sentinel for "line is off the board" — never
// display it or do math with it.
function formatPrice(price) {
  if (price === undefined || price === null || price === 0.0001) return null;
  const n = Math.round(price);
  return n > 0 ? `+${n}` : `${n}`;
}

function formatPoint(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n > 0 ? `+${n}` : `${n}`;
}

// American odds -> decimal, e.g. "+150" -> 2.5, "-110" -> 1.909...
function americanToDecimal(priceText) {
  const n = parseInt(priceText, 10);
  if (Number.isNaN(n)) return 2.0;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

function findParticipant(market, matchFn) {
  if (!market || !Array.isArray(market.participants)) return null;
  return market.participants.find(matchFn) || null;
}

// main_line=true means each participant has at most one line object.
function mainLine(participant) {
  if (!participant || !Array.isArray(participant.lines) || participant.lines.length === 0) return null;
  return participant.lines[0];
}

function priceFor(line) {
  if (!line || !line.prices) return null;
  const p = line.prices[DRAFTKINGS_AFFILIATE_ID];
  return p ? formatPrice(p.price) : null;
}

// TheRundown's V2 event objects don't consistently document a single
// kickoff-time field name across sports/plans, so try the plausible ones
// and fall back gracefully rather than guessing wrong.
function extractKickoff(event) {
  const candidates = [event.event_date, event.date_event, event.event_time, event.event_datetime, event.start_date];
  const raw = candidates.find(v => !!v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeEvent(event, dateKey) {
  const markets = event.markets || [];
  const mlMarket = markets.find(m => m.market_id === 1);
  const spreadMarket = markets.find(m => m.market_id === 2);
  const totalMarket = markets.find(m => m.market_id === 3);

  const teams = event.teams || [];
  const awayTeam = teams[0] || {};
  const homeTeam = teams[1] || {};
  const awayName = awayTeam.name || 'Away';
  const homeName = homeTeam.name || 'Home';

  // Market participants link back to teams by numeric id (participant.id
  // === team.team_id), not by matching name strings — team names can be
  // formatted slightly differently between the teams[] array and a given
  // market's participants[], so id matching is what TheRundown's schema
  // actually guarantees. Fall back to name matching only if team_id is
  // ever missing from a response.
  const matchesTeam = (participant, team) => {
    if (team.team_id !== undefined && participant.id !== undefined) {
      return participant.id === team.team_id;
    }
    return participant.name === team.name;
  };

  const awayMlLine = mainLine(findParticipant(mlMarket, p => matchesTeam(p, awayTeam)));
  const homeMlLine = mainLine(findParticipant(mlMarket, p => matchesTeam(p, homeTeam)));

  const awaySpreadLine = mainLine(findParticipant(spreadMarket, p => matchesTeam(p, awayTeam)));
  const homeSpreadLine = mainLine(findParticipant(spreadMarket, p => matchesTeam(p, homeTeam)));

  const overLine = mainLine(findParticipant(totalMarket, p => /over/i.test(p.name)));
  const underLine = mainLine(findParticipant(totalMarket, p => /under/i.test(p.name)));

  const awaySpreadPoint = formatPoint(awaySpreadLine && awaySpreadLine.value);
  const homeSpreadPoint = formatPoint(homeSpreadLine && homeSpreadLine.value);
  const awaySpreadPrice = priceFor(awaySpreadLine);
  const homeSpreadPrice = priceFor(homeSpreadLine);
  const awayMlPrice = priceFor(awayMlLine);
  const homeMlPrice = priceFor(homeMlLine);
  const overPrice = priceFor(overLine);
  const underPrice = priceFor(underLine);

  if (spreadMarket && !awaySpreadLine && !homeSpreadLine) {
    console.warn(
      `[spread mismatch] ${awayName} @ ${homeName} on ${dateKey}: ` +
      `spread market present but no participant matched. ` +
      `teams=${JSON.stringify(teams)} participants=${JSON.stringify(spreadMarket.participants.map(p => ({ id: p.id, name: p.name })))}`
    );
  }

  const kickoff = extractKickoff(event);

  // Raw numeric points (not just the formatted display string) — these get
  // stored on a saved pick so it can be graded against a final score later
  // without re-parsing a display string like "-3.5".
  const awaySpreadPointNum = awaySpreadLine ? Number(awaySpreadLine.value) : null;
  const homeSpreadPointNum = homeSpreadLine ? Number(homeSpreadLine.value) : null;
  const totalPointNum = overLine ? Number(overLine.value) : (underLine ? Number(underLine.value) : null);

  return {
    id: event.event_id || `${dateKey}-${awayName}-${homeName}`,
    dateKey,
    kickoffISO: kickoff ? kickoff.toISOString() : null,
    network: '',
    kickoff: kickoff
      ? kickoff.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'
      : 'Time TBD',
    away: { name: awayName, rank: null, record: '' },
    home: { name: homeName, rank: null, record: '' },
    spread: {
      away: (awaySpreadPoint && awaySpreadPrice) ? `${awaySpreadPoint} ${awaySpreadPrice}` : '— —',
      home: (homeSpreadPoint && homeSpreadPrice) ? `${homeSpreadPoint} ${homeSpreadPrice}` : '— —',
    },
    spreadPoints: { away: awaySpreadPointNum, home: homeSpreadPointNum },
    ml: {
      away: awayMlPrice || '—',
      home: homeMlPrice || '—',
    },
    total: {
      over: (overLine && overPrice) ? `O ${overLine.value} ${overPrice}` : '— —',
      under: (underLine && underPrice) ? `U ${underLine.value} ${underPrice}` : '— —',
    },
    totalPoint: totalPointNum,
    // used to drop games DK hasn't posted any line for yet
    hasDkOdds: !!(awayMlPrice || awaySpreadPrice || overPrice),
  };
}

async function rundownGet(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'X-TheRundown-Key': RUNDOWN_KEY } });

  if (res.status === 429 && attempt <= MAX_RETRIES) {
    // Respect Retry-After if TheRundown sends one, otherwise back off a
    // few seconds and retry this same request before giving up on it.
    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : RETRY_BACKOFF_MS * attempt;
    console.warn(`Rate limited (attempt ${attempt}) — waiting ${waitMs}ms and retrying: ${url}`);
    await sleep(waitMs);
    return rundownGet(url, attempt + 1);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TheRundown responded ${res.status} for ${url}: ${detail.slice(0, 200)}`);
  }

  return res.json();
}

async function fetchDay(dateKey) {
  const url =
    `https://therundown.io/api/v2/sports/${SPORT_ID}/events/${dateKey}` +
    `?market_ids=1,2,3&affiliate_ids=${DRAFTKINGS_AFFILIATE_ID}&main_line=true&hide_closed=true&offset=300`;

  const data = await rundownGet(url);
  return (data.events || [])
    .map(ev => normalizeEvent(ev, dateKey))
    .filter(g => g.hasDkOdds);
}

// Looks up a single event's current score by id, used for grading saved
// picks once their game has had time to finish. Handles a couple of
// plausible response shapes defensively since a single-event payload isn't
// fully pinned down in the public docs.
async function fetchEventScore(eventId) {
  const url = `https://therundown.io/api/v2/events/${eventId}`;
  const data = await rundownGet(url);
  const event = data.event || (Array.isArray(data.events) ? data.events[0] : data);
  return (event && event.score) ? event.score : null;
}

async function buildSchedule() {
  const today = new Date();
  const dateKeys = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    dateKeys.push(isoDate(d));
  }

  // One request per date — each is billed separately by TheRundown. These
  // run sequentially with a gap between them (rather than all at once) to
  // stay under the plan's strict per-second rate limit.
  const results = [];
  for (let i = 0; i < dateKeys.length; i++) {
    try {
      results.push(await fetchDay(dateKeys[i]));
    } catch (err) {
      console.error(err.message);
      results.push([]);
    }
    if (i < dateKeys.length - 1) {
      await sleep(REQUEST_SPACING_MS);
    }
  }

  const weeks = [];
  const games = {};
  dateKeys.forEach((dateKey, i) => {
    const dayGames = results[i];
    if (dayGames.length === 0) return;
    const d = new Date(dateKey + 'T12:00:00Z');
    weeks.push({
      id: dateKey,
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      title: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    });
    games[dateKey] = dayGames;
  });

  return { weeks, games };
}

// If multiple requests hit /api/odds while a build is already in progress
// (two tabs, a page reload, etc), they all await this same promise instead
// of each kicking off their own sequential run — that's what was doubling
// (or worse) the effective request rate against a 1 req/sec plan limit.
let inFlightBuild = null;

app.get('/api/odds', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
      res.set('X-Cache', 'HIT');
      return res.json({ ok: true, source: 'therundown', ...cache.data });
    }

    if (!RUNDOWN_KEY) {
      return res.status(500).json({ ok: false, error: 'Server is missing RUNDOWN_API_KEY. Add it to .env and restart.' });
    }

    if (!inFlightBuild) {
      inFlightBuild = buildSchedule().finally(() => { inFlightBuild = null; });
    }
    const schedule = await inFlightBuild;

    if (schedule.weeks.length === 0) {
      return res.status(200).json({
        ok: false,
        error: `No upcoming NCAAF games with DraftKings odds posted in the next ${DAYS_AHEAD} days.`,
      });
    }

    cache = { data: schedule, fetchedAt: now };
    res.set('X-Cache', 'MISS');
    res.json({ ok: true, source: 'therundown', ...schedule });
  } catch (err) {
    console.error('Error fetching odds:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Grading & leaderboard ----------------------------------------------

// Don't bother checking a score until well after kickoff. Falls back to
// "a day after the game's date" if we don't have an exact kickoff time
// (TheRundown didn't return one, so it displayed as "Time TBD").
function isPickEligibleForGrading(pick, nowMs) {
  if (pick.kickoffISO) {
    const kickoffMs = new Date(pick.kickoffISO).getTime();
    if (!Number.isNaN(kickoffMs)) return nowMs > kickoffMs + GRADE_ELIGIBLE_BUFFER_MS;
  }
  if (pick.dateKey) {
    const dayEndMs = new Date(pick.dateKey + 'T23:59:59Z').getTime();
    return nowMs > dayEndMs + 24 * 60 * 60 * 1000;
  }
  return false;
}

function isEventFinal(score) {
  if (!score || score.event_status === undefined || score.event_status === null) return false;
  const s = String(score.event_status).toUpperCase();
  return s.includes('FINAL') || s.includes('CLOSED') || s.includes('COMPLETE');
}

// Mirrors the frontend's kickoff check — used server-side as a backstop so
// a saved pick can't be deleted (whether by the UI or a raw API call) once
// its game has actually started. Same conservative "Time TBD" fallback:
// treated as not-yet-started through the end of its listed game day.
function isBeforeKickoff(pick, nowMs) {
  if (pick.kickoffISO) {
    const t = new Date(pick.kickoffISO).getTime();
    if (!Number.isNaN(t)) return nowMs < t;
  }
  if (pick.dateKey) {
    const dayEndMs = new Date(pick.dateKey + 'T23:59:59Z').getTime();
    return nowMs < dayEndMs;
  }
  return false;
}

// Determines win/loss/push for one saved pick against a final score.
// Returns null if it can't be graded (missing data) — left pending.
function gradePickOutcome(pick, score) {
  const awayScore = Number(score.score_away);
  const homeScore = Number(score.score_home);
  if (Number.isNaN(awayScore) || Number.isNaN(homeScore)) return null;

  if (pick.market === 'ml') {
    if (awayScore === homeScore) return 'push';
    const awayWon = awayScore > homeScore;
    return ((pick.side === 'away') === awayWon) ? 'win' : 'loss';
  }

  if (pick.market === 'spread') {
    if (typeof pick.point !== 'number' || Number.isNaN(pick.point)) return null;
    if (pick.side === 'away') {
      const adjusted = awayScore + pick.point;
      if (adjusted === homeScore) return 'push';
      return adjusted > homeScore ? 'win' : 'loss';
    }
    if (pick.side === 'home') {
      const adjusted = homeScore + pick.point;
      if (adjusted === awayScore) return 'push';
      return adjusted > awayScore ? 'win' : 'loss';
    }
    return null;
  }

  if (pick.market === 'total') {
    if (typeof pick.point !== 'number' || Number.isNaN(pick.point)) return null;
    const total = awayScore + homeScore;
    if (total === pick.point) return 'push';
    if (pick.side === 'over') return total > pick.point ? 'win' : 'loss';
    if (pick.side === 'under') return total < pick.point ? 'win' : 'loss';
    return null;
  }

  return null;
}

// Fetches a handful of still-ungraded games' scores (spaced out to respect
// the rate limit), caches any that are final, then applies every cached
// score to matching pending picks across all users.
async function runGradingSweep() {
  const users = readUsers();
  const gradedEvents = readGradedEvents();
  const now = Date.now();

  const pendingGameIds = new Set();
  users.forEach(user => {
    Object.values(user.picks || {}).forEach(pick => {
      if (!pick.locked || pick.status !== 'pending') return;
      if (gradedEvents.events[pick.gameId]) return; // already cached, no fetch needed
      if (!isPickEligibleForGrading(pick, now)) return;
      pendingGameIds.add(pick.gameId);
    });
  });

  const toFetch = Array.from(pendingGameIds).slice(0, MAX_EVENTS_TO_GRADE_PER_REQUEST);

  for (let i = 0; i < toFetch.length; i++) {
    const gameId = toFetch[i];
    try {
      const score = await fetchEventScore(gameId);
      if (score && isEventFinal(score)) {
        gradedEvents.events[gameId] = {
          score_away: score.score_away,
          score_home: score.score_home,
          gradedAt: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.error(`Could not fetch score for event ${gameId}:`, err.message);
    }
    if (i < toFetch.length - 1) await sleep(GRADE_EVENT_SPACING_MS);
  }

  if (toFetch.length > 0) writeGradedEvents(gradedEvents);

  // Apply every cached final score (from this sweep or earlier ones) to
  // any matching pending pick that hasn't been settled yet.
  let changed = false;
  users.forEach(user => {
    Object.values(user.picks || {}).forEach(pick => {
      if (!pick.locked || pick.status !== 'pending') return;
      const cached = gradedEvents.events[pick.gameId];
      if (!cached) return;
      const outcome = gradePickOutcome(pick, cached);
      if (outcome) {
        pick.status = outcome;
        pick.settledAt = new Date().toISOString();
        changed = true;
      }
    });
  });
  if (changed) writeUsers(users);

  return users;
}

function computeLeaderboard(users) {
  const rows = users
    .map(user => {
      let wins = 0, losses = 0, pushes = 0, totalUnits = 0, settledCount = 0;
      Object.values(user.picks || {}).forEach(pick => {
        if (!pick.locked || pick.status === 'pending') return;
        settledCount++;
        const units = Number(pick.units) > 0 ? Number(pick.units) : 1;
        if (pick.status === 'win') {
          totalUnits += units * (americanToDecimal(pick.priceText) - 1);
          wins++;
        } else if (pick.status === 'loss') {
          totalUnits -= units;
          losses++;
        } else if (pick.status === 'push') {
          pushes++;
        }
      });
      const decided = wins + losses;
      return {
        username: user.username,
        wins, losses, pushes,
        winPct: decided > 0 ? (wins / decided) * 100 : null,
        totalUnits: Math.round(totalUnits * 100) / 100,
        settledCount,
      };
    })
    .filter(r => r.settledCount > 0);

  rows.sort((a, b) => b.totalUnits - a.totalUnits);
  return rows;
}

// --- Auth routes -------------------------------------------------------

app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = String(username || '').trim();

  if (!cleanUsername || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }
  if (cleanUsername.length < 3 || cleanUsername.length > 32) {
    return res.status(400).json({ ok: false, error: 'Username must be 3–32 characters.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  }

  const users = readUsers();
  if (users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
    return res.status(409).json({ ok: false, error: 'That username is already taken.' });
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username: cleanUsername,
    salt,
    hash,
    picks: {},
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);

  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password are required.' });
  }

  const users = readUsers();
  const user = users.find(u => u.username.toLowerCase() === String(username).trim().toLowerCase());

  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
  }

  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const users = readUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: publicUser(user) });
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  next();
}

// --- Saved picks (per account) -----------------------------------------

app.get('/api/picks', requireAuth, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'Not logged in.' });
  res.json({ ok: true, picks: user.picks || {} });
});

app.put('/api/picks', requireAuth, (req, res) => {
  const { picks: incoming } = req.body || {};
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return res.status(400).json({ ok: false, error: '"picks" must be an object.' });
  }

  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.session.userId);
  if (idx === -1) return res.status(401).json({ ok: false, error: 'Not logged in.' });

  // Backstop for the "can only delete before kickoff" rule: if the incoming
  // set is missing a pick that was locked and whose game has already
  // started, restore it rather than letting it quietly disappear. Covers
  // stale UI state or a direct API call, not just the normal button flow.
  const existing = users[idx].picks || {};
  const now = Date.now();
  const merged = { ...incoming };
  let restored = 0;

  Object.entries(existing).forEach(([key, pick]) => {
    if (pick.locked && !merged[key] && !isBeforeKickoff(pick, now)) {
      merged[key] = pick;
      restored++;
    }
  });

  users[idx].picks = merged;
  writeUsers(users);

  if (restored > 0) {
    console.warn(`Blocked deletion of ${restored} saved pick(s) past kickoff for user ${users[idx].username}`);
  }

  res.json({ ok: true, picks: merged });
});

// --- Leaderboard (public — no login needed to view) ---------------------

let inFlightGrading = null;

app.get('/api/leaderboard', async (req, res) => {
  try {
    // Same overlap guard as /api/odds — don't let simultaneous requests
    // each kick off their own grading sweep against the rate limit.
    if (!inFlightGrading) {
      inFlightGrading = runGradingSweep().finally(() => { inFlightGrading = null; });
    }
    const users = await inFlightGrading;
    res.json({ ok: true, rows: computeLeaderboard(users) });
  } catch (err) {
    console.error('Error building leaderboard:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ryder Pick 'Em running at http://localhost:${PORT}`);
});
