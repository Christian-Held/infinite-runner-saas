# scripts/dev-up.ps1
param(
  [string]$RepoPath = "D:\projects\infinite-runner-saas",
  [int]$ApiPort = 3000,
  [int]$RedisPort = 6379
)

$ErrorActionPreference = "Stop"

# 0) In Repo
Set-Location $RepoPath

# 1) Code aktualisieren
git pull --rebase

# 2) Clean: Container/Prozesse
docker compose down --remove-orphans | Out-Null
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# 3) Dependencies
pnpm install
pnpm -r rebuild better-sqlite3

# 4) ENV sicherstellen (ohne Geheimnisse zu überschreiben)
if (!(Test-Path "apps\api\.env")) {
  @"
DB_PATH=./data/app.db
REDIS_URL=redis://localhost:$RedisPort
INTERNAL_TOKEN=dev-internal
"@ | Set-Content -Encoding UTF8 "apps\api\.env"
}

if (!(Test-Path "services\playtester\.env")) {
  @"
# OPENAI_API_KEY=sk-...    <- hier eintragen
OPENAI_MODEL=gpt-4.1-mini
REDIS_URL=redis://localhost:$RedisPort
API_BASE_URL=http://localhost:$ApiPort
INTERNAL_TOKEN=dev-internal
"@ | Set-Content -Encoding UTF8 "services\playtester\.env"
  Write-Host "Bitte OPENAI_API_KEY in services\playtester\.env eintragen." -ForegroundColor Yellow
}

# 5) DB-Verzeichnis
New-Item -ItemType Directory -Force -Path "apps\api\data" | Out-Null

# 6) Redis starten
docker compose up -d redis | Out-Null

# 7) Logs-Verzeichnis
$logDir = ".\.logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 8) API+Web in einem Prozess (Root-Script startet beide), Playtester separat
#    Beide im Hintergrund, Logs in Dateien
$apiWeb = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","pnpm","dev" -WorkingDirectory $RepoPath `
  -NoNewWindow -RedirectStandardOutput "$logDir\dev.out.log" -RedirectStandardError "$logDir\dev.err.log" -PassThru
$play   = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","pnpm","--filter","playtester","dev" -WorkingDirectory $RepoPath `
  -NoNewWindow -RedirectStandardOutput "$logDir\playtester.out.log" -RedirectStandardError "$logDir\playtester.err.log" -PassThru

# 9) Auf API warten
$apiOk = $false
for ($i=0; $i -lt 60; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$ApiPort/health" -TimeoutSec 2 -Method Get
    if ($h.status -eq "ok") { $apiOk = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if (-not $apiOk) {
  Write-Host "API nicht erreichbar. Logs ansehen: $logDir\dev.err.log" -ForegroundColor Red
  exit 1
}

# 10) E2E: Job anlegen und pollen
$body = '{"seed":"autotest","difficulty":1,"abilities":{"run":true,"jump":true}}'
$resp = Invoke-RestMethod -Uri "http://localhost:$ApiPort/levels/generate" -Method Post -ContentType "application/json" -Body $body
$job  = $resp.job_id
Write-Host ("job_id = " + $job)

$levelId = $null
for ($i=0; $i -lt 60; $i++) {
  try {
    $s = Invoke-RestMethod -Uri ("http://localhost:$ApiPort/jobs/" + $job) -Method Get -TimeoutSec 2
    if ($s.status -eq "succeeded" -and $s.levelId) { $levelId = $s.levelId; break }
    if ($s.status -eq "failed") { Write-Host ("Job failed: " + $s.error) -ForegroundColor Red; break }
  } catch {}
  Start-Sleep -Seconds 2
}

if ($levelId) {
  Write-Host ("Level OK: " + $levelId) -ForegroundColor Green
  try {
    $list = Invoke-RestMethod -Uri ("http://localhost:$ApiPort/levels?published=false&limit=5") -Method Get
    $list | ConvertTo-Json -Depth 5
  } catch {}
  try {
    $path = Invoke-RestMethod -Uri ("http://localhost:$ApiPort/levels/" + $levelId + "/path") -Method Get
    Write-Host "Ghost-Pfad verfügbar." -ForegroundColor Green
  } catch { Write-Host "Noch kein Ghost-Pfad." -ForegroundColor Yellow }
} else {
  Write-Host "Kein Level erzeugt. Logs prüfen." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Läuft. Web: http://localhost:5173" -ForegroundColor Cyan
Write-Host "Logs: $logDir\dev.out.log, $logDir\playtester.out.log" -ForegroundColor Cyan
