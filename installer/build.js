'use strict';

/**
 * installer/build.js
 *
 * Builds both Windows installer artifacts and places them in installer/dist/:
 *
 *   reflux-v{version}-win-x64-setup.exe  — GUI (Electron portable, bundles src/)
 *   reflux-v{version}-win-x64-cli.exe    — CLI (pkg single-file, run from repo root)
 *
 * Usage:
 *   node installer/build.js          (from repo root)
 *   node build.js                    (from installer/)
 *
 * Prerequisites: pnpm install inside installer/ first.
 */

const {execSync} = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname; // installer/
const {version} = require(path.join(ROOT, 'package.json'));
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, {recursive: true});

const tag = `v${version}`;
const platform = 'win-x64';

console.log(`\nBuilding Reflux ${tag} — Windows x64\n${'─'.repeat(44)}`);

// ── 1. GUI: electron-builder portable ────────────────────────────────────────
console.log('\n[1/2] GUI installer (electron-builder portable)…');

execSync('pnpm exec electron-builder --win portable --publish never', {
	cwd: ROOT,
	stdio: 'inherit',
	env: {
		...process.env,
		// Suppress code-signing prompts in CI / local builds without a cert.
		CSC_IDENTITY_AUTO_DISCOVERY: 'false',
	},
});

console.log('[1/2] Done.');

// ── 2. CLI: pkg single-file exe ───────────────────────────────────────────────
console.log('\n[2/2] CLI installer (pkg)…');

const cliOut = path.join(DIST, `reflux-${tag}-${platform}-cli.exe`);

execSync(`pnpm exec pkg cli/index.js --targets node20-win-x64 --output "${cliOut}"`, {
	cwd: ROOT,
	stdio: 'inherit',
});

console.log('[2/2] Done.');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(44)}\nArtifacts in installer/dist/:\n`);

for (const f of fs.readdirSync(DIST)) {
	if (!f.endsWith('.exe') && !f.endsWith('.zip')) continue;
	const {size} = fs.statSync(path.join(DIST, f));
	console.log(`  ${f}  (${(size / 1_048_576).toFixed(1)} MB)`);
}

console.log();
