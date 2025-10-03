# Infinite Runner SaaS

Welcome! This guide is written for newcomers who need to stand up the full Infinite Runner SaaS stack without surprises. Follow the steps below exactly the first time you get the repo on a Windows machine using PowerShell.

## Quick Start (Windows, PowerShell)

> **Tip:** Open PowerShell as Administrator when you need to manage Docker or services. All commands below are safe to copy & paste.

1. **Update your working tree safely**
   ```powershell
   git status
   git stash push --include-untracked --message "wip" # only if you have changes
   git config --global rebase.autoStash true
   git pull --rebase
   git stash pop
   ```
2. **Stop any lingering services**
   ```powershell
   docker compose down --remove-orphans
   Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
   ```
3. **Install dependencies & rebuild native modules**
   ```powershell
   pnpm install
   pnpm -r rebuild better-sqlite3
   ```
4. **Prepare infrastructure**
   ```powershell
   docker compose up redis -d
   ```
5. **Start each service in its own terminal**
   - **API (Fastify + SQLite):**
     ```powershell
     pnpm --filter api run dev:direct
     ```
   - **Web (Next.js client):**
     ```powershell
     pnpm --filter web dev
     ```
   - **Playtester workers:**
     ```powershell
     pnpm --filter @srv/playtester dev
     ```
6. **Health check**
   ```powershell
   Invoke-RestMethod http://localhost:3000/health | Format-List
   ```
7. **Smoke test**
   - Open <http://localhost:3000/internal/demo> in a browser (use `x-internal-token` header via a REST client if calling APIs directly).
   - Ensure Redis metrics: `http://localhost:9100/metrics`.

## "All in Docker" Mode

To run everything in containers (no local Node processes):

```powershell
docker compose up --build
```

* Containers expose the same ports (API 3000, Web 3001, Metrics 9100).
* Use `docker compose logs -f <service>` for streaming logs.
* Stop and clean up with:
  ```powershell
  docker compose down --remove-orphans --volumes
  ```

## Environment Files

Never commit secrets. Always work from the provided `.env.example` templates.

| Location | Purpose | Example safe values |
| --- | --- | --- |
| `apps/api/.env` | API defaults (Redis, internal auth). | ```env
REDIS_URL=redis://localhost:6379
INTERNAL_TOKEN=dev-internal
LOG_LEVEL=debug
``` |
| `services/playtester/.env` | Worker credentials (OpenAI key, Redis). | ```env
OPENAI_API_KEY=sk-your-dev-token
REDIS_URL=redis://localhost:6379
TUNE_MAX_ROUNDS=3
``` |

> ⚠️ **Do not commit secrets.** Keep `.env` files out of Git (`.gitignore` already does).

## Commands Reference

| Service | Command (PowerShell) | Port(s) | Notes |
| --- | --- | --- | --- |
| API | `pnpm --filter api run dev:direct` | 3000 | Logs in `.logs/api-*.log` and stdout. |
| Web | `pnpm --filter web dev` | 3001 | Next.js dev server. |
| Playtester | `pnpm --filter @srv/playtester dev` | 9100 (metrics) | Worker logs in `.logs/playtester-*.log`. |
| Redis (Docker) | `docker compose up redis -d` | 6379 | Data stored in Docker volume `infinite-runner-saas_redis-data`. |

## Logging

* API logs rotate daily at `.logs/api-YYYY-MM-DD.log` and the playtester rotates under `.logs/playtester-YYYY-MM-DD.log`.
* Tail logs in PowerShell with `Get-Content .\.logs\api-$(Get-Date -Format 'yyyy-MM-dd').log -Wait` (replace `api` with `playtester` as needed).
* On startup the API and workers log their BullMQ queue names and prefix—use those messages to diagnose queue routing issues.
* When `OPENAI_API_KEY` is missing the playtester logs an error before processing jobs; add the key and restart the worker.
* Do not record secrets in log files; redact tokens before sharing snippets.

## Reset & Recovery Recipes

| Situation | Command(s) |
| --- | --- |
| Free port 3000 | `Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process -Force` |
| Restart Docker Desktop service | `Restart-Service com.docker.service` (run as Administrator) |
| Clear local SQLite data | `Remove-Item apps\api\data\*.db -Force` then rerun migrations via `pnpm --filter api migrate` |
| Fresh Redis state | `docker compose down --volumes` followed by `docker compose up redis -d` |

## Troubleshooting Matrix

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| API unreachable (`ECONNREFUSED`) | API not running or port blocked. | Restart API terminal, ensure port 3000 free, re-run health check. |
| Queue stuck in `queued` | Redis unreachable or workers down. | Verify Redis container (`docker ps`), restart playtester service. |
| `OPENAI_API_KEY` missing warning | Playtester started without key; startup logs show the error. | Add key to `services/playtester/.env`, restart worker. |
| Jobs queued but never processed despite workers running | Queue prefix mismatch between API and workers. | Compare queue prefix in API and worker startup logs; align `QUEUE_PREFIX` and restart both. |
| Redis URL mismatch between services | Different `REDIS_URL` envs. | Align `.env` values and restart API + workers. |
| HTTP 401 on `/internal/*` | Wrong `x-internal-token`. | Confirm token from `.env` matches request header; check API startup log for the expected token name. |

## Testing & Coverage

* Run the entire monorepo suite with coverage: `pnpm -r test` (uses `vitest.workspace.ts`).
* Run a single workspace with coverage targets:
  * API: `pnpm --filter api exec vitest run --coverage`
  * Playtester: `pnpm --filter @srv/playtester exec vitest run --coverage`
  * Web: `pnpm --filter web exec vitest run --coverage`
  * Game spec: `pnpm --filter @ir/game-spec exec vitest run --coverage`
* Each suite enforces ≥90% line and branch coverage—review the Vitest summary before merging.

## Repository Map

```
apps/            # Frontend (web) and backend (api)
packages/        # Shared libraries (game spec, logger)
services/        # Long-running workers (playtester)
.logs/           # Daily-rotated service logs (created on demand)
deploy/          # Deployment manifests & scripts
scripts/         # Windows helper scripts
```

### Data Locations

* SQLite files: `apps/api/data/*.db`
* Redis state: Docker volume `infinite-runner-saas_redis-data`
* Metrics snapshots: Export via Prometheus scrape (`/metrics` endpoints)

## Security Notes

* `INTERNAL_TOKEN` secures all `/internal/*` API routes. In development, the server defaults to `dev-internal`. In production set a strong random string and **never** share it publicly.
* Store real secrets in a secure vault. Treat `.env` files as developer-only artifacts.

Happy building! Reach out in Slack `#infinite-runner` if you get stuck.
