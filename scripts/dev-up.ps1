Param(
    [switch]$Build
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location (Join-Path $scriptDir '..')
try {
    $requiredVars = @('BUDGET_USD_PER_DAY', 'RATE_WINDOW_MS', 'RATE_MAX', 'RATE_MAX_SEASON')
    $missing = @()
    foreach ($var in $requiredVars) {
        if (-not $env:$var) {
            $missing += $var
        }
    }

    if ($missing.Count -gt 0) {
        Write-Warning ("Missing environment variables: {0}" -f ($missing -join ', '))
    }

    if (-not $env:OPENAI_API_KEY) {
        Write-Warning 'OPENAI_API_KEY is not set. Playtester jobs will fail without it.'
    }

    $composeArgs = @('-f', 'docker-compose.yml', 'up', '-d')
    if ($Build.IsPresent) {
        $composeArgs += '--build'
    }

    Write-Host "Running docker compose $($composeArgs -join ' ')"
    docker compose @composeArgs
} finally {
    Pop-Location
}
