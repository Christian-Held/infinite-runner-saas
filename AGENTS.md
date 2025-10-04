# Infinite Runner SaaS – AGENTS Leitfaden

**TL;DR:** Dieses Dokument bündelt Architektur, Datenflüsse und Windows-Betriebsanweisungen, damit Agents und Devs ohne Code-Suche das Infinite-Runner-SaaS-System verstehen, starten und debuggen können.

## Projekt in einem Satz
Infinite Runner SaaS liefert eine Fastify-API, ein Phaser-Web-Frontend und einen Playtester-Worker, die zusammen prozedural generierte Runner-Level erstellen, testen und veröffentlichen.

## Warum dieses Dokument existiert
AGENTS.md dient als Kontext-Anker: Es erklärt den Aufbau des Repositories, die Interaktion der Komponenten und die notwendigen manuellen Schritte für lokalen Betrieb und Fehlersuche, damit alle Beteiligten schnell arbeitsfähig sind.

## Systemüberblick
ASCII-Diagramm des Gesamtsystems:

[Web/Phaser SPA] ⇄ [API (Fastify, SQLite)] ⇄ [Redis (BullMQ)]
                             ↑
                      [Playtester Worker]
                  (Gen → Test → Tune → Publish)

### Technologiefluss Schritt-für-Schritt
1. Web fordert die Level-Liste an oder spielt ein veröffentlichtes Level.
2. API: `POST /levels/generate` legt einen Job in die Queue `gen`.
3. Playtester zieht `gen`, ruft OpenAI an, erstellt ein Level und speichert es über interne API-Endpunkte.
4. Playtester legt danach einen `test`-Job an, simuliert Lauf & Pfad, speichert das Ghost/Path-Resultat und markiert ggf. Publish.
5. Web lädt veröffentlichte Level und Pfade aus der API, um sie spielbar zu machen.

**Warum diese Reihenfolge?** Die API bleibt responsiv und statusfähig, während Redis/BullMQ die asynchrone Arbeit puffert. Der Playtester kann Generation, Tests und Publishes sequenziell durchführen, ohne dass Web oder API blockieren.

## Repository-Map mit Kurzrollen
```
.
├─ apps/
│  ├─ api/        # HTTP-API, DB, Queues, Health
│  └─ web/        # Phaser-Client (Vite)
├─ services/
│  └─ playtester/ # Worker: generate, test, tune, publish
├─ packages/
│  └─ game-spec/  # Zod-Schemas (Level, Ability), Progression
└─ docker-compose.yml  # Redis-Container
```

### Wichtige Dateien & Module
- `apps/api/src/server.ts`: Fastify-Routen, Health, Jobstatus.
- `apps/api/src/queue/index.ts`: BullMQ-Setup & Queue-Namen.
- `apps/api/src/db/index.ts`: SQLite-Zugriff, Level- & Jobtabellen.
- `services/playtester/src/generator.ts`: OpenAI-gestützte Level-Erstellung.
- `services/playtester/src/tester.ts`: Simulation & Pfadberechnung.
- `services/playtester/src/tuner.ts`: Retrys und Feinjustierung bei Fehlschlägen.
- `services/playtester/src/queue.ts`: Worker-Registrierung & Event-Handling.
- `services/playtester/src/internal-client.ts`: Interne API-Aufrufe.
- `apps/web/src/main.ts` & `apps/web/src/game`: Phaser-Bootstrap und Szenenlogik.

## Komponenten im Detail
### API (`apps/api`)
- **Framework & Ports:** Fastify mit Vite/Node-Dev-Server auf Port 3000 (per `pnpm --filter api run dev:direct`).
- **Persistenz:** SQLite unter `./apps/api/data/app.db` (relative zum Repo).
- **Routen-Übersicht:**
  - `GET /health` → Status (API, DB, Redis), Version, Uptime, Queue-Statistiken, Budget.
  - `POST /levels/generate` → Legt Gen-Job an, liefert `202 Accepted` mit `job_id`.
  - `GET /jobs/:id` → `queued | running | succeeded | failed` plus Metadaten.
  - `GET /levels?published=...&limit=...` → Liste veröffentlichter/nicht veröffentlichter Level.
  - `GET /levels/:id/path` → Ghost/Path-Daten für das Level.
  - `POST /internal/jobs`, `POST /internal/jobs/:id/status`, `POST /internal/levels`, `POST /internal/paths`, … → Nur mit `x-internal-token` für Worker.
