Set shell = CreateObject("WScript.Shell")

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Users\fksgm\Documents\Codex\2026-04-21-24-https-store-kyobobook-co-kr\start-dashboard.ps1"""

shell.Run command, 0, False
