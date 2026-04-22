# Deployment Guide

This app can be deployed to a public URL.

## Recommended options

### Railway

Best fit if you want a public URL with a service that stays running.

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from the GitHub repo.
3. Railway can deploy this app directly from `package.json`, or from the included `Dockerfile`.
4. Confirm the service starts with `npm start`.
5. Open the generated public domain.

## Render

Use this if you want a simple managed deploy flow with Blueprint support.

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint from the repo.
3. Render will read `render.yaml`.
4. Deploy the web service.
5. Open the generated `onrender.com` URL.

Note: `render.yaml` uses the `starter` plan because Render free web services spin down after idle time.

## Custom domain

After the first deploy succeeds:

1. Open the service settings on your hosting platform.
2. Add your custom domain.
3. Point your DNS records to the target shown by the platform.

## Runtime requirements

- Node.js 20 or newer
- The app binds to `0.0.0.0`
- The app exposes `/api/health` for health checks
