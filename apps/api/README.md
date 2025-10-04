# API Service

Der API-Dienst stellt einen stabilen Kern für das Infinite-Runner-SaaS bereit. Er verwaltet Level-Persistenz per SQLite sowie Stub-Queues für Generierungs- und Test-Jobs über Redis/BullMQ.

## Voraussetzungen
- Node.js LTS (>= 20)
- pnpm (>= 8)
- Redis-Instanz (z.B. via `docker compose`)

## Konfiguration
| Variable                     | Standardwert       | Beschreibung |
|------------------------------|--------------------|--------------|
| `PORT`                       | `3000`             | HTTP-Port der API |
| `DB_PATH`                    | `./data/app.db`    | Pfad zur SQLite-Datenbank |
| `REDIS_URL`                  | `redis://redis:6379` | Verbindung zur Redis-Instanz |
| `BATCH_COUNT_MAX`            | `1000`             | Maximale Anzahl an Levels pro Batch-Auftrag |
| `MAX_PARALLEL_JOBS`          | `8`                | Obergrenze gleichzeitiger Queue-Starts beim Batch-Enqueue |
| `JOB_QUEUE_BACKPRESSURE_MS`  | `100`              | Wartezeit bei erreichten Parallelitätsgrenzen (Backpressure) |
| `REQUEST_BODY_LIMIT_BYTES`   | `65536`            | Maximale Größe eines Request-Bodys |
| `BATCH_TTL_DAYS`             | `30`               | Aufbewahrungsdauer für Batch-Metadaten bei Listenabfragen |
| `BATCH_RATE_MAX`             | `5`                | Token-Bucket-Limit für `POST /levels/generate-batch` |
| `BATCH_RATE_WINDOW_MS`       | `60000`            | Fenstergröße für das Batch-Rate-Limit |

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

### `POST /levels/generate-batch`
Erzeugt eine ganze Serie von Generierungsjobs in einem Request. Optional können Seeds, Start-Level, Idempotency-Key, Fähigkeiten
und Schwierigkeitsprofile (fix oder Rampen) gesetzt werden. Die API antwortet sofort mit `batch_id`, Job-IDs und Anzahl.

**curl-Beispiel**
```bash
curl -X POST http://localhost:3000/levels/generate-batch \
  -H "content-type: application/json" \
  -d '{
        "count": 3,
        "start_level": 12,
        "seed_prefix": "demo",
        "difficulty_mode": "ramp",
        "difficulty_ramp": {"from": 2, "to": 6, "steps": "auto"},
        "idempotency_key": "demo-123"
      }'
# {"batch_id":"...","job_ids":["...","...","..."],"count":3}
```

**PowerShell**
```powershell
$body = @{ count = 2; seed_prefix = 'ps-demo'; idempotency_key = 'batch-ps-1' } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/levels/generate-batch' -ContentType 'application/json' -Body $body
```

**JavaScript (fetch)**
```js
const response = await fetch('http://localhost:3000/levels/generate-batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ count: 5, seed_prefix: 'web-demo', idempotency_key: 'web-42' }),
});
const result = await response.json();
```

### `GET /batches/{id}`
Liefert Status, Metriken und Fehler eines Batch-Auftrags. Aggregiert den Fortschritt aller Jobs (`queued`, `running`, `succeeded`,
`failed`, `canceled`) und listet erfolgreiche Level-IDs.

```bash
curl http://localhost:3000/batches/<batchId>
# {
#   "batch_id": "...",
#   "status": "partial",
#   "metrics": {"total":3,"succeeded":2,"failed":1,"avg_duration_ms":4200},
#   "jobs": [{"job_id":"...","status":"succeeded","level_id":"lvl-..."}],
#   "levels": ["lvl-..."],
#   "errors": [{"job_id":"...","message":"boom"}]
# }
```

### `GET /batches`
Listet die neuesten Batches (optional paginiert über `limit` und `cursor`). Ein Cursor entspricht dem `created_at`-Zeitstempel
des letzten Eintrags.

```bash
curl "http://localhost:3000/batches?limit=10"
```

Antwort:
```json
{
  "batches": [
    {
      "batch_id": "...",
      "status": "running",
      "requested_count": 10,
      "metrics": {"total":10,"queued":4,"running":6,"failed":0,"canceled":0,"avg_duration_ms":null},
      "request": {"count":10,"seed_prefix":"demo","difficulty_mode":"fixed"}
    }
  ],
  "next_cursor": 1710000000000
}
```

> **Idempotenz-Hinweis:** Wird ein `idempotency_key` mehrfach mit identischen Parametern verwendet, liefert die API denselben
> `batch_id`/`job_ids`-Satz zurück und startet keine neuen Jobs. Abweichende Parameter führen zu `409 idempotency_conflict`.

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
