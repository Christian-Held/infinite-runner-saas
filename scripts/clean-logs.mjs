import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const logDirEnv = process.env.LOG_DIR?.trim();
const repoRoot = process.cwd();
const logRoot = logDirEnv && logDirEnv.length > 0 ? path.resolve(logDirEnv) : path.join(repoRoot, 'logs');

if (!fs.existsSync(logRoot)) {
  console.log(`No logs directory at ${logRoot}`);
  process.exit(0);
}

fs.rmSync(logRoot, { recursive: true, force: true });
console.log(`Removed log directory: ${logRoot}`);
