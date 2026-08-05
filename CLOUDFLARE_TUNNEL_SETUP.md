# Cloudflare Tunnel Setup

This project can be exposed publicly without paying for app hosting.

What you still pay for:

- Your domain registration for `lana-bookdashboard.com`

What can stay free:

- Cloudflare account
- Cloudflare Tunnel
- Running the app on your current PC

## What this means

This dashboard is not a static site. It needs the local Node server in
[server.js](server.js) to stay running.

So the cost-minimal setup is:

1. Buy `lana-bookdashboard.com` from any registrar.
2. Add the domain to Cloudflare and switch the nameservers to Cloudflare.
3. Create a Cloudflare Tunnel that points `www.lana-bookdashboard.com` to `http://localhost:3000`.
4. Run this dashboard on your PC.
5. Run `cloudflared` on your PC so Cloudflare can proxy traffic to the dashboard.

If your PC is off, the public site will also be off.

## Recommended public URL

- `https://www.lana-bookdashboard.com/main`

The app already supports `/main`.

## Cloudflare dashboard steps

1. Sign in to Cloudflare.
2. Add `lana-bookdashboard.com` as a site.
3. Update your registrar nameservers to the pair Cloudflare gives you.
4. In Cloudflare Zero Trust, go to `Networks` > `Tunnels`.
5. Create a tunnel.
6. Add a published application route:
   - Hostname: `www`
   - Domain: `lana-bookdashboard.com`
   - Service type: `HTTP`
   - Service URL: `http://localhost:3000`
7. Copy the tunnel token shown by Cloudflare.

## Install cloudflared on Windows

Official docs:

- https://developers.cloudflare.com/tunnel/setup/

After installing, open a new terminal and confirm:

```powershell
cloudflared --version
```

## Fast local run

Set your tunnel token once:

```powershell
setx CLOUDFLARE_TUNNEL_TOKEN "YOUR_TUNNEL_TOKEN"
```

Then open a new terminal and run:

```powershell
.\start-public-dashboard.cmd
```

This will:

1. Start the local dashboard server.
2. Start the Cloudflare Tunnel.

## Always-on startup on this PC

If you want this PC to publish the site automatically whenever Windows starts:

1. Keep the existing dashboard auto-start.
2. Install the tunnel as a Windows service:

```powershell
cloudflared service install YOUR_TUNNEL_TOKEN
```

Run that command in an administrator terminal.

After that, `cloudflared` will reconnect automatically after restart.

## Important notes

- Domain registration is not free.
- Cloudflare Tunnel can be free.
- You do not need Render or Railway if you are okay with the site depending on your PC.
- Anyone who visits the public URL will use your PC as the origin.
- If your home or office network changes or blocks tunnel traffic, the public site can stop working.

## Official references

- Cloudflare Tunnel setup: https://developers.cloudflare.com/tunnel/setup/
- Cloudflare Tunnel dashboard flow: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/
