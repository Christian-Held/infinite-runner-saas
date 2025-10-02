# scripts/dev-down.ps1
param([string]$RepoPath = "D:\projects\infinite-runner-saas")

$ErrorActionPreference = "SilentlyContinue"
Set-Location $RepoPath

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
docker compose down --remove-orphans | Out-Null
Write-Host "Gestoppt."
