# Deploying Ryder Pick 'Em

## The one thing every option needs: persistent storage

This app stores accounts, saved picks, and graded-game scores in local files
(`data/users.json`, `data/graded-events.json`). Most hosting platforms wipe
the filesystem on every restart or redeploy — **unless** you attach a
persistent disk/volume. Without one, every account and saved pick would be
erased the next time the app restarts. Every option below covers how to set
that up.

`server.js` now reads the data folder location from a `DATA_DIR` environment
variable (falling back to `./data` if unset), so you just point it at
wherever your host mounts persistent storage — no code changes needed.

You'll also need a **GitHub repo** for most of these (they deploy by
connecting to your repo and redeploying on every push) — if you don't have
one yet: create a repo, `git init`, commit this folder (`.env` and `data/`
are already git-ignored, so your key and any local accounts won't leak),
and push it.

---

## Option 1: Render (recommended starting point)

Straightforward git-push deploys, free automatic HTTPS, a real persistent
disk option, and a low, predictable monthly cost for an always-on small app.

1. Push this project to a GitHub repo.
2. Create a [Render](https://render.com) account and connect your GitHub.
3. New → Web Service → pick your repo.
4. Either let Render read `render.yaml` (included in this project — it
   pre-fills the build/start commands and the persistent disk) or configure
   manually:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Environment variables**: add `RUNDOWN_API_KEY`, `SESSION_SECRET`, and
     `DATA_DIR=/var/data` in the dashboard (never upload `.env` itself)
   - **Disk**: add a persistent disk, mount path `/var/data`, 1 GB is
     plenty to start
5. Deploy. Render gives you a free `*.onrender.com` URL immediately; a
   custom domain can be attached afterward under Settings → Custom Domains
   (also free, with automatic HTTPS).

Render's free web-service tier exists but spins down after idle periods
(slow "cold start" on the next visit) — for an always-on app, their
smallest paid tier is the realistic choice. **Pricing changes often — check
Render's current pricing page before committing**, both for the web service
tier and the per-GB disk cost.

## Option 2: Railway

Very similar developer experience to Render — connect a GitHub repo, it
builds and deploys automatically. Add a **volume** in the service settings,
mount it at `/var/data`, and set `DATA_DIR=/var/data` the same way. Railway
bills usage-based rather than a flat monthly tier; a small always-on Node
app like this one is inexpensive but not free long-term. Check Railway's
current pricing page for exact numbers.

## Option 3: A VPS (DigitalOcean, Hetzner, Linode, etc.)

More setup, more control, and often the cheapest option if you're
comfortable with basic server administration:

1. Spin up the smallest Ubuntu droplet/instance (~$4-6/month range,
   varies by provider).
2. Install Node.js 18+, clone your repo, `npm install`.
3. Since the VPS's disk is naturally persistent already, you can just leave
   `DATA_DIR` unset — no separate volume needed.
4. Run the app with a process manager so it survives reboots and restarts
   automatically, e.g. [`pm2`](https://pm2.keymetrics.io/):
   ```bash
   npm install -g pm2
   pm2 start server.js --name ryder-pick-em
   pm2 save
   pm2 startup   # follow its printed instructions to enable on boot
   ```
5. Put [Caddy](https://caddyserver.com/) or Nginx + Certbot in front of it
   as a reverse proxy for automatic free HTTPS on your domain, forwarding
   to `localhost:3000`.

This is more manual work but gives you full control and is often the
cheapest way to keep this running indefinitely.

---

## After deploying, regardless of platform

- **Rotate your API key and session secret** before going live if either
  has been shared anywhere outside your own machine (chat logs, screen
  shares, etc.) — treat any key that's been visible elsewhere as
  compromised.
- **Custom domain**: all three options above support attaching one, with
  free automatic HTTPS via Let's Encrypt (handled for you on Render/Railway;
  manual with Caddy/Certbot on a VPS).
- **This app runs as a single instance** — the odds-fetch and
  grading-sweep locks, and the session store, are all in-memory and assume
  one process. That's fine for personal/small-group use; don't scale it to
  multiple instances without further changes.