- **Queues:**
  - Namen: `gen`, `test`; Prefix standardmäßig `bull`.
  - Redis speichert Warteschlangen (`bull:gen:*`, `bull:test:*`) für Jobstatus, Events und Retries.
- **Warum Redis?** BullMQ nutzt Redis als zentrales State-Backend. Die API legt Jobs ab, der Worker konsumiert sie entkoppelt. Redis garantiert Persistenz, Retry-Strategien und Monitoring (`wait`, `active`, `events`).

### Playtester (`services/playtester`)
- **Job-Pipeline:**
  1. Worker zieht `gen`-Jobs → `generateLevel()` (OpenAI) → speichert Level + Meta via interne API.
  2. Enqueued automatisch `test`-Jobs.
  3. `test`-Worker simuliert das Level (`tester.ts`), erzeugt Pfad/Ghost, speichert ihn und entscheidet über Publish oder Tuning (`tuner.ts`).
  4. Bei Fehlschlag: Budget-check & Retry, ggf. Reason Codes im Job.
- **Budget-Guard:** `BUDGET_USD_PER_DAY`, `COST_PER_1K_INPUT/OUTPUT` limitieren OpenAI-Ausgaben. Überschreitungen stoppen neue Jobs.
- **Kommunikation:** Alle Schreibzugriffe erfolgen über interne API-Endpunkte mit `x-internal-token`.

### Web (`apps/web`)
- **Technik:** Vite + React + Phaser.
- **Funktion:** Lädt Level, Assets und Ghost/Path von der API, visualisiert Lauf des Ghosts, erlaubt manuelles Spielen. Keine Schreib-Operationen.

## Startreihenfolge auf Windows (ohne Skripte)
**Warum zuerst Redis?** Ohne laufendes Redis können BullMQ-Queues weder Jobs annehmen noch Worker-Events speichern – API-Aufrufe würden hängen oder fehlschlagen.

### 1. Clean Stop & Ports freimachen
```powershell
docker compose down --remove-orphans
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }
```

### 2. ENV prüfen
`apps/api/.env`:
```
DB_PATH=./data/app.db
REDIS_URL=redis://localhost:6379
INTERNAL_TOKEN=dev-internal
```

`services/playtester/.env`:
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
REDIS_URL=redis://127.0.0.1:6379
API_BASE_URL=http://localhost:3000
INTERNAL_TOKEN=dev-internal
BUDGET_USD_PER_DAY=5
COST_PER_1K_INPUT=0
COST_PER_1K_OUTPUT=0
BULL_PREFIX=bull
GEN_QUEUE=gen
TEST_QUEUE=test
```

### 3. Dependencies installieren & DB-Verzeichnis anlegen
```powershell
pnpm install
pnpm -r rebuild better-sqlite3
mkdir apps\api\data -Force | Out-Null
```

### 4. Redis starten
```powershell
docker compose up -d redis
docker exec -it infinite-runner-saas-redis-1 redis-cli PING  # → PONG
```

### 5. API starten (neues Fenster)
```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','cd D:\projects\infinite-runner-saas; pnpm --filter api run dev:direct'
```

### 6. Web starten (neues Fenster)
```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','cd D:\projects\infinite-runner-saas; pnpm --filter web dev'
```

### 7. Playtester starten (neues Fenster, Logs sichtbar)
```powershell
Start-Process powershell -ArgumentList '-NoExit','-Command','cd D:\projects\infinite-runner-saas; pnpm --filter playtester dev'
```

### 8. Health prüfen
```powershell
Invoke-RestMethod http://localhost:3000/health
```
*Erwartung:* `status:"ok"`, `db:true`, `redis:true`.

### 9. Level generieren & Job pollen
```powershell
$body = '{"seed":"manual","difficulty":1,"abilities":{"run":true,"jump":true}}'
$r = Invoke-RestMethod -Uri http://localhost:3000/levels/generate -Method Post -ContentType "application/json" -Body $body
$job = $r.job_id
1..40 | % { Invoke-RestMethod -Uri ("http://localhost:3000/jobs/" + $job); Start-Sleep 2 }
```

### 10. Level & Pfade abrufen
```powershell
Invoke-RestMethod "http://localhost:3000/levels?published=false&limit=5"
# Pfad:
# Invoke-RestMethod "http://localhost:3000/levels/<LEVEL_ID>/path"
```

### 11. Spiel öffnen
Browser: `http://localhost:5173`

