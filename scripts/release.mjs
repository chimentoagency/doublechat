import { mkdirSync, readdirSync, copyFileSync, existsSync, createWriteStream } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

// ── Logging setup ─────────────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync('logs', { recursive: true });
const logPath = join('logs', `build-${timestamp}.log`);
const logStream = createWriteStream(logPath);

function log(text) {
  process.stdout.write(text);
  logStream.write(text);
}

log(`DoubleChat release build\n`);
log(`Started : ${new Date().toLocaleString()}\n`);
log(`${'─'.repeat(60)}\n\n`);

// ── Tauri build ───────────────────────────────────────────────────────────────

const isWin = process.platform === 'win32';
const tauriBin = join('node_modules', '.bin', isWin ? 'tauri.cmd' : 'tauri');

const buildCode = await new Promise((resolve) => {
  const proc = spawn(tauriBin, ['build'], { stdio: ['inherit', 'pipe', 'pipe'], shell: true });
  proc.stdout.on('data', (d) => log(d.toString()));
  proc.stderr.on('data', (d) => log(d.toString()));
  proc.on('close', resolve);
});

if (buildCode !== 0) {
  log(`\n✗ Build failed (exit code ${buildCode})\n`);
  log(`Log saved → ${logPath}\n`);
  logStream.end();
  process.exit(buildCode);
}

// ── Copy installer to /release ────────────────────────────────────────────────

log(`\n${'─'.repeat(60)}\n`);
mkdirSync('release', { recursive: true });

const targets = [
  { dir: join('src-tauri', 'target', 'release', 'bundle', 'nsis'), ext: '.exe' },
  { dir: join('src-tauri', 'target', 'release', 'bundle', 'msi'),  ext: '.msi' },
];

let copied = 0;
for (const { dir, ext } of targets) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(ext))) {
    copyFileSync(join(dir, file), join('release', file));
    log(`Copied  → release/${file}\n`);
    copied++;
  }
}

if (copied === 0) {
  log('✗ No installer found in bundle output.\n');
  logStream.end();
  process.exit(1);
}

log(`\nFinished: ${new Date().toLocaleString()}\n`);
log(`Log saved → ${logPath}\n`);
logStream.end();
