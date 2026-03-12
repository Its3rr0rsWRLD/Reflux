'use strict';

const {app, BrowserWindow, ipcMain} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {Worker} = require('worker_threads');

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCALAPPDATA =
	process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');

const PRODUCT_DIRS = [
	path.join(LOCALAPPDATA, 'fluxer_app'),
	path.join(LOCALAPPDATA, 'fluxer_app_canary'),
	path.join(LOCALAPPDATA, 'Fluxer'),
	path.join(LOCALAPPDATA, 'Fluxer Canary'),
	path.join('C:\\', 'Program Files', 'Fluxer', 'resources'),
	path.join('C:\\', 'Program Files (x86)', 'Fluxer', 'resources'),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function findLatestResourcesDir(productDir) {
	if (!fs.existsSync(productDir)) return null;
	const appDirs = fs
		.readdirSync(productDir, {withFileTypes: true})
		.filter((e) => e.isDirectory() && e.name.startsWith('app-'))
		.map((e) => e.name)
		.sort()
		.reverse();
	for (const dir of appDirs) {
		const resources = path.join(productDir, dir, 'resources');
		if (fs.existsSync(path.join(resources, 'app.asar'))) return resources;
	}
	return null;
}

function findResourcesDir() {
	if (process.env.FLUXER_ASAR) return path.dirname(process.env.FLUXER_ASAR);
	for (const dir of PRODUCT_DIRS) {
		if (fs.existsSync(path.join(dir, 'app.asar'))) return dir;
		const resources = findLatestResourcesDir(dir);
		if (resources) return resources;
	}
	throw new Error("Could not locate Fluxer's resources directory.");
}

function findResourcesDirForUninstall() {
	if (process.env.FLUXER_ASAR) return path.dirname(process.env.FLUXER_ASAR);
	for (const dir of PRODUCT_DIRS) {
		if (fs.existsSync(path.join(dir, 'app.asar.bak'))) return dir;
		if (!fs.existsSync(dir)) continue;
		try {
			const appDirs = fs
				.readdirSync(dir, {withFileTypes: true})
				.filter((e) => e.isDirectory() && e.name.startsWith('app-'))
				.map((e) => e.name)
				.sort()
				.reverse();
			for (const d of appDirs) {
				const resources = path.join(dir, d, 'resources');
				if (fs.existsSync(path.join(resources, 'app.asar.bak'))) return resources;
			}
		} catch {
			/* skip unreadable dirs */
		}
	}
	throw new Error('Could not find app.asar.bak — Reflux may not be installed.');
}

// ── Status check ──────────────────────────────────────────────────────────────

function checkStatus() {
	try {
		const resourcesDir = findResourcesDir();
		const asarPath = path.join(resourcesDir, 'app.asar');
		const installed = fs.existsSync(asarPath + '.bak');
		return {found: true, installed, resourcesDir, error: null};
	} catch (err) {
		return {found: false, installed: false, resourcesDir: null, error: err.message};
	}
}

// ── Worker spawn ──────────────────────────────────────────────────────────────

function spawnWorker(win, op, asarPath) {
	return new Promise((resolve) => {
		const send = (type, message) => {
			if (win && !win.isDestroyed()) win.webContents.send('reflux:progress', {type, message});
		};
		const complete = (success, message) => {
			if (win && !win.isDestroyed()) win.webContents.send('reflux:complete', {success, message});
			resolve();
		};

		const worker = new Worker(path.join(__dirname, 'worker.js'), {workerData: {op, asarPath}});

		worker.on('message', (msg) => {
			if (msg.event === 'progress') send(msg.type, msg.message);
			else if (msg.event === 'complete') complete(msg.success, msg.message);
		});

		worker.on('error', (err) => {
			send('error', err.message);
			complete(false, err.message);
		});
	});
}

// ── Window ────────────────────────────────────────────────────────────────────

let win;
let operating = false;

app.whenReady().then(() => {
	win = new BrowserWindow({
		width: 480,
		height: 620,
		frame: false,
		transparent: true,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		center: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	win.loadFile('index.html');

	win.on('close', (e) => {
		if (operating) e.preventDefault();
	});

	ipcMain.handle('reflux:check-status', () => checkStatus());

	ipcMain.on('reflux:install', async () => {
		operating = true;
		try {
			const resourcesDir = findResourcesDir();
			const asarPath = path.join(resourcesDir, 'app.asar');
			await spawnWorker(win, 'install', asarPath);
		} catch (err) {
			if (win && !win.isDestroyed()) {
				win.webContents.send('reflux:progress', {type: 'error', message: err.message});
				win.webContents.send('reflux:complete', {success: false, message: err.message});
			}
		} finally {
			operating = false;
		}
	});

	ipcMain.on('reflux:uninstall', async () => {
		operating = true;
		try {
			const resourcesDir = findResourcesDirForUninstall();
			const asarPath = path.join(resourcesDir, 'app.asar');
			await spawnWorker(win, 'uninstall', asarPath);
		} catch (err) {
			if (win && !win.isDestroyed()) {
				win.webContents.send('reflux:progress', {type: 'error', message: err.message});
				win.webContents.send('reflux:complete', {success: false, message: err.message});
			}
		} finally {
			operating = false;
		}
	});

	ipcMain.on('reflux:minimize', () => win.minimize());
	ipcMain.on('reflux:close', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
