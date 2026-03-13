'use strict';

const {parentPort, workerData} = require('worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const {execSync} = require('node:child_process');
const asar = require('@electron/asar');
const {pathToFileURL} = require('node:url');

process.noAsar = true;

// ── Constants ─────────────────────────────────────────────────────────────────

const ASAR_MAIN_ENTRY = 'src-electron/dist/main/index.js';
const ASAR_PRELOAD_ENTRY = 'src-electron/dist/preload/index.js';
const GITHUB_REPO = 'its3rr0rswrld/Reflux';

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const REFLUX_APPDATA_SRC = path.join(APPDATA, 'Reflux', 'src');

// ── Inputs ────────────────────────────────────────────────────────────────────

const {op, asarPath, isPackaged, devSrc} = workerData;

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(type, message) {
	parentPort.postMessage({event: 'progress', type, message});
}

function complete(success, message) {
	parentPort.postMessage({event: 'complete', success, message});
}

// Download a URL to a local file, following redirects.
function download(url, dest) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		function get(u) {
			const mod = u.startsWith('https') ? https : http;
			mod
				.get(u, (res) => {
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
						res.resume();
						get(res.headers.location);
						return;
					}
					if (res.statusCode !== 200) {
						file.close();
						reject(new Error(`Download failed: HTTP ${res.statusCode}`));
						return;
					}
					res.pipe(file);
					file.on('finish', () => file.close(resolve));
					file.on('error', reject);
				})
				.on('error', reject);
		}
		get(url);
	});
}

// Download the latest src zip from GitHub releases and extract to AppData.
async function downloadSrc() {
	const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/reflux-src.zip`;
	const tmpZip = path.join(os.tmpdir(), `reflux-src-${Date.now()}.zip`);

	send('step', 'Downloading Reflux runtime from GitHub…');
	await download(url, tmpZip);

	send('step', 'Extracting runtime files…');
	if (fs.existsSync(REFLUX_APPDATA_SRC)) fs.rmSync(REFLUX_APPDATA_SRC, {recursive: true});
	fs.mkdirSync(REFLUX_APPDATA_SRC, {recursive: true});

	execSync(`powershell -NonInteractive -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${REFLUX_APPDATA_SRC}' -Force"`, {
		stdio: 'pipe',
	});
	fs.unlinkSync(tmpZip);

	return REFLUX_APPDATA_SRC;
}

// Resolve the active src path: download from GitHub when packaged, use local in dev.
async function getRefluxSrc() {
	if (!isPackaged) {
		send('step', 'Using local Reflux source (dev mode)…');
		return devSrc;
	}
	return await downloadSrc();
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

// ── Install / Repair ───────────────────────────────────────────────────────────

async function runInstall(asarPath) {
	const bakPath = asarPath + '.bak';
	const unpackedDir = asarPath + '.unpacked';
	const resourcesDir = path.dirname(asarPath);

	const activeSrc = await getRefluxSrc();
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

// ── Update ────────────────────────────────────────────────────────────────────

async function runUpdate() {
	if (!isPackaged) {
		complete(true, 'Running in dev mode — source is already up to date.');
		return;
	}
	await downloadSrc();
	complete(true, 'Reflux runtime updated. Restart Fluxer to apply the latest version.');
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

function runUninstall(asarPath) {
	const bakPath = asarPath + '.bak';
	const unpackedDir = asarPath + '.unpacked';
	const resourcesDir = path.dirname(asarPath);
	const REFLUX_PRELOAD = path.join(REFLUX_APPDATA_SRC, 'preload.js');

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
		else if (op === 'update') await runUpdate();
		else if (op === 'uninstall') runUninstall(asarPath);
		else complete(false, `Unknown op: ${op}`);
	} catch (err) {
		send('error', err.message);
		complete(false, err.message);
	}
})();
