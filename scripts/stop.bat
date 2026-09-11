@echo off
setlocal EnableExtensions
cd /d "%~dp0.."
set "ROOT=%CD%"
rem Centraliza parada normal e fallback sem alterar o tunel gerenciado externamente.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1" -ProjectRoot "%ROOT%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Nao foi possivel encerrar a aplicacao com seguranca.
  echo Pressione uma tecla para fechar.
  if /I not "%MCP_NO_PAUSE%"=="1" pause
)

exit /b %EXIT_CODE%
