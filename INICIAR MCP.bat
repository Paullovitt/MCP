@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Iniciar MCP
cd /d "%~dp0"
set "ROOT=%CD%"
set "PATH=%ROOT%;%PATH%"
set "MCP_NO_PAUSE=1"

if not exist "%ROOT%\node.exe" (
  echo Node.js local nao encontrado.
  timeout /t 8 /nobreak >nul
  exit /b 1
)

if not exist "%ROOT%\node_modules\typescript\package.json" (
  echo Instalando dependencias do MCP...
  if not exist "%ROOT%\.npm-local\npm\bin\npm-cli.js" (
    echo npm local nao encontrado.
    timeout /t 8 /nobreak >nul
    exit /b 1
  )
  "%ROOT%\node.exe" "%ROOT%\.npm-local\npm\bin\npm-cli.js" ci
  if errorlevel 1 (
    echo Falha ao instalar as dependencias.
    timeout /t 8 /nobreak >nul
    exit /b 1
  )
)

echo Verificando o tunel compartilhado mcp2...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$cloudflared='C:\Cloudflared\bin\cloudflared.exe'; " ^
  "$config=Get-ChildItem -LiteralPath 'C:\Cloudflared' -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.yml','.yaml' -and (Select-String -LiteralPath $_.FullName -SimpleMatch 'hostname: mcp2.luckytrevo.com' -Quiet) } | Select-Object -First 1 -ExpandProperty FullName; " ^
  "if(-not (Test-Path -LiteralPath $cloudflared)){ Write-Error 'cloudflared.exe nao encontrado em C:\Cloudflared\bin.'; exit 2 }; if(-not $config){ Write-Error 'Nenhum YAML do Cloudflare possui a rota mcp2.luckytrevo.com.'; exit 2 }; " ^
  "$local=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like ('*'+$config+'*') } | Select-Object -First 1; " ^
  "if($local){ exit 0 }; " ^
  "try { for($attempt=0; $attempt -lt 7; $attempt++){ $raw=(& $cloudflared tunnel info --output json lucktrevo 2>$null | Out-String); $info=$raw | ConvertFrom-Json; if(@($info.conns).Count -eq 0){ break }; if($attempt -lt 6){ Start-Sleep -Seconds 5 } } } catch { Write-Error 'Nao foi possivel consultar o tunel lucktrevo.'; exit 2 }; " ^
  "if(@($info.conns).Count -gt 0){ Write-Error 'O tunel lucktrevo esta ativo em outro computador. Pare a outra instalacao antes de iniciar esta.'; exit 3 }; " ^
  "Start-Process -FilePath $cloudflared -ArgumentList 'tunnel','--config',$config,'run','lucktrevo' -WorkingDirectory 'C:\Cloudflared\bin' -WindowStyle Hidden; " ^
  "$deadline=(Get-Date).AddSeconds(15); do { Start-Sleep -Milliseconds 500; $local=Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like ('*'+$config+'*') } | Select-Object -First 1 } while(-not $local -and (Get-Date)-lt $deadline); " ^
  "if(-not $local){ Write-Error 'O tunel mcp2 nao iniciou.'; exit 1 }"
set "TUNNEL_RESULT=%ERRORLEVEL%"

