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

function download(url, dest) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		function get(u) {
			const mod = u.startsWith('https') ? https : http;
			mod.get(u, (res) => {
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
			}).on('error', reject);
		}
		get(url);
	});
}

async function downloadSrc() {
	const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/reflux-src.zip`;
	const tmpZip = path.join(os.tmpdir(), `reflux-src-${Date.now()}.zip`);

	send('step', 'Downloading Reflux runtime from GitHub…');
	await download(url, tmpZip);

	send('step', 'Extracting runtime files…');
	if (fs.existsSync(REFLUX_APPDATA_SRC)) fs.rmSync(REFLUX_APPDATA_SRC, {recursive: true});
	fs.mkdirSync(REFLUX_APPDATA_SRC, {recursive: true});

	execSync(
		`powershell -NonInteractive -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${REFLUX_APPDATA_SRC}' -Force"`,
		{stdio: 'pipe'},
	);
	fs.unlinkSync(tmpZip);

	return REFLUX_APPDATA_SRC;
}

async function getRefluxSrc() {
	if (!isPackaged) {
		send('step', 'Using local Reflux source (dev mode)…');
		return devSrc;
	}
	return await downloadSrc();
}

// ── Asar pickle helpers ───────────────────────────────────────────────────────
// Minimal Chromium Pickle implementation for rebuilding asar headers in-place.
// Matches the exact byte layout used by @electron/asar / chromium-pickle-js.

function pickleUInt32(value) {
	const buf = Buffer.allocUnsafe(8);
	buf.writeUInt32LE(4, 0); // payload size = sizeof(uint32)
	buf.writeUInt32LE(value, 4);
	return buf;
}

function pickleString(str) {
	const strBuf = Buffer.from(str, 'utf8');
	const aligned = (strBuf.length + 3) & ~3; // round up to 4-byte boundary
	const buf = Buffer.allocUnsafe(4 + 4 + aligned);
	buf.writeUInt32LE(4 + aligned, 0); // payload size
	buf.writeUInt32LE(strBuf.length, 4); // string byte length
	strBuf.copy(buf, 8);
	if (aligned > strBuf.length) buf.fill(0, 8 + strBuf.length); // zero pad
	return buf;
}

// ── Asar header helpers ───────────────────────────────────────────────────────

function getAsarEntry(files, entryPath) {
	const parts = entryPath.split('/');
	let node = files;
	for (let i = 0; i < parts.length; i++) {
		const child = node[parts[i]];
		if (!child) return null;
		if (i === parts.length - 1) return child;
		if (!child.files) return null;
		node = child.files;
	}
	return null;
}

