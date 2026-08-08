@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0.."
set "ROOT=%CD%"

if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"
if not exist "%ROOT%\data" mkdir "%ROOT%\data"

rem A verificacao silenciosa impede duplicidade e nunca encerra um processo desconhecido.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$connection=Get-NetTCPConnection -State Listen -LocalPort 4194 -ErrorAction SilentlyContinue | Select-Object -First 1; " ^
  "if(-not $connection){ exit 0 }; " ^
  "$pidValue=[int]$connection.OwningProcess; " ^
  "try { $health=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/health' -TimeoutSec 3; } catch { $health=$null }; " ^
  "if($health -and $health.service -eq 'mcp-worker-coordinator' -and [int]$health.port -eq 4194){ exit 10 }; " ^
  "Write-Error ('A porta 4194 esta ocupada por outro processo. PID=' + $pidValue + '. Nada foi encerrado.'); exit 2"
set "CHECK_CODE=%ERRORLEVEL%"

if "%CHECK_CODE%"=="10" goto :ALREADY_RUNNING

if not "%CHECK_CODE%"=="0" (
  echo.
  echo Nao foi possivel iniciar a aplicacao.
  echo Se esta janela foi aberta por duplo clique, pressione uma tecla para fechar.
  if /I not "%MCP_NO_PAUSE%"=="1" pause
  exit /b %CHECK_CODE%
)

rem O launcher Node usa stdio em arquivo para desacoplar o servidor da janela atual.
set "LAUNCHED_PID="
for /f "delims=" %%P in ('node --disable-warning^=ExperimentalWarning scripts\launch-hidden.js') do set "LAUNCHED_PID=%%P"
if not defined LAUNCHED_PID (
  echo.
  echo Nao foi possivel criar o processo oculto do servidor.
  echo Consulte: %ROOT%\logs\console.err.log
  if /I not "%MCP_NO_PAUSE%"=="1" pause
  exit /b 1
)

rem Aguarda o processo desacoplado confirmar que a porta e o health check estao prontos.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pidValue=[int]'%LAUNCHED_PID%'; " ^
  "$deadline=(Get-Date).AddSeconds(15); $health=$null; " ^
  "do { Start-Sleep -Milliseconds 200; try { $health=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/health' -TimeoutSec 1 } catch { $health=$null }; $child=Get-Process -Id $pidValue -ErrorAction SilentlyContinue } while(-not $health -and $child -and (Get-Date) -lt $deadline); " ^
  "if($health -and $health.service -eq 'mcp-worker-coordinator' -and [int]$health.port -eq 4194){ exit 0 }; " ^
  "if($child){ Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }; " ^
  "Write-Error 'O servidor nao confirmou a inicializacao em ate 15 segundos.'; exit 1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Falha de inicializacao. Codigo: %EXIT_CODE%
  echo Consulte: %ROOT%\logs\server.log
  echo.
  if exist "%ROOT%\logs\server.log" (
    echo Ultimas linhas do log:
    powershell -NoProfile -Command "Get-Content -LiteralPath '%ROOT%\logs\server.log' -Tail 12 -ErrorAction SilentlyContinue"
  )
  echo.
  echo Pressione uma tecla para fechar.
  if /I not "%MCP_NO_PAUSE%"=="1" pause
  exit /b %EXIT_CODE%
)

goto :STARTED

:ALREADY_RUNNING
set "START_MESSAGE=MCP Worker Coordinator já está iniciado"
goto :SHOW_STATUS

:STARTED
set "START_MESSAGE=MCP Worker Coordinator iniciado"

:SHOW_STATUS
rem Mostra o estado validado por um instante e encerra somente esta janela de inicializacao.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$status=Invoke-RestMethod -Uri 'http://127.0.0.1:4194/api/status' -TimeoutSec 3; " ^
  "Write-Host '%START_MESSAGE%'; " ^
  "Write-Host ('Interface local: ' + $status.localUrl); " ^
  "Write-Host ('Servidor MCP local: ' + $status.localMcpUrl); " ^
  "Write-Host ('Provedor do túnel: ' + $status.tunnelProvider); " ^
  "Write-Host 'Autenticação MCP: OAuth'; " ^
  "Write-Host ('URL MCP pública: ' + $(if($status.publicMcpUrl){$status.publicMcpUrl}else{'não configurada'})); " ^
  "Write-Host ('Status do túnel: ' + $status.tunnelStatus); " ^
  "Write-Host ('Status do servidor: ' + $status.status); " ^
  "Write-Host ('Logs: ' + [IO.Path]::GetFullPath('%ROOT%\logs\server.log'))"

if /I not "%MCP_NO_PAUSE%"=="1" timeout /t 1 /nobreak >nul
exit /b 0
