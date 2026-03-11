/**
 * src/core/pluginManager.js
 *
 * Plugin manager for the main process (src/main-inject.mjs).
 *
 * Discovers all plugins under src/plugins/, checks their enabled state from
 * settings, and exposes IPC handlers so the renderer (and settings UI) can
 * list, enable, and disable plugins at runtime.
 *
 * Note: renderer-side plugins register themselves via
 * `window.__reflux.pluginManager.register()` inside renderer.js / renderer
 * plugin bundles.  This manager handles the *main-process* side only:
 * persisting enabled state and telling the renderer which plugins to activate.
 *
 * A valid plugin module must export:
 *   {
 *     name:        string          — unique id, used as the settings key
 *     description: string
 *     rendererSrc: string|null     — path to the renderer-side plugin JS to inject (or null)
 *     start():     void            — called when plugin enabled (main-process side)
 *     stop():      void            — called when plugin disabled / Reflux unloads
 *   }
 *
 * Per-plugin enabled state: `plugins.<name>.enabled` (default: true).
 */

'use strict';

const fs      = require('node:fs');
const path    = require('node:path');
const settings = require('./settings');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, { module: object, started: boolean }>} */
const _registry = new Map();

const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');

const IPC_CH = {
  LIST:    'reflux:plugin-list',
  ENABLE:  'reflux:plugin-enable',
  DISABLE: 'reflux:plugin-disable',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isEnabled(name) {
  return settings.get(`plugins.${name}.enabled`, true);
}

/**
 * @param {string} pluginDir
 * @returns {object|null}
 */
function _loadPlugin(pluginDir) {
  const indexPath = path.join(pluginDir, 'index.js');
  if (!fs.existsSync(indexPath)) return null;

  let plugin;
  try { plugin = require(indexPath); }
  catch (err) { console.error(`[Reflux:PluginManager] require("${indexPath}") failed:`, err); return null; }

  if (typeof plugin.name !== 'string' || !plugin.name) {
    console.error(`[Reflux:PluginManager] Plugin at "${pluginDir}" missing valid "name".`);
    return null;
  }
  if (typeof plugin.start !== 'function' || typeof plugin.stop !== 'function') {
    console.error(`[Reflux:PluginManager] "${plugin.name}" must export start() and stop().`);
    return null;
  }
  return plugin;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and start all enabled plugins.
 */
function loadAll() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.warn('[Reflux:PluginManager] plugins dir not found:', PLUGINS_DIR);
    return;
  }

  for (const entry of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(PLUGINS_DIR, entry.name);
    const plugin = _loadPlugin(pluginDir);
    if (!plugin) continue;

    const { name } = plugin;
    if (_registry.has(name)) {
      console.warn(`[Reflux:PluginManager] Duplicate plugin name "${name}" — skipping.`);
      continue;
    }

    _registry.set(name, { module: plugin, started: false });

    if (_isEnabled(name)) {
      startPlugin(name);
    } else {
      console.log(`[Reflux:PluginManager] "${name}" disabled — skipping.`);
    }
  }
}

function startPlugin(name) {
  const entry = _registry.get(name);
  if (!entry || entry.started) return;
  try {
    entry.module.start();
    entry.started = true;
    console.log(`[Reflux:PluginManager] Started "${name}".`);
  } catch (err) {
    console.error(`[Reflux:PluginManager] "${name}".start() threw:`, err);
  }
}

function stopPlugin(name) {
  const entry = _registry.get(name);
  if (!entry || !entry.started) return;
  try {
    entry.module.stop();
    entry.started = false;
    console.log(`[Reflux:PluginManager] Stopped "${name}".`);
  } catch (err) {
    console.error(`[Reflux:PluginManager] "${name}".stop() threw:`, err);
  }
}

function stopAll() {
  for (const name of _registry.keys()) stopPlugin(name);
}

function enablePlugin(name) {
  settings.set(`plugins.${name}.enabled`, true);
  startPlugin(name);
}

function disablePlugin(name) {
  settings.set(`plugins.${name}.enabled`, false);
  stopPlugin(name);
}

function list() {
  return Array.from(_registry.entries()).map(([name, entry]) => ({
    name,
    displayName:  entry.module.displayName  || name,
    description:  entry.module.description || '',
    rendererSrc:  entry.module.rendererSrc  || null,
    started:      entry.started,
    enabled:      _isEnabled(name),
  }));
}

/**
 * Register ipcMain handlers so the renderer settings UI can manage plugins.
 * @param {Electron.IpcMain} ipcMain
 */
function registerIpc(ipcMain) {
  ipcMain.handle(IPC_CH.LIST,    ()               => list());
  ipcMain.handle(IPC_CH.ENABLE,  (_e, name)       => enablePlugin(name));
  ipcMain.handle(IPC_CH.DISABLE, (_e, name)       => disablePlugin(name));
}

module.exports = { loadAll, stopAll, startPlugin, stopPlugin, enablePlugin, disablePlugin, list, registerIpc };
