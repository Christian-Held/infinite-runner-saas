# API Service

Der API-Dienst stellt einen stabilen Kern für das Infinite-Runner-SaaS bereit. Er verwaltet Level-Persistenz per SQLite sowie Stub-Queues für Generierungs- und Test-Jobs über Redis/BullMQ.

## Voraussetzungen
- Node.js LTS (>= 20)
- pnpm (>= 8)
- Redis-Instanz (z.B. via `docker compose`)

## Konfiguration
| Variable   | Standardwert             | Beschreibung |
|------------|--------------------------|--------------|
| `PORT`     | `3000`                   | HTTP-Port der API |
| `DB_PATH`  | `./data/app.db`          | Pfad zur SQLite-Datenbank |
| `REDIS_URL`| `redis://redis:6379`     | Verbindung zur Redis-Instanz |

## Wichtige Skripte
```bash
pnpm install          # Dependencies installieren
pnpm --filter api migrate   # Tabellen erzeugen (idempotent)
pnpm --filter api dev       # Entwicklung mit Nodemon + Fastify
pnpm --filter api build     # TypeScript-Build nach dist/
pnpm --filter api start     # Produktionsstart (nutzt dist/app.js)
```

## Endpunkte
Alle Level-Strukturen werden mit `@ir/game-spec` validiert, bevor sie ausgeliefert oder persistiert werden.

### `GET /health`
Antwortet mit dem Zustand von DB und Redis.
```bash
curl http://localhost:3000/health
# {"status":"ok","db":true,"redis":true}
```

### `GET /levels/:id`
Liefert ein einzelnes Level.
```bash
curl http://localhost:3000/levels/<levelId>
```

### `GET /levels`
Listet Level mit optionaler Filterung und Pagination.
```bash
curl "http://localhost:3000/levels?published=false&limit=5"
```
Antwort:
```json
{
  "levels": [
    {
      "level": { "id": "...", "seed": "...", ... },
      "published": false,
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000
    }
  ]
}
```

### `POST /levels/:id/publish`
Setzt das Veröffentlichungs-Flag.
```bash
curl -X POST \
  http://localhost:3000/levels/<levelId>/publish \
  -H "content-type: application/json" \
  -d '{"published":true}'
```

### `POST /levels/generate`
Erzeugt einen Generierungsauftrag. Optional können `seed`, `difficulty` sowie `abilities` gesetzt werden.
```bash
curl -X POST http://localhost:3000/levels/generate \
  -H "content-type: application/json" \
  -d '{"seed":"s1","difficulty":1,"abilities":{"run":true,"jump":true}}'
# {"jobId":"<uuid>"}
```

### `GET /jobs/:id`
Abfrage des Jobstatus. Der Generierungs-Job erzeugt im Erfolgsfall automatisch einen nachgelagerten Test-Job.
```bash
curl http://localhost:3000/jobs/<jobId>
# {"id":"...","type":"gen","status":"running"}
```

Sobald sowohl Generierungs- als auch Test-Job abgeschlossen sind, ist das Level in der Datenbank verfügbar und kann veröffentlicht werden.

## Shutdown
Der Dienst behandelt `SIGINT`/`SIGTERM`, wartet auf das Beenden der Worker und schließt die SQLite-Verbindung sauber.

## Docker-Hinweise
Der Container legt seine Daten unter `/usr/src/app/data` ab. Über Docker Compose wird dieses Verzeichnis als Named Volume (`api-data`) gemountet.