## Warum/Was macht Redis konkret?
BullMQ speichert pro Queue Listen und Streams, z. B. `bull:gen:wait`, `bull:gen:active`, `bull:gen:events`. Damit lassen sich Jobs überwachen, retries managen und Worker entkoppeln.

### Monitoring-Beispiele
```powershell
docker exec -it infinite-runner-saas-redis-1 redis-cli LLEN bull:gen:wait
docker exec -it infinite-runner-saas-redis-1 redis-cli LLEN bull:gen:active
docker exec -it infinite-runner-saas-redis-1 redis-cli MONITOR
```

## Datenablage
- **Levels & Metadaten:** SQLite `apps/api/data/app.db` (Tabellen für Level, Revisionen, Metrics, Jobs).
- **Ghost/Path:** Über interne API gespeichert, via `GET /levels/:id/path` abrufbar.
- **Jobs:** Status sowohl in Redis (Queues) als auch in SQLite (`jobs`-Tabelle inkl. `id`, `type`, `status`, `error`, `attempts`, `lastReason`, `createdAt`, `updatedAt`).

## Health & Diagnose
- `GET /health` liefert: `status`, `db`, `redis`, `version`, `uptime_s`, `queue` (Jobcounts) und `budget` (verbleibendes Tagesbudget).
- **Warum wichtig?** Vor dem Start weiterer Komponenten prüfen, ob API, Datenbank und Redis bereit sind. Monitoring-Systeme können denselben Endpunkt verwenden.

## Starten, Stoppen & Reset
1. **Start** siehe Abschnitt oben.
2. **Stoppen:**
   ```powershell
   Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
   docker compose down --remove-orphans
   ```
3. **Ports freimachen (3000, 5173):**
   ```powershell
   Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }
   Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force }
   ```

## Debuggen auf Windows
- ### Redis/BullMQ auf Windows
  - BullMQ nutzt blocking Connections; unter Windows muss `maxRetriesPerRequest` auf `null` stehen, sonst beendet sich der Playtester beim Start mit dem Hinweis `BullMQ: Your redis options maxRetriesPerRequest must be null.`
  - Stelle sicher, dass sowohl API als auch Worker IORedis immer mit `{ enableOfflineQueue: false, maxRetriesPerRequest: null }` initialisieren.

- **Logs tailen:**
  ```powershell
  Get-Content .\.logs\api.err.log -Tail 120
  Get-Content .\.logs\playtester.err.log -Tail 120
  ```
- **Typische Fehler & Fixes:**
  - Job bleibt `queued` → Playtester nicht gestartet oder Queue-Konfiguration falsch (`BULL_PREFIX`, `GEN_QUEUE`, `TEST_QUEUE`). `.env` prüfen, Worker neu starten.
  - `OPENAI_API_KEY is not set` → Schlüssel in `services\playtester\.env` eintragen.
  - `INTERNAL_TOKEN must be set` → `apps\api\.env` prüfen, Wert `dev-internal` für Dev.
  - Budget-Fehler → `BUDGET_USD_PER_DAY` erhöhen und Playtester neu starten.
  - Kein `PONG` von Redis → Docker Desktop/Container prüfen, ggf. `docker compose up -d redis` erneut.

## Docker Desktop / WSL?
- **Docker Desktop:** benötigt, um den Redis-Container zu betreiben. Alternativ externer Redis → `REDIS_URL` anpassen.
- **WSL/Ubuntu:** nicht zwingend; PowerShell reicht. WSL kann genutzt werden, falls Linux-Tools bevorzugt werden.

## Sicherheit & Secrets
- `.env`-Dateien niemals committen.
- Interne Endpunkte nur mit `x-internal-token` verwenden.
- Logs schreiben keine Secrets, dennoch beim Teilen Vorsicht.

