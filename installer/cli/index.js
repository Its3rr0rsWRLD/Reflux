/**
 * installer/index.js
 *
 * Locates Fluxer's installed resources on Windows and injects Reflux by:
 *
 *   1. Backing up the original app.asar as app.asar.bak (idempotent).
 *   2. Injecting into the already-unpacked preload script
 *      (app.asar.unpacked/src-electron/dist/preload/index.js) — no repacking
 *      needed because Electron always reads this file from the filesystem.
 *   3. Injecting a `await import(...)` line into the main-process entry inside
 *      app.asar so that Reflux's main-side code (CSP stripping, content script
 *      injection) runs before any Fluxer windows are created.
 *
 * Fluxer uses the Squirrel Windows installer, so the install path is:
 *   %LOCALAPPDATA%\Fluxer\app-<version>\resources\
 *   %LOCALAPPDATA%\Fluxer Canary\app-<version>\resources\   (canary builds)
 *
 * Run with: node installer/index.js
 * Override asar path: FLUXER_ASAR=C:\...\app.asar node installer/index.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const asar = require('@electron/asar');
const {pathToFileURL} = require('url');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// When compiled with pkg, __dirname is a virtual snapshot path.
// Use the exe's actual directory and navigate up to the repo root instead.
const _BASE = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const REFLUX_ROOT   = path.resolve(_BASE, '..');
const REFLUX_MAIN   = path.join(REFLUX_ROOT, 'src', 'main-inject.mjs');
const REFLUX_PRELOAD = path.join(REFLUX_ROOT, 'src', 'preload.js');

/**
 * Squirrel installs Fluxer into versioned subdirectories under %LOCALAPPDATA%.
 * We search inside each product name's folder for the latest app-<version>.
 */
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

const PRODUCT_DIRS = [
  path.join(LOCALAPPDATA, 'fluxer_app'),         // standard install (confirmed)
  path.join(LOCALAPPDATA, 'fluxer_app_canary'),  // canary variant (assumed)
  path.join(LOCALAPPDATA, 'Fluxer'),             // legacy / alternative name
  path.join(LOCALAPPDATA, 'Fluxer Canary'),
  // Traditional installers:
  path.join('C:\\', 'Program Files', 'Fluxer', 'resources'),
  path.join('C:\\', 'Program Files (x86)', 'Fluxer', 'resources'),
];

/** Path inside the asar where the main-process entry lives (ESM). */
const ASAR_MAIN_ENTRY = 'src-electron/dist/main/index.js';

/** Path inside the asar where the preload entry lives (also unpacked to disk). */
const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Within a Squirrel product directory, find the resources folder of the latest
 * installed version (app-<semver>/resources).
 * @param {string} productDir  e.g. %LOCALAPPDATA%\Fluxer
 * @returns {string|null}
 */
function findLatestResourcesDir(productDir) {
  if (!fs.existsSync(productDir)) return null;

  const appDirs = fs.readdirSync(productDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('app-'))
    .map(e => e.name)
    .sort()          // lexicographic sort is fine for semver-like "app-1.2.3"
    .reverse();      // newest first

  for (const dir of appDirs) {
    const resources = path.join(productDir, dir, 'resources');
    const asarPath  = path.join(resources, 'app.asar');
    if (fs.existsSync(asarPath)) return resources;
  }
  return null;
}

/**
 * Locate Fluxer's resources directory.
 * @returns {string}
 */
function findResourcesDir() {
  if (process.env.FLUXER_ASAR) {
    return path.dirname(process.env.FLUXER_ASAR);
  }

  for (const dir of PRODUCT_DIRS) {
    // Direct resources dir (Program Files style).
    if (fs.existsSync(path.join(dir, 'app.asar'))) return dir;
    // Squirrel style — find latest versioned subdir.
    const resources = findLatestResourcesDir(dir);
    if (resources) return resources;
  }

  throw new Error(
    'Could not locate Fluxer\'s resources directory.\n' +
    'Searched:\n' + PRODUCT_DIRS.map(d => '  ' + d).join('\n') + '\n' +
    'Set FLUXER_ASAR=/full/path/to/app.asar and retry.'
  );
}

/**
 * Prepend `line` to a file if it isn't already the first line.
 * Returns true if the file was modified, false if it was already patched.
 * @param {string} filePath
 * @param {string} line
 * @returns {boolean}
 */
