$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location (Join-Path $scriptDir '..')
try {
    Write-Host 'Stopping production stack...'
    docker compose -f docker-compose.prod.yml down
} finally {
    Pop-Location
}