function findMainEntryInAsar(asarPath) {
	const {header} = asar.readHeader(asarPath);

	try {
		const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
		if (pkg.main) {
			const candidate = pkg.main.replace(/^\.\//, '');
			if (getAsarEntry(header.files, candidate)) return candidate;
		}
	} catch {
		/* no package.json or unreadable */
	}

	const candidates = [ASAR_MAIN_ENTRY, 'dist/main/index.js', 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];
	for (const c of candidates) {
		if (getAsarEntry(header.files, c)) return c;
	}

	throw new Error(`Main entry not found in asar. Tried: ${candidates.join(', ')}`);
}

// ── Streaming asar patch ──────────────────────────────────────────────────────
// Patches a single entry without extracting the whole archive.
// Reads the asar once and writes a new one, splicing in the patched file.

function patchAsarEntry(asarPath, entryPath, patchLine) {
	const {header, headerSize} = asar.readHeader(asarPath);
	const dataStart = 8 + headerSize; // 8 bytes for the size pickle

	const entry = getAsarEntry(header.files, entryPath);
	if (!entry || entry.files) throw new Error(`Entry '${entryPath}' not found`);

	const oldOffset = Number(entry.offset);
	const oldSize = entry.size;

	// Read original content
	const rfd = fs.openSync(asarPath, 'r');
	const originalBuf = Buffer.alloc(oldSize);
	fs.readSync(rfd, originalBuf, 0, oldSize, dataStart + oldOffset);
	fs.closeSync(rfd);

	const originalStr = originalBuf.toString('utf8');
	if (originalStr.startsWith(patchLine)) return false; // already patched

	// Build patched content
	const patchedBuf = Buffer.from(patchLine + '\n' + originalStr, 'utf8');
	const sizeDelta = patchedBuf.length - oldSize;

	// Update header: fix entry size/integrity, shift subsequent offsets
	entry.size = patchedBuf.length;
	delete entry.integrity; // content changed — stale hash

	if (sizeDelta !== 0) {
		(function adjustOffsets(files) {
			for (const child of Object.values(files)) {
				if (child.files) adjustOffsets(child.files);
				else if (Number(child.offset) > oldOffset) {
					child.offset = String(Number(child.offset) + sizeDelta);
					// Integrity hashes are content-addressed, not position-based — keep them.
				}
			}
		})(header.files);
	}

	// Rebuild header buffers
	const newHeaderBuf = pickleString(JSON.stringify(header));
	const newSizeBuf = pickleUInt32(newHeaderBuf.length);

	// Stream: new header + original data with patched section spliced in
	const tmpPath = asarPath + '.reflux-patch';
	const wfd = fs.openSync(tmpPath, 'w');
	try {
		fs.writeSync(wfd, newSizeBuf);
		fs.writeSync(wfd, newHeaderBuf);

		const CHUNK = 4 * 1024 * 1024; // 4 MB
		const rfd2 = fs.openSync(asarPath, 'r');
		const asarTotalSize = fs.fstatSync(rfd2).size;
		const entryAbsStart = dataStart + oldOffset;

		// Data before the patched entry
		for (let pos = dataStart; pos < entryAbsStart; ) {
			const len = Math.min(CHUNK, entryAbsStart - pos);
			const chunk = Buffer.allocUnsafe(len);
			fs.readSync(rfd2, chunk, 0, len, pos);
			fs.writeSync(wfd, chunk);
			pos += len;
		}

		// Patched entry
		fs.writeSync(wfd, patchedBuf);

		// Data after the patched entry
		for (let pos = entryAbsStart + oldSize; pos < asarTotalSize; ) {
			const len = Math.min(CHUNK, asarTotalSize - pos);
			const chunk = Buffer.allocUnsafe(len);
			fs.readSync(rfd2, chunk, 0, len, pos);
			fs.writeSync(wfd, chunk);
			pos += len;
		}

		fs.closeSync(rfd2);
	} catch (err) {
		fs.closeSync(wfd);
		try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		throw err;
	}
	fs.closeSync(wfd);

	fs.renameSync(tmpPath, asarPath);
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

	// Clean up any legacy preload injection from an older install approach
	const unpackedPreload = path.join(unpackedDir, ASAR_PRELOAD_ENTRY);
	if (fs.existsSync(unpackedPreload)) {
		const oldLine = `require(${JSON.stringify(REFLUX_PRELOAD.replace(/\\/g, '/'))});\n`;
		const contents = fs.readFileSync(unpackedPreload, 'utf8');
		if (contents.startsWith(oldLine)) {
			fs.writeFileSync(unpackedPreload, contents.slice(oldLine.length), 'utf8');
			send('warn', 'Removed legacy preload injection.');
		}
	}

	const mainInjectLine = `await import(${JSON.stringify(pathToFileURL(REFLUX_MAIN).href)});`;

	send('step', 'Patching app.asar…');
	let patched;
	try {
		const mainEntry = findMainEntryInAsar(asarPath);
		patched = patchAsarEntry(asarPath, mainEntry, mainInjectLine);
	} catch (err) {
		// Streaming patch failed — fall back to full extract+repack
		send('warn', `Streaming patch failed (${err.message}), falling back to full extract…`);
		patched = await runInstallFull(asarPath, resourcesDir, mainInjectLine);
	}

	if (!patched) send('warn', 'Already patched — no changes made.');

	complete(true, 'Reflux installed successfully. Restart Fluxer to activate.');
}

// Full extract+repack fallback for when the streaming patch can't be used.
async function runInstallFull(asarPath, resourcesDir, mainInjectLine) {
	const extractDir = path.join(resourcesDir, '.reflux-extract');
	if (fs.existsSync(extractDir)) fs.rmSync(extractDir, {recursive: true});

	send('step', 'Extracting asar…');
	asar.extractAll(asarPath, extractDir);

	send('step', 'Locating main entry…');
	const candidates = [ASAR_MAIN_ENTRY, 'dist/main/index.js', 'app/dist/main/index.js', 'main/index.js', 'main.js', 'index.js'];
	let mainEntryPath = null;
	for (const c of candidates) {
		const p = path.join(extractDir, ...c.split('/'));
		if (fs.existsSync(p)) {
			mainEntryPath = p;
			break;
		}
	}
	if (!mainEntryPath) throw new Error(`Main entry not found. Tried: ${candidates.join(', ')}`);

	const contents = fs.readFileSync(mainEntryPath, 'utf8');
	if (contents.startsWith(mainInjectLine)) {
		fs.rmSync(extractDir, {recursive: true});
		return false;
	}

	fs.writeFileSync(mainEntryPath, mainInjectLine + '\n' + contents, 'utf8');

	send('step', 'Repacking asar — this may take a moment…');
	await asar.createPackage(extractDir, asarPath);
	fs.rmSync(extractDir, {recursive: true});
	return true;
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

	send('step', 'Cleaning up temp files…');
	for (const suffix of ['.reflux-extract', '.reflux-tmp', '.reflux-full-extract', '.reflux-patch']) {
		const p = path.join(resourcesDir, suffix);
		if (fs.existsSync(p)) fs.rmSync(p, {recursive: true, force: true});
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