function prependOnce(filePath, line) {
  const contents = fs.readFileSync(filePath, 'utf8');
  if (contents.startsWith(line)) {
    return false; // already injected
  }
  fs.writeFileSync(filePath, line + '\n' + contents, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const resourcesDir = findResourcesDir();
  const asarPath     = path.join(resourcesDir, 'app.asar');
  const bakPath      = asarPath + '.bak';
  const unpackedDir  = asarPath + '.unpacked'; // Electron's standard name

  console.log(`[Reflux] Resources dir: ${resourcesDir}`);

  // ── Step 1: Backup ──────────────────────────────────────────────────────
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(asarPath, bakPath);
    console.log(`[Reflux] Backup created: ${bakPath}`);
  } else {
    console.log(`[Reflux] Backup already present: ${bakPath}`);
  }

  // ── Step 2: Clean up any old preload injection (from a previous approach) ──
  // Sandboxed preloads cannot require() arbitrary files outside the asar.
  // Reflux's preload is now loaded via session.setPreloads() in main-inject.mjs,
  // so any previously injected require() line must be removed.
  const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
  if (fs.existsSync(unpackedPreload)) {
    const oldInjectLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
    let contents = fs.readFileSync(unpackedPreload, 'utf8');
    if (contents.startsWith(oldInjectLine)) {
      fs.writeFileSync(unpackedPreload, contents.slice(oldInjectLine.length), 'utf8');
      console.log('[Reflux] Removed old preload injection line.');
    }
  }

  // ── Step 3: Patch the main-process entry inside the asar ────────────────
  // We need to inject our main-side bootstrap so Reflux can:
  //  • Strip CSP headers (allowing renderer content-script injection)
  //  • Inject renderer.js into the web context via webContents events
  //
  // The main entry is ESM (type: "module"), so we use top-level await + dynamic import.
  const tmpDir = path.join(resourcesDir, '.reflux-tmp');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(tmpDir);

  console.log('[Reflux] Extracting asar to patch main entry…');
  // Extract only the main entry file for efficiency; fall back to full extract.
  try {
    asar.extractFile(asarPath, ASAR_MAIN_ENTRY, path.join(tmpDir, 'main_index.js'));
  } catch {
    asar.extractAll(asarPath, tmpDir);
  }

  const mainEntryInTmp = path.join(tmpDir, 'main_index.js');
  if (!fs.existsSync(mainEntryInTmp)) {
    // Full extract fallback.
    asar.extractAll(asarPath, tmpDir);
    const fullPath = path.join(tmpDir, ...ASAR_MAIN_ENTRY.split('/'));
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Cannot find ${ASAR_MAIN_ENTRY} inside the asar.`);
    }
    // Re-point.
    fs.copyFileSync(fullPath, mainEntryInTmp);
  }

  // Injection line — dynamic import works in top-level ESM.
  // On Windows, dynamic import() requires a file:// URL — raw C:\... paths are rejected by the ESM loader.
  const mainInjectUrl  = pathToFileURL(REFLUX_MAIN).href;
  const mainInjectLine = `await import(${JSON.stringify(mainInjectUrl)});`;
  const alreadyPatched = prependOnce(mainEntryInTmp, mainInjectLine);

  if (!alreadyPatched) {
    console.log('[Reflux] Main entry already patched — skipping asar repack.');
    fs.rmSync(tmpDir, { recursive: true });
  } else {
    // We only changed one file — do a full extract + replace + repack.
    const fullExtractDir = path.join(resourcesDir, '.reflux-full-extract');
    if (fs.existsSync(fullExtractDir)) fs.rmSync(fullExtractDir, { recursive: true });

    console.log('[Reflux] Extracting full asar for repack…');
    asar.extractAll(asarPath, fullExtractDir);

    // Replace the main entry with our patched version.
    const mainEntryInFull = path.join(fullExtractDir, ...ASAR_MAIN_ENTRY.split('/'));
    fs.copyFileSync(mainEntryInTmp, mainEntryInFull);

    console.log('[Reflux] Repacking asar…');
    await asar.createPackage(fullExtractDir, asarPath);

    fs.rmSync(tmpDir, { recursive: true });
    fs.rmSync(fullExtractDir, { recursive: true });

    console.log(`[Reflux] Main entry patched: ${ASAR_MAIN_ENTRY}`);
  }

  console.log('\n[Reflux] Installation complete! Restart Fluxer to activate Reflux.');
}

main().catch(err => {
  console.error('[Reflux] Installation failed:', err.message);
  process.exit(1);
});
