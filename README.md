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

### API-Workflows
- `GET http://localhost:3000/health` prüft DB- und Redis-Verfügbarkeit.
- `POST http://localhost:3000/levels/generate` erstellt einen Generierungsjob (stub) und stößt automatisch einen Testjob an.
- `GET http://localhost:3000/jobs/<jobId>` zeigt den Jobfortschritt (`queued` → `running` → `succeeded`).
- `GET http://localhost:3000/levels?published=false&limit=5` listet unveröffentlichte Level.
- `POST http://localhost:3000/levels/<levelId>/publish` setzt das Veröffentlichungsflag.

Alle Level-Daten validieren gegen `@ir/game-spec`, persistieren in SQLite (`./apps/api/data/app.db`) und werden über BullMQ/Redis im Stub-Workflow verarbeitet.

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
- `OPENAI_API_KEY` – Platzhalter für künftige KI-Integration
- `REDIS_URL=redis://redis:6379` – Verbindung zur Redis-Instanz aus Docker Compose
- `DB_PATH=./data/app.db` – Speicherort der SQLite-Datenbank (Standard)
