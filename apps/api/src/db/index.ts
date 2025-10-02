import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { Level, LevelT } from '@ir/game-spec';

export type JobType = 'gen' | 'test';
export type JobStatus = 'queued' | 'running' | 'failed' | 'succeeded';

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

export function insertLevelRevision(params: { id: string; levelId: string; patch: unknown; reason: string; createdAt?: number }) {
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
    } catch (error) {
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

export function getLevel(id: string): LevelT | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM levels WHERE id = ?').get(id) as LevelRow | undefined;
  if (!row) {
    return null;
  }

  return rowToLevel(row);
}

export function listLevels(params: { published?: boolean; limit?: number; offset?: number }): LevelRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: any[] = [];

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

export function insertJob(job: { id: string; type: JobType; status: JobStatus; level_id?: string | null }) {
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
  const row = db.prepare('SELECT * FROM level_paths WHERE level_id = ?').get(levelId) as LevelPathRow | undefined;
  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.path_json);
  } catch (error) {
    return null;
  }
}

export function pingDb(database: Database.Database = getDb()): boolean {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch (error) {
    return false;
  }
}
