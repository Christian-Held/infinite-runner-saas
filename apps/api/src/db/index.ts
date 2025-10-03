import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { Level, LevelT, type Biome } from '@ir/game-spec';

export type JobType = 'gen' | 'test';
export type JobStatus = 'queued' | 'running' | 'failed' | 'succeeded';
export type SeasonJobStatus = 'queued' | 'running' | 'failed' | 'succeeded';

export interface LevelMetricRecord {
  levelId: string;
  score: number;
  createdAt: number;
}

export interface SeasonJobRecord {
  seasonId: string;
  levelNumber: number;
  jobId: string | null;
  status: SeasonJobStatus;
  levelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SeasonLevelInfo {
  seasonId: string;
  levelNumber: number;
  status: SeasonJobStatus;
  jobId: string | null;
  levelId: string | null;
  published: boolean;
  score: number | null;
  updatedAt: number;
}

export interface SeasonStatusSummary {
  seasonId: string;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  levelId: string | null;
  error: string | null;
  attempts: number;
  lastReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LevelRecord {
  level: LevelT;
  published: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LevelMetaRecord {
  levelId: string;
  biome: Biome;
}

interface LevelRow {
  id: string;
  seed: string;
  rules_json: string;
  tiles_json: string;
  moving_json: string;
  items_json: string;
  enemies_json: string;
  checkpoints_json: string;
  exit_json: string;
  difficulty: number;
  published: number;
  created_at: number;
  updated_at: number;
}

interface LevelMetaRow {
  level_id: string;
  biome: string;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  level_id: string | null;
  error: string | null;
  attempts: number;
  last_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface LevelPathRow {
  level_id: string;
  path_json: string;
  created_at: number;
  updated_at: number;
}

interface LevelRevisionRow {
  id: string;
  level_id: string;
  patch_json: string;
  reason: string;
  created_at: number;
}

interface LevelMetricRow {
  level_id: string;
  score: number;
  created_at: number;
}

interface SeasonJobRow {
  season_id: string;
  level_number: number;
  job_id: string | null;
  status: string;
  level_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface LevelRevisionRecord {
  id: string;
  levelId: string;
  patch: unknown;
  reason: string;
  createdAt: number;
}

const DEFAULT_DB_PATH = './data/app.db';

let dbInstance: Database.Database | null = null;

function resolveDbPath(dbPath: string): string {
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
}

function ensureDirectoryFor(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function openDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH;
  const resolvedPath = resolveDbPath(dbPath);
  ensureDirectoryFor(resolvedPath);

  try {
    dbInstance = new Database(resolvedPath);
    dbInstance.pragma('journal_mode = WAL');
    return dbInstance;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to open database at ${resolvedPath}: ${message}`);
  }
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    return openDb();
  }
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function rowToLevel(row: LevelRow): LevelT {
  const level: LevelT = {
    id: row.id,
    seed: row.seed,
    rules: JSON.parse(row.rules_json),
    tiles: JSON.parse(row.tiles_json),
    moving: JSON.parse(row.moving_json),
    items: JSON.parse(row.items_json),
    enemies: JSON.parse(row.enemies_json),
    checkpoints: JSON.parse(row.checkpoints_json),
    exit: JSON.parse(row.exit_json),
  };

  return Level.parse(level);
}

export function insertLevel(level: LevelT, meta: { difficulty: number; seed: string }) {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO levels (
      id, seed, rules_json, tiles_json, moving_json, items_json,
      enemies_json, checkpoints_json, exit_json, difficulty, published, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  stmt.run(
    level.id,
    meta.seed,
    JSON.stringify(level.rules),
    JSON.stringify(level.tiles),
    JSON.stringify(level.moving ?? []),
    JSON.stringify(level.items ?? []),
    JSON.stringify(level.enemies ?? []),
    JSON.stringify(level.checkpoints ?? []),
    JSON.stringify(level.exit),
    meta.difficulty,
    now,
    now,
  );
}

export function upsertLevelMeta(levelId: string, biome: Biome): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO level_meta (level_id, biome)
    VALUES (?, ?)
    ON CONFLICT(level_id) DO UPDATE SET biome = excluded.biome
  `);
  stmt.run(levelId, biome);
}

export function getLevelMeta(levelId: string): LevelMetaRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT level_id, biome FROM level_meta WHERE level_id = ?')
    .get(levelId) as LevelMetaRow | undefined;
  if (!row) {
    return null;
  }
  return { levelId: row.level_id, biome: row.biome as Biome };
}

export function updateLevel(level: LevelT) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE levels
    SET rules_json = ?,
        tiles_json = ?,
        moving_json = ?,
        items_json = ?,
        enemies_json = ?,
        checkpoints_json = ?,
        exit_json = ?,
        updated_at = ?
    WHERE id = ?
  `);
  stmt.run(
    JSON.stringify(level.rules),
    JSON.stringify(level.tiles),
    JSON.stringify(level.moving ?? []),
    JSON.stringify(level.items ?? []),
    JSON.stringify(level.enemies ?? []),
    JSON.stringify(level.checkpoints ?? []),
    JSON.stringify(level.exit),
    Date.now(),
    level.id,
  );
}

export function insertLevelRevision(params: {
  id: string;
  levelId: string;
  patch: unknown;
  reason: string;
  createdAt?: number;
}) {
  const db = getDb();
  const createdAt = params.createdAt ?? Date.now();
  const stmt = db.prepare(`
    INSERT INTO level_revisions (id, level_id, patch_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(params.id, params.levelId, JSON.stringify(params.patch ?? {}), params.reason, createdAt);
}

export function listLevelRevisions(levelId: string): LevelRevisionRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM level_revisions WHERE level_id = ? ORDER BY created_at DESC')
    .all(levelId) as LevelRevisionRow[];
  return rows.map((row) => {
    let patch: unknown = null;
    try {
      patch = JSON.parse(row.patch_json);
    } catch {
      patch = null;
    }
    return {
      id: row.id,
      levelId: row.level_id,
      patch,
      reason: row.reason,
      createdAt: row.created_at,
    };
  });
}

export function upsertLevelMetric(
  levelId: string,
  score: number,
  createdAt: number = Date.now(),
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO level_metrics (level_id, score, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(level_id) DO UPDATE SET
      score = excluded.score,
      created_at = excluded.created_at
  `);
  stmt.run(levelId, score, createdAt);
}

export function getLevelMetric(levelId: string): LevelMetricRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM level_metrics WHERE level_id = ?').get(levelId) as
    | LevelMetricRow
    | undefined;
  if (!row) {
    return null;
  }
  return { levelId: row.level_id, score: row.score, createdAt: row.created_at };
}

export function getLevel(id: string): LevelT | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM levels WHERE id = ?').get(id) as LevelRow | undefined;
  if (!row) {
    return null;
  }

  return rowToLevel(row);
}

export function listLevels(params: {
  published?: boolean;
  limit?: number;
  offset?: number;
}): LevelRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (typeof params.published === 'boolean') {
    conditions.push('published = ?');
    values.push(params.published ? 1 : 0);
  }

  let query = 'SELECT * FROM levels';
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }
  query += ' ORDER BY created_at DESC';

  if (typeof params.limit === 'number') {
    query += ' LIMIT ?';
    values.push(params.limit);
  }

  if (typeof params.offset === 'number') {
    query += ' OFFSET ?';
    values.push(params.offset);
  }

  const rows = db.prepare(query).all(...values) as LevelRow[];

  return rows.map((row) => ({
    level: rowToLevel(row),
    published: Boolean(row.published),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function setPublished(id: string, published: boolean): boolean {
  const db = getDb();
  const stmt = db.prepare('UPDATE levels SET published = ?, updated_at = ? WHERE id = ?');
  const result = stmt.run(published ? 1 : 0, Date.now(), id);
  return result.changes > 0;
}

export function insertJob(job: {
  id: string;
  type: JobType;
  status: JobStatus;
  level_id?: string | null;
}) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO jobs (id, type, status, level_id, error, attempts, last_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 0, NULL, ?, ?)
  `);
  stmt.run(job.id, job.type, job.status, job.level_id ?? null, now, now);
}

export function updateJobStatus(
  id: string,
  status: JobStatus,
  options: { error?: string; levelId?: string; attempts?: number; lastReason?: string } = {},
) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE jobs
    SET status = ?,
        error = ?,
        level_id = COALESCE(?, level_id),
        attempts = COALESCE(?, attempts),
        last_reason = COALESCE(?, last_reason),
        updated_at = ?
    WHERE id = ?
  `);
  stmt.run(
    status,
    options.error ?? null,
    options.levelId ?? null,
    options.attempts ?? null,
    options.lastReason ?? null,
    Date.now(),
    id,
  );
}

export function getJob(id: string): JobRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    levelId: row.level_id ?? null,
    error: row.error ?? null,
    attempts: row.attempts ?? 0,
    lastReason: row.last_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertLevelPath(levelId: string, path: unknown): void {
  const db = getDb();
  const now = Date.now();
  const payload = JSON.stringify(path ?? []);
  const stmt = db.prepare(`
    INSERT INTO level_paths (level_id, path_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(level_id) DO UPDATE SET path_json = excluded.path_json, updated_at = excluded.updated_at
  `);
  stmt.run(levelId, payload, now, now);
}

export function getLevelPath(levelId: string): unknown | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM level_paths WHERE level_id = ?').get(levelId) as
    | LevelPathRow
    | undefined;
  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.path_json);
  } catch {
    return null;
  }
}

export function upsertSeasonJob(params: {
  seasonId: string;
  levelNumber: number;
  jobId: string;
  status: SeasonJobStatus;
  levelId?: string | null;
  createdAt?: number;
}): void {
  const db = getDb();
  const now = params.createdAt ?? Date.now();
  const stmt = db.prepare(`
    INSERT INTO season_jobs (season_id, level_number, job_id, status, level_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season_id, level_number) DO UPDATE SET
      job_id = excluded.job_id,
      status = excluded.status,
      level_id = COALESCE(excluded.level_id, season_jobs.level_id),
      updated_at = excluded.updated_at
  `);
  stmt.run(
    params.seasonId,
    params.levelNumber,
    params.jobId,
    params.status,
    params.levelId ?? null,
    now,
    now,
  );
}

export function updateSeasonJob(params: {
  seasonId: string;
  levelNumber: number;
  status: SeasonJobStatus;
  jobId?: string;
  levelId?: string | null;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE season_jobs
    SET status = ?,
        job_id = COALESCE(?, job_id),
        level_id = COALESCE(?, level_id),
        updated_at = ?
    WHERE season_id = ? AND level_number = ?
  `);
  stmt.run(
    params.status,
    params.jobId ?? null,
    params.levelId ?? null,
    Date.now(),
    params.seasonId,
    params.levelNumber,
  );
}

export function getSeasonStatus(seasonId: string): SeasonStatusSummary {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT status, COUNT(*) as count FROM season_jobs WHERE season_id = ? GROUP BY status',
    )
    .all(seasonId) as Array<{ status: string; count: number }>;

