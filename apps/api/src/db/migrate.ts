import type Database from 'better-sqlite3';

import { closeDb, openDb } from './index';

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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS level_paths (
      level_id TEXT PRIMARY KEY,
      path_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(level_id) REFERENCES levels(id)
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_levels_published ON levels(published);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);

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
