/**
 * Strips UTF-8 BOM from config files before Vite starts.
 * Runs automatically via the "predev"/"prebuild" npm hooks.
 *
 * Background: some Windows editors save files as "UTF-8 with BOM".
 * npm tolerates the BOM, but Vite's PostCSS config search parses
 * package.json strictly and crashes on it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html'];

for (const file of files) {
  try {
    const buf = readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      writeFileSync(file, buf.subarray(3));
      console.log(`[fix-bom] BOM entfernt: ${file}`);
    }
  } catch {
    // file missing — nothing to fix
  }
}