if not "%TUNNEL_RESULT%"=="0" (
  echo.
  if "%TUNNEL_RESULT%"=="3" echo O MCP de outro computador ainda esta conectado. Use o STOP nele primeiro.
  if not "%TUNNEL_RESULT%"=="3" echo Falha ao iniciar o tunel mcp2.
  echo Nada foi substituido no DNS.
  timeout /t 10 /nobreak >nul
  exit /b %TUNNEL_RESULT%
)

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
if not exist "%ROOT%\data" mkdir "%ROOT%\data"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=[IO.Path]::GetFullPath('%ROOT%'); $node=Join-Path $root 'node.exe'; " ^
  "$connection=Get-NetTCPConnection -State Listen -LocalPort 4194 -ErrorAction SilentlyContinue | Select-Object -First 1; " ^
  "if($connection){ try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/health' -TimeoutSec 3}catch{$health=$null}; if($health -and $health.service -eq 'mcp-worker-coordinator' -and [int]$health.port -eq 4194){ Write-Host 'MCP Worker Coordinator ja esta iniciado.'; exit 0 }; Write-Error ('A porta 4194 pertence a outro processo. PID='+$connection.OwningProcess+'. Nada foi encerrado.'); exit 2 }; " ^
  "$cfConfig=Get-ChildItem -LiteralPath 'C:\Cloudflared' -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.yml','.yaml' -and (Select-String -LiteralPath $_.FullName -SimpleMatch 'hostname: mcp2.luckytrevo.com' -Quiet) } | Select-Object -First 1 -ExpandProperty FullName; " ^
  "if($cfConfig){ $credentialLine=Select-String -LiteralPath $cfConfig -Pattern '^\s*credentials-file\s*:\s*(.+?)\s*$' | Select-Object -First 1; if($credentialLine){ $credentialPath=$credentialLine.Matches[0].Groups[1].Value.Trim().Trim([char]34).Trim([char]39); if(-not [IO.Path]::IsPathRooted($credentialPath)){ $credentialPath=Join-Path (Split-Path -Parent $cfConfig) $credentialPath }; if(Test-Path -LiteralPath $credentialPath){ $credential=Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json; if($credential.TunnelSecret){ $bytes=[Text.Encoding]::UTF8.GetBytes('mcp-worker-coordinator:'+[string]$credential.TunnelSecret); $hash=[Security.Cryptography.SHA256]::Create().ComputeHash($bytes); $env:MCP_OAUTH_SHARED_TOKEN_SECRET=[Convert]::ToBase64String($hash).TrimEnd('=').Replace('+','-').Replace('/','_') } } } }; " ^
  "$out=Join-Path $root 'logs\console.out.log'; $err=Join-Path $root 'logs\console.err.log'; " ^
  "$process=Start-Process -FilePath $node -ArgumentList '--disable-warning=ExperimentalWarning','src\index.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru; " ^
  "$deadline=(Get-Date).AddSeconds(20); $health=$null; do{ Start-Sleep -Milliseconds 250; try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/health' -TimeoutSec 1}catch{$health=$null}; $alive=Get-Process -Id $process.Id -ErrorAction SilentlyContinue }while(-not $health -and $alive -and (Get-Date)-lt $deadline); " ^
  "if($health -and $health.service -eq 'mcp-worker-coordinator' -and [int]$health.port -eq 4194){ exit 0 }; if($alive){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}; Write-Error 'O servidor nao confirmou a inicializacao.'; exit 1"
set "SERVER_RESULT=%ERRORLEVEL%"

if not "%SERVER_RESULT%"=="0" (
  echo Falha ao iniciar o MCP Worker Coordinator.
  if exist "%ROOT%\logs\server.log" powershell.exe -NoProfile -Command "Get-Content -LiteralPath '%ROOT%\logs\server.log' -Tail 12 -ErrorAction SilentlyContinue"
  timeout /t 10 /nobreak >nul
  exit /b %SERVER_RESULT%
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(25); $local=$null; $public=$null; " ^
  "do { Start-Sleep -Milliseconds 500; try{$local=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/health' -TimeoutSec 2}catch{$local=$null}; try{$public=Invoke-RestMethod -Uri 'https://mcp2.luckytrevo.com/health' -TimeoutSec 4}catch{$public=$null} } while(((-not $local)-or(-not $public)) -and (Get-Date)-lt $deadline); " ^
  "if(-not $local -or -not $public){ Write-Error 'A verificacao local ou publica falhou.'; exit 1 }; " ^
  "Write-Host ''; Write-Host 'MCP pronto e conectado.' -ForegroundColor Green; Write-Host 'Local:  http://127.0.0.1:4194'; Write-Host 'Publico: https://mcp2.luckytrevo.com/mcp'; Write-Host 'Workers por equipe: 3'"
set "CHECK_RESULT=%ERRORLEVEL%"

if not "%CHECK_RESULT%"=="0" (
  echo Consulte os logs na pasta logs.
  timeout /t 10 /nobreak >nul
  exit /b %CHECK_RESULT%
)

echo Esta janela fechara; o MCP continuara oculto.
timeout /t 3 /nobreak >nul
exit /b 0
