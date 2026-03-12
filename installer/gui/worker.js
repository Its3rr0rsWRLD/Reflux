'use strict';

const {parentPort, workerData} = require('worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const asar = require('@electron/asar');
const {pathToFileURL} = require('node:url');

// Must be set here — Electron patches fs in the main thread but workers get
// a clean fs, so this is just a safeguard for future-proofing.
process.noAsar = true;

// ── Constants ─────────────────────────────────────────────────────────────────

const REFLUX_ROOT = path.resolve(__dirname, '../..');
const REFLUX_MAIN = path.join(REFLUX_ROOT, 'src', 'main-inject.mjs');
const REFLUX_PRELOAD = path.join(REFLUX_ROOT, 'src', 'preload.js');

const ASAR_MAIN_ENTRY = 'src-electron/dist/main/index.js';
const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(type, message) {
	parentPort.postMessage({event: 'progress', type, message});
}

function complete(success, message) {
	parentPort.postMessage({event: 'complete', success, message});
}

function findMainEntry(extractDir) {
	const pkgPath = path.join(extractDir, 'package.json');
	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
			if (pkg.main) {
				const candidate = pkg.main.replace(/^\.\//, '');
				if (fs.existsSync(path.join(extractDir, ...candidate.split('/')))) return candidate;
			}
		} catch {
			/* malformed package.json */
		}
	}

	const candidates = [ASAR_MAIN_ENTRY, 'dist/main/index.js', 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(extractDir, ...candidate.split('/')))) return candidate;
	}

	throw new Error(`Could not locate main entry.\nTried: ${candidates.join(', ')}`);
}

function prependOnce(filePath, line) {
	const contents = fs.readFileSync(filePath, 'utf8');
	if (contents.startsWith(line)) return false;
	fs.writeFileSync(filePath, line + '\n' + contents, 'utf8');
	return true;
}

// ── Install ───────────────────────────────────────────────────────────────────

async function runInstall(asarPath) {
	const bakPath = asarPath + '.bak';
	const unpackedDir = asarPath + '.unpacked';
	const resourcesDir = path.dirname(asarPath);

	send('step', 'Backing up app.asar…');
	if (!fs.existsSync(bakPath)) {
		fs.copyFileSync(asarPath, bakPath);
	} else {
		send('warn', 'Backup already exists — skipping.');
	}

	const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
	if (fs.existsSync(unpackedPreload)) {
		const oldLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
		const contents = fs.readFileSync(unpackedPreload, 'utf8');
		if (contents.startsWith(oldLine)) {
			fs.writeFileSync(unpackedPreload, contents.slice(oldLine.length), 'utf8');
			send('warn', 'Removed legacy preload injection.');
		}
	}

	const extractDir = path.join(resourcesDir, '.reflux-extract');
	if (fs.existsSync(extractDir)) fs.rmSync(extractDir, {recursive: true});

	send('step', 'Extracting asar…');
	asar.extractAll(asarPath, extractDir);

	send('step', 'Locating main entry…');
	const mainEntry = findMainEntry(extractDir);
	const mainEntryPath = path.join(extractDir, ...mainEntry.split('/'));

	send('step', 'Patching main entry…');
	const mainInjectLine = `await import(${JSON.stringify(pathToFileURL(REFLUX_MAIN).href)});`;
	const didPatch = prependOnce(mainEntryPath, mainInjectLine);

	if (!didPatch) {
		send('warn', 'Main entry already patched — skipping repack.');
		fs.rmSync(extractDir, {recursive: true});
	} else {
		send('step', 'Repacking asar — this may take a moment…');
		await asar.createPackage(extractDir, asarPath);
		send('step', 'Cleaning up…');
		fs.rmSync(extractDir, {recursive: true});
	}

	complete(true, 'Reflux installed successfully. Restart Fluxer to activate.');
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

function runUninstall(asarPath) {
	const bakPath = asarPath + '.bak';
	const unpackedDir = asarPath + '.unpacked';
	const resourcesDir = path.dirname(asarPath);

	send('step', 'Restoring original asar…');
	if (!fs.existsSync(bakPath)) throw new Error('Backup not found. Cannot restore.');
	fs.copyFileSync(bakPath, asarPath);

	send('step', 'Removing backup…');
	fs.unlinkSync(bakPath);

	const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
	if (fs.existsSync(unpackedPreload)) {
		const oldLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
		const contents = fs.readFileSync(unpackedPreload, 'utf8');
		if (contents.startsWith(oldLine)) {
			fs.writeFileSync(unpackedPreload, contents.slice(oldLine.length), 'utf8');
			send('warn', 'Removed legacy preload injection.');
		}
	}

	send('step', 'Cleaning up temp directories…');
	for (const suffix of ['.reflux-extract', '.reflux-tmp', '.reflux-full-extract']) {
		const tmpDir = path.join(resourcesDir, suffix);
		if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, {recursive: true});
	}

	complete(true, 'Reflux uninstalled successfully. Restart Fluxer to apply.');
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const {op, asarPath} = workerData;

(async () => {
	try {
		if (op === 'install') await runInstall(asarPath);
		else if (op === 'uninstall') runUninstall(asarPath);
		else complete(false, `Unknown op: ${op}`);
	} catch (err) {
		send('error', err.message);
		complete(false, err.message);
	}
})();
