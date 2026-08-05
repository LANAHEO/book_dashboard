# Deployment Guide

This app can be deployed to a public URL.

## Recommended options

### Railway

Best fit if you want a public URL with a service that stays running.

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from the GitHub repo.
3. Railway can deploy this app from the included `Dockerfile`, or with the Streamlit start command.
4. Confirm the service starts with `streamlit run streamlit_app.py`.
5. Open the generated public domain.

## Render

Use this if you want a simple managed deploy flow with Blueprint support.

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint from the repo.
3. Render will read `render.yaml`.
4. Deploy the web service.
5. Open the generated `onrender.com` URL.

Note: `render.yaml` uses the `free` plan. Render Free web services spin down after 15 minutes without inbound traffic and can take about 1 minute to spin back up.

## Custom domain

After the first deploy succeeds:

1. Open the service settings on your hosting platform.
2. Add your custom domain.
3. Point your DNS records to the target shown by the platform.

## Runtime requirements

- Python 3.12 or newer
- Dependencies are installed from `requirements.txt`
- The app binds to `0.0.0.0`
- Streamlit exposes `/_stcore/health` for health checks
