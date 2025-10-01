# Infinite Runner SaaS Monorepo

## Voraussetzungen
- Node.js LTS (>= 20)
- pnpm (>= 8)
- Docker & Docker Compose (für containerisierte Entwicklung)

## Schnellstart Entwicklung
```bash
pnpm install
pnpm dev
```
- Web-App erreichbar unter [http://localhost:5173](http://localhost:5173)
- API erreichbar unter [http://localhost:3000](http://localhost:3000)
- KI-Playtester-Worker: `pnpm playtester`

### API-Workflows
- `GET http://localhost:3000/health` prüft DB- und Redis-Verfügbarkeit.
- `POST http://localhost:3000/levels/generate` erstellt einen Generierungsjob; die Ausführung übernimmt der Playtester-Service (gen → test).
- `GET http://localhost:3000/jobs/<jobId>` zeigt den Jobfortschritt (`queued` → `running` → `succeeded`).
- `GET http://localhost:3000/levels?published=false&limit=5` listet unveröffentlichte Level.
- `POST http://localhost:3000/levels/<levelId>/publish` setzt das Veröffentlichungsflag.

Alle Level-Daten validieren gegen `@ir/game-spec`, persistieren in SQLite (`./apps/api/data/app.db`) und werden über BullMQ/Redis verarbeitet.

### Playtester Service
- Start: `pnpm playtester` (lokal) oder via Docker Compose.
- Benötigte Umgebungsvariablen:
  - `OPENAI_API_KEY` (Pflicht)
  - `OPENAI_MODEL` (Standard: `gpt-4.1-mini`)
  - `OPENAI_REQ_TIMEOUT_MS` (Standard: `20000`)
  - `GEN_MAX_ATTEMPTS` (Standard: `3`)
  - `GEN_SIMHASH_TTL_SEC` (Standard: `604800`)
  - `REDIS_URL` (Standard: `redis://redis:6379`)
  - `API_BASE_URL` (Standard: `http://localhost:3000`)
  - `INTERNAL_TOKEN` (muss mit der API übereinstimmen, Standard `dev-internal`)
- Queues: `gen` (Concurrency 2) & `test` (Concurrency 4) via BullMQ.
- Der Worker schreibt Levels und Job-Status über interne API-Endpunkte (`/internal/*`) zurück.

### Web starten

```bash
pnpm --filter web dev
```

- Steuerung: Links/Rechts über `A`/`D` oder Pfeiltasten, Sprung via `Leertaste` oder `Pfeil nach oben`, `Esc` pausiert.
- Ziel: Laufe zum Ausgang, weiche Gefahren aus und erreiche das Levelende so schnell wie möglich.

## Docker-Entwicklung
```bash
docker compose up --build
```
- Nutzt lokale Dockerfiles der Pakete
- Startet Web, API, Playtester-Service sowie Redis. Die API speichert ihren Zustand in einem Docker-Volume (`api-data`).

## Repository-Struktur
```
.
├── apps
│   ├── api
│   └── web
├── services
│   └── playtester
├── docker-compose.yml
├── tsconfig.base.json
└── package.json
```

## Weitere Skripte
- `pnpm build` – baut alle Workspaces
- `pnpm lint` – führt ESLint in allen Workspaces aus
- `pnpm format` – führt Prettier im Check-Modus in allen Workspaces aus

## Umgebung
- `OPENAI_API_KEY` – API-Schlüssel für OpenAI-basierte Generierung
- `OPENAI_MODEL=gpt-4.1-mini` – Vorgabemodell für den Generator
- `OPENAI_REQ_TIMEOUT_MS=20000` – Timeout für OpenAI-Anfragen (ms)
- `GEN_MAX_ATTEMPTS=3` – Maximale Generierungsversuche
- `GEN_SIMHASH_TTL_SEC=604800` – TTL für Layout-Signaturen (Sekunden)
- `REDIS_URL=redis://redis:6379` – Verbindung zur Redis-Instanz aus Docker Compose
- `DB_PATH=./data/app.db` – Speicherort der SQLite-Datenbank (Standard)
- `INTERNAL_TOKEN=dev-internal` – Shared Secret für interne API-Aufrufe (Playtester ↔ API)