  const summary: SeasonStatusSummary = {
    seasonId,
    total: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  };

  for (const row of rows) {
    const count = row.count ?? 0;
    summary.total += count;
    if (row.status === 'queued') {
      summary.queued = count;
    } else if (row.status === 'running') {
      summary.running = count;
    } else if (row.status === 'succeeded') {
      summary.succeeded = count;
    } else if (row.status === 'failed') {
      summary.failed = count;
    }
  }

  if (summary.total === 0) {
    const countRow = db
      .prepare('SELECT COUNT(*) as total FROM season_jobs WHERE season_id = ?')
      .get(seasonId) as { total?: number } | undefined;
    summary.total = countRow?.total ?? 0;
  }

  return summary;
}

export function listSeasonLevels(params: {
  seasonId: string;
  published?: boolean;
}): SeasonLevelInfo[] {
  const db = getDb();
  const values: unknown[] = [params.seasonId];
  let query = `
    SELECT sj.season_id, sj.level_number, sj.job_id, sj.status, sj.level_id, sj.updated_at,
           lvl.published as level_published, metrics.score as level_score
    FROM season_jobs sj
    LEFT JOIN levels lvl ON lvl.id = sj.level_id
    LEFT JOIN level_metrics metrics ON metrics.level_id = sj.level_id
    WHERE sj.season_id = ?
  `;

  if (typeof params.published === 'boolean') {
    query += ' AND COALESCE(lvl.published, 0) = ?';
    values.push(params.published ? 1 : 0);
  }

  query += ' ORDER BY sj.level_number ASC';

  const rows = db.prepare(query).all(...values) as Array<
    SeasonJobRow & { level_published: number | null; level_score: number | null }
  >;

  return rows.map((row) => ({
    seasonId: row.season_id,
    levelNumber: row.level_number,
    jobId: row.job_id,
    status: row.status as SeasonJobStatus,
    levelId: row.level_id,
    published: Boolean(row.level_published ?? 0),
    score: typeof row.level_score === 'number' ? row.level_score : null,
    updatedAt: row.updated_at,
  }));
}

export function pingDb(database: Database.Database = getDb()): boolean {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
