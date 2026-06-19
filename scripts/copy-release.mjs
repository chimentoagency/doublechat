import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const outDir = 'release';
mkdirSync(outDir, { recursive: true });

// Tauri outputs NSIS (.exe) and MSI; grab both
const targets = [
  { dir: 'src-tauri/target/release/bundle/nsis', ext: '.exe' },
  { dir: 'src-tauri/target/release/bundle/msi',  ext: '.msi' },
];

let copied = 0;
for (const { dir, ext } of targets) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter(f => f.endsWith(ext))) {
    const dest = join(outDir, file);
    copyFileSync(join(dir, file), dest);
    console.log(`  → release/${file}`);
    copied++;
  }
}

if (copied === 0) {
  console.error('No installer found. Run `npm run tauri build` first.');
  process.exit(1);
}
console.log(`\nInstaller(s) copied to /${outDir}/`);
