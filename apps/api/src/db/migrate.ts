import type Database from 'better-sqlite3';

import { closeDb, openDb } from './index';

interface ColumnInfo {
  name: string;
}

export async function migrate(db: Database.Database): Promise<void> {
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
      attempts INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all() as ColumnInfo[];
  const hasAttempts = jobColumns.some((column) => column.name === 'attempts');
  const hasLastReason = jobColumns.some((column) => column.name === 'last_reason');
  if (!hasAttempts) {
    db.exec('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasLastReason) {
    db.exec('ALTER TABLE jobs ADD COLUMN last_reason TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS level_paths (
      level_id TEXT PRIMARY KEY,
      path_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS level_revisions (
      id TEXT PRIMARY KEY,
      level_id TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS level_metrics (
      level_id TEXT PRIMARY KEY,
      score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS level_meta (
      level_id TEXT PRIMARY KEY,
      biome TEXT NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      requested_count INTEGER NOT NULL,
      params_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(idempotency_key)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      job_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      level_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      level_number INTEGER,
      seed TEXT,
      difficulty INTEGER,
      FOREIGN KEY(batch_id) REFERENCES batches(id),
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches(created_at DESC);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_batch_id ON batch_jobs(batch_id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS season_jobs (
      season_id TEXT NOT NULL,
      level_number INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      level_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (season_id, level_number),
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_levels_published ON levels(published);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_season_jobs_status ON season_jobs(status);`);

  console.log('migrate: ok');
}

async function run() {
  const db = openDb();
  try {
    await migrate(db);
  } finally {
    closeDb();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
