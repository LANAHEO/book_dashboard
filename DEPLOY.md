# Deployment Guide

This is a plain Node.js app with no build step and no runtime dependencies.

Live URL: <https://book-dashboard-q25v.onrender.com/>

## Render (current deployment)

The live service builds from the included `Dockerfile` and redeploys when
`main` is updated.

1. Push changes to the GitHub repository `LANAHEO/book_dashboard`.
2. Render picks up the commit (`Auto-Deploy` must stay on).
3. Open <https://book-dashboard-q25v.onrender.com/>.

If a push does not trigger a build, check
**Settings → Build & Deploy → Auto-Deploy**, or use
**Manual Deploy → Deploy latest commit**.

Notes about the `free` plan:

- The service spins down after 15 minutes without traffic and takes about a
  minute to wake up.
- Prefer Supabase snapshots for cold starts: set `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY`, then run `supabase/schema.sql`. Without those
  keys the app falls back to `.cache/rankings`, which does not survive a
  restart.
- Keep the `Dockerfile`. Removing it breaks the Render build even though
  `render.yaml` says `runtime: node`.

Collect intervals (aligned to bookstore update cadence):

- Realtime lists: every 60 minutes
- Daily / weekly / monthly lists: every 6 hours

## Railway

An alternative if you want a service that stays running.

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from the GitHub repo.
3. Railway can deploy from `package.json` or from the included `Dockerfile`.
4. Confirm the service starts with `npm start`.
5. Open the generated public domain.

## Custom domain

After the first deploy succeeds:

1. Open the service settings on your hosting platform.
2. Add your custom domain.
3. Point your DNS records to the target shown by the platform.

## Running locally

```powershell
npm start
```

Or on Windows: `start-dashboard.cmd`. The dashboard listens on
<http://localhost:3000>.

To expose a local instance through Cloudflare Tunnel instead of hosting,
see [CLOUDFLARE_TUNNEL_SETUP.md](CLOUDFLARE_TUNNEL_SETUP.md).

## Runtime requirements

- Node.js 20 or newer
- No dependencies to install; `npm install` exists only to satisfy build steps
- The app binds to `0.0.0.0` and honours the `PORT` environment variable
- Health check path is `/api/health`
