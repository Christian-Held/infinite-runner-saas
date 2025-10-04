import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const service = process.argv[2];
if (!service) {
  console.error('Usage: node scripts/tail-log.mjs <service>');
  process.exit(1);
}

const logDirEnv = process.env.LOG_DIR?.trim();
const repoRoot = process.cwd();
const logRoot = logDirEnv && logDirEnv.length > 0 ? path.resolve(logDirEnv) : path.join(repoRoot, 'logs');
const serviceDir = path.join(logRoot, service);

if (!fs.existsSync(serviceDir)) {
  console.error(`No log directory for service '${service}' at ${serviceDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(serviceDir)
  .filter((file) => file.startsWith('run-') && file.endsWith('.log'))
  .sort();

const latest = files.at(-1);
if (!latest) {
  console.error(`No run logs found for service '${service}' in ${serviceDir}`);
  process.exit(1);
}

const filePath = path.join(serviceDir, latest);
console.log(`Tailing ${filePath}`);

let position = 0;

function readFrom(offset) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', start: offset });
  stream.on('data', (chunk) => {
    position += Buffer.byteLength(chunk);
    process.stdout.write(chunk);
  });
}

readFrom(0);

fs.watch(filePath, (eventType) => {
  if (eventType !== 'change') {
    return;
  }
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= position) {
      return;
    }
    readFrom(position);
  } catch (error) {
    console.error('Failed to read updated log file:', error);
  }
});
