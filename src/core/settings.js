/**
 * src/core/settings.js
 *
 * Persistent settings for Reflux.
 * Reads/writes %APPDATA%\Reflux\settings.json.
 *
 * Used directly from the main process (src/main-inject.mjs) and exposed to
 * the renderer via IPC (the ipcMain handlers are registered here).
 *
 * API:
 *   get(key, defaultValue)  — dot-notation read
 *   set(key, value)         — dot-notation write + persist
 *   remove(key)             — delete a key + persist
 *   getAll()                — shallow copy of entire settings object
 *   registerIpc(ipcMain)    — call once from main process to wire IPC handlers
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Storage path
// ---------------------------------------------------------------------------

const APPDATA = process.env.APPDATA
  || path.join(process.env.USERPROFILE || require('node:os').homedir(), 'AppData', 'Roaming');

const SETTINGS_DIR  = path.join(APPDATA, 'Reflux');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** @type {Record<string, any>|null} */
let _cache = null;

function _load() {
  if (_cache !== null) return;
  try {
    _cache = fs.existsSync(SETTINGS_FILE)
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      : {};
  } catch (err) {
    console.error('[Reflux:Settings] Load failed, starting fresh:', err.message);
    _cache = {};
  }
}

function _save() {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[Reflux:Settings] Save failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Dot-notation path helpers
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} obj
 * @param {string}              dotPath
 * @param {boolean}             createMissing
 * @returns {{ parent: object|null, key: string, value: any }}
 */
function _traverse(obj, dotPath, createMissing = false) {
  const parts = dotPath.split('.');
  let cur = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] === undefined || cur[part] === null || typeof cur[part] !== 'object') {
      if (!createMissing) return { parent: null, key: parts[parts.length - 1], value: undefined };
      cur[part] = {};
    }
    cur = cur[part];
  }

  const lastKey = parts[parts.length - 1];
  return { parent: cur, key: lastKey, value: cur[lastKey] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {string} key
 * @param {T}      [defaultValue]
 * @returns {T}
 */
function get(key, defaultValue = undefined) {
  _load();
  const { value } = _traverse(_cache, key);
  return value !== undefined ? value : defaultValue;
}

/**
 * @param {string} key
 * @param {any}    value
 */
function set(key, value) {
  _load();
  const { parent, key: lastKey } = _traverse(_cache, key, true);
  if (!parent) { console.error('[Reflux:Settings] Invalid key:', key); return; }
  parent[lastKey] = value;
  _save();
}

/**
 * @param {string} key
 */
function remove(key) {
  _load();
  const { parent, key: lastKey } = _traverse(_cache, key);
  if (parent) { delete parent[lastKey]; _save(); }
}

/**
 * @returns {Record<string, any>}
 */
function getAll() {
  _load();
  return JSON.parse(JSON.stringify(_cache)); // deep clone to prevent mutation
}

// ---------------------------------------------------------------------------
// IPC registration (call once from main process)
// ---------------------------------------------------------------------------

const CH = {
  GET_SETTING:    'reflux:get-setting',
  SET_SETTING:    'reflux:set-setting',
  GET_ALL:        'reflux:get-all-settings',
};

/**
 * Register ipcMain handlers so the renderer can read/write settings via
 * the refluxBridge exposed in src/preload.js.
 *
 * @param {Electron.IpcMain} ipcMain
 */
function registerIpc(ipcMain) {
  ipcMain.handle(CH.GET_SETTING, (_event, key, defaultValue) => get(key, defaultValue));
  ipcMain.handle(CH.SET_SETTING, (_event, key, value)        => { set(key, value); });
  ipcMain.handle(CH.GET_ALL,     ()                          => getAll());
}

module.exports = { get, set, remove, getAll, registerIpc, SETTINGS_FILE };
