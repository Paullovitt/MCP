param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [ValidateRange(1, 65535)][int]$Port = 4194,
    [ValidateRange(1, 60)][int]$GracePeriodSeconds = 15
)

$ErrorActionPreference = 'Stop'
$serviceRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
$runtimePath = Join-Path $serviceRoot 'data\runtime.json'
$configPath = Join-Path $serviceRoot 'data\config.json'
$runtime = $null
$config = $null
if (Test-Path -LiteralPath $runtimePath) { try { $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json } catch {} }
if (Test-Path -LiteralPath $configPath) { try { $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json } catch {} }

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
    # Nao remove runtime de um processo vivo que ja tenha fechado seu listener durante o shutdown.
    $liveRuntime = $null
    if ($runtime.pid) { $liveRuntime = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue }
    if (-not $liveRuntime -and (Test-Path -LiteralPath $runtimePath)) { Remove-Item -LiteralPath $runtimePath -Force }
    Write-Host "Nenhuma instancia esta ouvindo na porta $Port."
    exit 0
}

$servicePid = [int]$listener.OwningProcess
$originalProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $servicePid) -ErrorAction SilentlyContinue
$isNode = $originalProcess -and ([string]$originalProcess.Name -match '^node(\.exe)?$')
$commandMatches = $isNode -and ([string]$originalProcess.CommandLine).IndexOf($serviceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
$runtimeMatches = $runtime -and [int]$runtime.pid -eq $servicePid -and [int]$runtime.port -eq $Port -and [IO.Path]::GetFullPath([string]$runtime.projectRoot).TrimEnd('\', '/') -eq $serviceRoot
$identityMatches = $false
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3
    $identityMatches = $isNode -and $config -and $status.service -eq 'mcp-worker-coordinator' -and [int]$status.serverPort -eq $Port -and [string]$status.installId -eq [string]$config.INSTALL_ID
} catch {}
if (-not (($runtimeMatches -and $commandMatches) -or $identityMatches)) {
    Write-Error "A porta $Port pertence a outro processo. Nada foi encerrado."
    exit 2
}

Write-Host "Encerrando MCP Worker Coordinator PID $servicePid..."
if ($runtimeMatches -and $runtime.shutdownToken) {
    try {
        # O segredo nunca e passado na linha de comando nem impresso no console.
        $headers = @{ 'x-mcp-shutdown-token' = [string]$runtime.shutdownToken }
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -Headers $headers -TimeoutSec 3
        $deadline = (Get-Date).AddSeconds($GracePeriodSeconds)
        do {
            Start-Sleep -Milliseconds 100
            $running = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
        } while ($running -and (Get-Date) -lt $deadline)
    } catch {
        Write-Host 'Parada normal indisponivel; verificando fallback seguro.'
    }
}

$remaining = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $servicePid) -ErrorAction SilentlyContinue
if ($remaining) {
    # Revalida a identidade apos a espera para nao atingir PID reciclado pelo Windows.
    if ($remaining.CreationDate -ne $originalProcess.CreationDate -or $remaining.CommandLine -ne $originalProcess.CommandLine) {
        Write-Error 'O PID mudou de identidade; fallback cancelado.'
        exit 2
    }
    Write-Host 'Aplicando fallback forcado a arvore do MCP.'
    & taskkill.exe /PID $servicePid /T /F | Out-Null
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $servicePid -ErrorAction SilentlyContinue) { Write-Error 'O processo nao encerrou.'; exit 1 }
}

# Remove somente o runtime desta instancia; nao apaga um arquivo regravado por outro inicio.
if (Test-Path -LiteralPath $runtimePath) {
    $currentRuntime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
    if ([int]$currentRuntime.pid -eq $servicePid -and [string]$currentRuntime.startedAt -eq [string]$runtime.startedAt) {
        Remove-Item -LiteralPath $runtimePath -Force
    }
}
Write-Host 'MCP encerrado; configuracao, OAuth e banco preservados.'
exit 0
