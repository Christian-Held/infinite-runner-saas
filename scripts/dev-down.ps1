$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location (Join-Path $scriptDir '..')
try {
    Write-Host 'Stopping development stack...'
    docker compose -f docker-compose.yml down
} finally {
    Pop-Location
}
