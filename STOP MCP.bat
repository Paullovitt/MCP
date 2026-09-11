@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Parar MCP
cd /d "%~dp0"
set "ROOT=%CD%"
set "PATH=%ROOT%;%PATH%"
set "MCP_NO_PAUSE=1"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=[IO.Path]::GetFullPath('%ROOT%'); $runtimePath=Join-Path $root 'data\runtime.json'; $configPath=Join-Path $root 'data\config.json'; " ^
  "$runtime=$null; if(Test-Path -LiteralPath $runtimePath){try{$runtime=Get-Content -Raw -LiteralPath $runtimePath|ConvertFrom-Json}catch{}}; " ^
  "$config=$null; if(Test-Path -LiteralPath $configPath){try{$config=Get-Content -Raw -LiteralPath $configPath|ConvertFrom-Json}catch{}}; " ^
  "$connection=Get-NetTCPConnection -State Listen -LocalPort 4194 -ErrorAction SilentlyContinue|Select-Object -First 1; " ^
  "if(-not $connection){if(Test-Path -LiteralPath $runtimePath){Remove-Item -LiteralPath $runtimePath -Force}; Write-Host 'MCP ja estava parado.'; exit 0}; " ^
  "$pidValue=[int]$connection.OwningProcess; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pidValue) -ErrorAction SilentlyContinue; " ^
  "$runtimeMatches=$runtime -and [int]$runtime.pid -eq $pidValue -and [int]$runtime.port -eq 4194 -and [IO.Path]::GetFullPath([string]$runtime.projectRoot) -eq $root; " ^
  "$commandMatches=$proc -and ([string]$proc.Name -match '^node(\.exe)?$') -and ([string]$proc.CommandLine).IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0; " ^
  "$identityMatches=$false; try{$status=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/api/status' -TimeoutSec 3; $identityMatches=$commandMatches -and $config -and $status.service -eq 'mcp-worker-coordinator' -and [string]$status.installId -eq [string]$config.INSTALL_ID}catch{}; " ^
  "if(-not (($runtimeMatches -and $commandMatches) -or $identityMatches)){Write-Error ('A porta 4194 pertence a outro processo. PID='+$pidValue+'. Nada foi encerrado.'); exit 2}; " ^
  "Write-Host ('Encerrando MCP Worker Coordinator PID '+$pidValue+'...'); Stop-Process -Id $pidValue -Force; Start-Sleep -Milliseconds 700; if(Test-Path -LiteralPath $runtimePath){Remove-Item -LiteralPath $runtimePath -Force}; exit 0"
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
