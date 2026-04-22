@echo off
setlocal

if "%CLOUDFLARE_TUNNEL_TOKEN%"=="" (
  echo CLOUDFLARE_TUNNEL_TOKEN environment variable is not set.
  echo.
  echo 1. Create a Cloudflare Tunnel for www.lana-bookdashboard.com
  echo 2. Copy the tunnel token from Cloudflare
  echo 3. Run: setx CLOUDFLARE_TUNNEL_TOKEN "YOUR_TOKEN"
  echo 4. Open a new terminal and run this script again
  exit /b 1
)

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared is not installed or not on PATH.
  echo Install it first, then run this script again.
  exit /b 1
)

call "%~dp0start-dashboard.cmd"
if errorlevel 1 exit /b 1

echo Starting Cloudflare Tunnel for public access...
cloudflared tunnel run --token "%CLOUDFLARE_TUNNEL_TOKEN%"
