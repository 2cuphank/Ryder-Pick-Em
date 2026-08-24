# Deploying Ryder Pick 'Em

## Storage: a free Upstash Redis database, not local files

Accounts, saved picks, and cached final scores all live in a small [Upstash](https://upstash.com) Redis
database rather than local files — 256MB and 500,000 commands/month on their free tier, no credit card, no
expiration. That means **the app itself doesn't need any persistent disk at all**, and can run on a host's
free compute tier.

### Set up the database (2 minutes, one-time)

1. Go to [upstash.com](https://upstash.com), sign up (no card needed), and create a Redis database — pick
   any region close to your host.
2. On the database's page, find the **REST API** section — you need the two values shown there:
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Put both in `.env` locally, and set both as environment variables on whatever host you deploy to (never
   commit them — `.env` is already git-ignored).

Without these two values set, the app still runs, but nothing persists — every account and pick would be
gone on the next restart, same as the old ephemeral-local-file problem this replaces.

You'll also need a **GitHub repo** for most hosting options below (they deploy by connecting to your repo
and redeploying on every push) — if you don't have one yet: create a repo, `git init`, commit this folder,
and push it.

---

## Option 1: Render (recommended starting point)

Straightforward git-push deploys, free automatic HTTPS, and — since storage is now external — **this can
run entirely on Render's free web-service tier**.

1. Push this project to a GitHub repo.
2. Create a [Render](https://render.com) account and connect your GitHub.
3. New → Web Service → pick your repo. Either let Render read `render.yaml` (included — pre-fills the
   build/start commands and lists the required env var names) or configure manually:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Environment variables**: `RUNDOWN_API_KEY`, `SESSION_SECRET`, `UPSTASH_REDIS_REST_URL`,
     `UPSTASH_REDIS_REST_TOKEN`, and optionally `ADMIN_USERNAME`
4. Deploy. You get a free `*.onrender.com` URL immediately; a custom domain can be attached afterward
   under Settings → Custom Domains (also free, with automatic HTTPS).

Render's free tier spins down after ~15 minutes idle, so the first request after a quiet period takes a
few extra seconds to wake back up — normal and harmless for a small personal app. If that cold-start delay
ever bothers you, Render's cheapest paid tier removes it, but nothing about your data or setup needs to
change either way, since storage no longer depends on the compute tier at all.

## Option 2: Railway

Same idea — connect a GitHub repo, it builds and deploys automatically. Add the same four (or five) env
vars in the service's Variables tab. No volume needed anymore, so Railway's free trial credit or smallest
paid tier both work fine.

## Option 3: A VPS (DigitalOcean, Hetzner, Linode, etc.)

More setup, more control:

1. Spin up the smallest Ubuntu droplet/instance.
2. Install Node.js 18+, clone your repo, `npm install`.
3. Set the env vars (`RUNDOWN_API_KEY`, `SESSION_SECRET`, `UPSTASH_REDIS_REST_URL`,
   `UPSTASH_REDIS_REST_TOKEN`, `ADMIN_USERNAME`) — e.g. in a `.env` file on the server, or via your
   process manager's environment config.
4. Run the app with a process manager so it survives reboots, e.g. [`pm2`](https://pm2.keymetrics.io/):
   ```bash
   npm install -g pm2
   pm2 start server.js --name ryder-pick-em
   pm2 save
   pm2 startup   # follow its printed instructions to enable on boot
   ```
5. Put [Caddy](https://caddyserver.com/) or Nginx + Certbot in front of it for automatic free HTTPS,
   forwarding to `localhost:3000`.

---

## Conserving TheRundown API credits

TheRundown runs on a prepaid credit balance, not just a per-second rate limit — a `429` response can mean
either. If your logs show `"prepaid credit balance is insufficient"`, that's a billing issue on your
TheRundown account (check therundown.io's dashboard for adding funds), not a bug in the app; retrying does
nothing until the balance is topped up.

Three env vars let you dial down usage without touching code:

- **`RUNDOWN_DAYS_AHEAD`** (default `14`) — how many days out the odds board scans. Each day is a
  separate billed request, so this is the single biggest lever. Try `7` to roughly halve the cost of every
  odds refresh.
- **`RUNDOWN_CACHE_MINUTES`** (default `5`) — how long a fetched odds schedule is reused before the next
  request re-fetches it. Raising this (e.g. to `30` or `60`) directly cuts how often those `DAYS_AHEAD`
  requests get made at all.
- **`RUNDOWN_MIN_GAP_MS`** (default `2500`) — minimum gap enforced between any two requests to TheRundown,
  from anywhere in the app (both the odds board and the leaderboard's score-grading sweep share this same
  gate). Widen this if you're seeing genuine rate-limit 429s (not the credit-balance kind).

## After deploying, regardless of platform

- **Rotate your API key and session secret** before going live if either has been shared anywhere outside
  your own machine (chat logs, screen shares, etc.) — treat any key that's been visible elsewhere as
  compromised. The same goes for your Upstash REST token once it's been set up.
- **Custom domain**: supported on all options above, with free automatic HTTPS via Let's Encrypt (handled
  for you on Render/Railway; manual with Caddy/Certbot on a VPS).
- **This app runs as a single instance** — the odds-fetch and grading-sweep overlap guards are in-memory
  and assume one process. That's fine for personal/small-group use; don't scale it to multiple instances
  without further changes. (Sessions, accounts, and picks themselves are safe either way now, since those
  live in Redis rather than in-memory or on local disk.)
