import { closeDb, initDb, migrate } from './db';

async function run() {
  initDb();
  migrate();
  closeDb();
}

run().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
