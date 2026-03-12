'use strict';

const {parentPort, workerData} = require('worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const asar = require('@electron/asar');
const {pathToFileURL} = require('node:url');

process.noAsar = true;

// ── Constants ─────────────────────────────────────────────────────────────────

const ASAR_MAIN_ENTRY = 'src-electron/dist/main/index.js';
const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';

// When packaged, the GUI installer bundles src/ as extra resources.
// We install those to %APPDATA%\Reflux\src\ so Fluxer always imports from a
// stable, predictable path — regardless of where the installer exe lives.
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const REFLUX_APPDATA_SRC = path.join(APPDATA, 'Reflux', 'src');

// ── Inputs ────────────────────────────────────────────────────────────────────

const {op, asarPath, refluxSrc, isPackaged} = workerData;

// Resolve the active src path for this run.
// Packaged: copy bundled extra-resources to %APPDATA%\Reflux\src\ (stable, survives exe moves).
// Dev: use the repo's src/ directly.
function resolveRefluxSrc() {
	if (!isPackaged) return refluxSrc;
	fs.mkdirSync(REFLUX_APPDATA_SRC, {recursive: true});
	fs.cpSync(refluxSrc, REFLUX_APPDATA_SRC, {recursive: true, force: true});
	return REFLUX_APPDATA_SRC;
}

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

	send('step', isPackaged ? 'Installing Reflux runtime files…' : 'Locating Reflux source…');
	const activeSrc = resolveRefluxSrc();
	const REFLUX_MAIN = path.join(activeSrc, 'main-inject.mjs');
	const REFLUX_PRELOAD = path.join(activeSrc, 'preload.js');

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
	const activeSrc = isPackaged ? REFLUX_APPDATA_SRC : refluxSrc;
	const REFLUX_PRELOAD = path.join(activeSrc, 'preload.js');

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
