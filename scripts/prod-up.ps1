Param(
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location (Join-Path $scriptDir '..')
try {
    Write-Host 'Building and starting production stack...'
    docker compose -f docker-compose.prod.yml up -d --build

    $healthUrl = 'http://localhost/health'
    $elapsed = 0
    $interval = 5
    while ($elapsed -lt $TimeoutSeconds) {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                Write-Host 'Health check succeeded.'
                return
            }
        } catch {
            Start-Sleep -Seconds $interval
            $elapsed += $interval
            continue
        }
        Start-Sleep -Seconds $interval
        $elapsed += $interval
    }
    Write-Warning "Service did not become healthy within $TimeoutSeconds seconds."
} finally {
    Pop-Location
}
