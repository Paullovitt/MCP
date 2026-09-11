@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Parar MCP
cd /d "%~dp0"
set "ROOT=%CD%"
set "PATH=%ROOT%;%PATH%"
set "MCP_NO_PAUSE=1"

rem Usa o mesmo protocolo de parada normal do iniciador compativel.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\stop-server.ps1" -ProjectRoot "%ROOT%"
set "SERVER_RESULT=%ERRORLEVEL%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$config=Get-ChildItem -LiteralPath 'C:\Cloudflared' -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.yml','.yaml' -and (Select-String -LiteralPath $_.FullName -SimpleMatch 'hostname: mcp2.luckytrevo.com' -Quiet) } | Select-Object -First 1 -ExpandProperty FullName; " ^
  "if(-not $config){ Write-Error 'Nenhum YAML do Cloudflare possui a rota mcp2.luckytrevo.com.'; exit 2 }; " ^
  "$tunnels=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like ('*'+$config+'*') }); " ^
  "foreach($tunnel in $tunnels){ Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2; " ^
  "$remaining=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like ('*'+$config+'*') }); " ^
  "$port=@(Get-NetTCPConnection -State Listen -LocalPort 4194 -ErrorAction SilentlyContinue); " ^
  "if($remaining.Count -gt 0 -or $port.Count -gt 0){ Write-Error 'Ainda existe processo ou porta ativa.'; exit 1 }; " ^
  "Write-Host ''; Write-Host 'MCP e tunel deste computador parados com sucesso.' -ForegroundColor Green; Write-Host 'Porta 4194 livre.'"
set "CHECK_RESULT=%ERRORLEVEL%"

if not "%SERVER_RESULT%"=="0" set "CHECK_RESULT=%SERVER_RESULT%"
if not "%CHECK_RESULT%"=="0" (
  echo Nao foi possivel confirmar o desligamento completo.
  timeout /t 8 /nobreak >nul
  exit /b %CHECK_RESULT%
)

echo Esta janela fechara automaticamente.
timeout /t 3 /nobreak >nul
exit /b 0