## ENV-Referenz
| NAME                 | Default                 | Komponente        | Beschreibung                                         | Prod erforderlich |
|----------------------|-------------------------|-------------------|------------------------------------------------------|-------------------|
| `OPENAI_API_KEY`     | _(leer)_                | Playtester        | Key für OpenAI-API                                   | Ja                |
| `OPENAI_MODEL`       | `gpt-4.1-mini`          | Playtester        | Modell-ID für Levelgeneration                        | Ja                |
| `REDIS_URL`          | `redis://127.0.0.1:6379`| API & Playtester  | Redis-Verbindung für BullMQ                          | Ja                |
| `API_BASE_URL`       | `http://localhost:3000` | Playtester        | Basis-URL der lokalen API                            | Ja                |
| `INTERNAL_TOKEN`     | `dev-internal`          | API & Playtester  | Gemeinsames Secret für interne Endpunkte             | Ja                |
| `DB_PATH`            | `./data/app.db`         | API               | SQLite-Dateipfad                                     | Ja                |
| `BUDGET_USD_PER_DAY` | `5`                     | Playtester        | Tagesbudget für OpenAI-Aufrufe                       | Ja                |
| `COST_PER_1K_INPUT`  | `0`                     | Playtester        | Erwartete Kosten pro 1k Inputtoken                   | Ja                |
| `COST_PER_1K_OUTPUT` | `0`                     | Playtester        | Erwartete Kosten pro 1k Outputtoken                  | Ja                |
| `QUEUE_PREFIX`       | `bull`                  | API & Playtester  | Primärer Redis-Prefix für BullMQ-Keys                | Ja                |
| `BULL_PREFIX`        | `bull`                  | API & Playtester  | Fallback-Prefix (Legacy), falls `QUEUE_PREFIX` fehlt | Ja                |
| `GEN_QUEUE`          | `gen`                   | API & Playtester  | Name der Generation-Queue                           | Ja                |
| `TEST_QUEUE`         | `test`                  | API & Playtester  | Name der Test-Queue                                 | Ja                |

### ENV-Matrix
- API und Playtester lesen `QUEUE_PREFIX`; der Playtester akzeptiert zusätzlich `BULL_PREFIX` als Fallback für ältere `.env`-Dateien.
- Empfehlung: Setze `QUEUE_PREFIX` **und** `BULL_PREFIX` auf denselben Wert (Standard `bull`), damit beide Komponenten identische Redis-Keys verwenden.

## FAQ für Agents
- **„Warum erst Redis?“** → Ohne Redis kein Queue-Backend; API-Jobs würden fehlschlagen.
- **„Warum hängen Level im Status `queued`?“** → Worker inaktiv oder Queue-Namen/Prefix stimmen nicht mit API überein.
- **„Wo finde ich Level & Pfade?“** → SQLite `apps/api/data/app.db` bzw. `GET /levels/:id/path`.
- **„Wie erkenne ich Prefix-/Queue-Mismatch?“** → Redis-Keys prüfen (`bull:<prefix>:...`) und `.env` vergleichen.
- **„Wie prüfe ich, dass der Worker zieht?“** → `docker exec ... redis-cli LLEN bull:gen:active` oder Playtester-Logs auf `Processing job` beobachten.
- **„Wie resette ich die Umgebung sauber?“** → Stop/Ports freimachen (oben), `docker compose down`, ggf. `apps/api/data/app.db` löschen.

## Glossar
- **Level:** Prozedural generierte Runner-Strecke inkl. Plattformen, Gegnern, Biomen.
- **Ability:** Fähigkeiten des Spielers (laufen, springen, fliegen) – definiert in `packages/game-spec`.
- **Ghost/Path:** Aufgezeichneter Eingabepfad der Simulation zum Level.
- **Tuning:** Automatische Anpassung bei fehlgeschlagenen Tests (z. B. Hindernisse entschärfen).
- **Reason Codes:** Texte, warum Jobs scheitern (z. B. „budget_exceeded“).
- **Queue Prefix:** Redis-Key-Präfix (Standard `bull`) für BullMQ-Queues.
- **Job Lifecycle:** Zustände `queued → running → succeeded/failed`, sichtbar über `GET /jobs/:id` und Redis.

---
Dieses Dokument wird laufend aktualisiert, um Agents und Devs eine vollständige Übersicht zu liefern. Änderungen am System bitte hier spiegeln.
