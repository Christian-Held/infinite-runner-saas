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
  created_at: number;
  updated_at: number;
}

let dbInstance: Database.Database | null = null;

const DEFAULT_DB_PATH = './data/app.db';

function resolveDbPath(dbPath: string): string {
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
}

function ensureDirectoryFor(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function initDb(dbPath = process.env.DB_PATH ?? DEFAULT_DB_PATH): Database.Database {
  const resolvedPath = resolveDbPath(dbPath);
  ensureDirectoryFor(resolvedPath);

  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = new Database(resolvedPath);
  dbInstance.pragma('journal_mode = WAL');
  return dbInstance;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialised. Call initDb() first.');
  }
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function migrate() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS levels (
      id TEXT PRIMARY KEY,
      seed TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      tiles_json TEXT NOT NULL,
      moving_json TEXT NOT NULL,
      items_json TEXT NOT NULL,
      enemies_json TEXT NOT NULL,
      checkpoints_json TEXT NOT NULL,
      exit_json TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      level_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_levels_published ON levels(published);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);
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
    INSERT INTO jobs (id, type, status, level_id, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `);
  stmt.run(job.id, job.type, job.status, job.level_id ?? null, now, now);
}

export function updateJobStatus(id: string, status: JobStatus, options: { error?: string; levelId?: string } = {}) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE jobs
    SET status = ?,
        error = ?,
        level_id = COALESCE(?, level_id),
        updated_at = ?
    WHERE id = ?
  `);
  stmt.run(status, options.error ?? null, options.levelId ?? null, Date.now(), id);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isDbHealthy(): boolean {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    return true;
  } catch (error) {
    return false;
  }
}
