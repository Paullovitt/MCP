@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "ROOT=%CD%"
set "RUNTIME=%ROOT%\data\runtime.json"
set "CONFIG=%ROOT%\data\config.json"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; " ^
  "$root=[IO.Path]::GetFullPath('%ROOT%'); $runtimePath='%RUNTIME%'; $configPath='%CONFIG%'; $port=4194; " ^
  "$runtime=$null; if(Test-Path -LiteralPath $runtimePath){ try{$runtime=Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json}catch{} }; " ^
  "$config=$null; if(Test-Path -LiteralPath $configPath){ try{$config=Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json}catch{} }; " ^
  "$connection=Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1; " ^
  "if(-not $connection){ if(Test-Path -LiteralPath $runtimePath){Remove-Item -LiteralPath $runtimePath -Force}; Write-Host 'Nenhuma instancia da nova aplicacao esta ouvindo na porta 4194.'; exit 0 }; " ^
  "$pidValue=[int]$connection.OwningProcess; $proc=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $pidValue) -ErrorAction SilentlyContinue; " ^
  "$runtimeMatches=$runtime -and [int]$runtime.pid -eq $pidValue -and [int]$runtime.port -eq $port -and [IO.Path]::GetFullPath([string]$runtime.projectRoot) -eq $root; " ^
  "$commandMatches=$proc -and ([string]$proc.CommandLine).IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and ([string]$proc.Name -match '^node(\.exe)?$'); " ^
  "$identityMatches=$false; try { $status=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/api/status' -TimeoutSec 3; $identityMatches=$proc -and ([string]$proc.Name -match '^node(\.exe)?$') -and $config -and $status.service -eq 'mcp-worker-coordinator' -and [int]$status.serverPort -eq $port -and [string]$status.installId -eq [string]$config.INSTALL_ID } catch {}; " ^
  "if(-not (($runtimeMatches -and $commandMatches) -or $identityMatches)){ Write-Error ('A porta 4194 pertence a outro processo. PID=' + $pidValue + '. Nada foi encerrado.'); exit 2 }; " ^
  "Write-Host ('Encerrando MCP Worker Coordinator PID ' + $pidValue + '...'); Stop-Process -Id $pidValue -Force; Start-Sleep -Milliseconds 500; if(Test-Path -LiteralPath $runtimePath){Remove-Item -LiteralPath $runtimePath -Force}; Write-Host 'Aplicacao encerrada com seguranca.'"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Nao foi possivel encerrar a aplicacao com seguranca.
  echo Pressione uma tecla para fechar.
  if /I not "%MCP_NO_PAUSE%"=="1" pause
)

exit /b %EXIT_CODE%
