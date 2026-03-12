/**
 * installer/unpatch.js
 *
 * Restores Fluxer's original app.asar from the backup created by index.js,
 * removes the Reflux injection line from the unpacked preload file, and deletes
 * the backup so the system is back to its pristine state.
 *
 * Run with: node installer/unpatch.js
 * Override: FLUXER_ASAR=C:\...\app.asar node installer/unpatch.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ---------------------------------------------------------------------------
// Helpers — mirrors the search logic in index.js
// ---------------------------------------------------------------------------

const REFLUX_ROOT    = path.resolve(__dirname, '../..');
const REFLUX_PRELOAD = path.join(REFLUX_ROOT, 'src', 'preload.js');

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

const PRODUCT_DIRS = [
  path.join(LOCALAPPDATA, 'fluxer_app'),         // standard install (confirmed)
  path.join(LOCALAPPDATA, 'fluxer_app_canary'),  // canary variant (assumed)
  path.join(LOCALAPPDATA, 'Fluxer'),             // legacy / alternative name
  path.join(LOCALAPPDATA, 'Fluxer Canary'),
  path.join('C:\\', 'Program Files', 'Fluxer', 'resources'),
  path.join('C:\\', 'Program Files (x86)', 'Fluxer', 'resources'),
];

const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';

function findLatestResourcesDir(productDir) {
  if (!fs.existsSync(productDir)) return null;
  const appDirs = fs.readdirSync(productDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('app-'))
    .map(e => e.name)
    .sort()
    .reverse();
  for (const dir of appDirs) {
    const resources = path.join(productDir, dir, 'resources');
    const bak = path.join(resources, 'app.asar.bak');
    if (fs.existsSync(bak)) return resources;
  }
  return null;
}

function findResourcesDir() {
  if (process.env.FLUXER_ASAR) return path.dirname(process.env.FLUXER_ASAR);
  for (const dir of PRODUCT_DIRS) {
    if (fs.existsSync(path.join(dir, 'app.asar.bak'))) return dir;
    const resources = findLatestResourcesDir(dir);
    if (resources) return resources;
  }
  throw new Error(
    'Could not find app.asar.bak — Reflux may not be installed.\n' +
    'Searched:\n' + PRODUCT_DIRS.map(d => '  ' + d).join('\n')
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const resourcesDir = findResourcesDir();
  const asarPath     = path.join(resourcesDir, 'app.asar');
  const bakPath      = asarPath + '.bak';
  const unpackedDir  = asarPath + '.unpacked';

  console.log(`[Reflux] Resources dir: ${resourcesDir}`);

  // ── Step 1: Restore original asar ───────────────────────────────────────
  if (!fs.existsSync(bakPath)) {
    console.error('[Reflux] Backup not found. Cannot restore.');
    process.exit(1);
  }
  fs.copyFileSync(bakPath, asarPath);
  console.log(`[Reflux] Restored original asar from: ${bakPath}`);

  fs.unlinkSync(bakPath);
  console.log('[Reflux] Backup removed.');

  // ── Step 2: Ensure unpacked preload is clean ────────────────────────────
  // Reflux no longer patches the preload file (uses session.setPreloads instead),
  // but clean up any remnant from an older install just in case.
  const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
  if (fs.existsSync(unpackedPreload)) {
    const oldInjectLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
    const contents = fs.readFileSync(unpackedPreload, 'utf8');
    if (contents.startsWith(oldInjectLine)) {
      fs.writeFileSync(unpackedPreload, contents.slice(oldInjectLine.length), 'utf8');
      console.log('[Reflux] Removed legacy preload injection line.');
    }
  }

  // ── Step 3: Clean up any leftover temp directories ──────────────────────
  for (const suffix of ['.reflux-tmp', '.reflux-full-extract']) {
    const tmpDir = path.join(resourcesDir, suffix);
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
      console.log(`[Reflux] Removed temp dir: ${tmpDir}`);
    }
  }

  console.log('\n[Reflux] Unpatched successfully. Restart Fluxer to apply.');
}

try {
  main();
} catch (err) {
  console.error('[Reflux] Unpatch failed:', err.message);
  process.exit(1);
}
