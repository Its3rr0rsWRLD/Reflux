/**
 * src/preload.js
 *
 * Reflux preload bootstrap.  Injected via a require() prepend into
 * Fluxer's already-unpacked preload script:
 *   app.asar.unpacked/src-electron/dist/preload/index.js
 *
 * Fluxer's preload runs with:
 *   contextIsolation: true
 *   sandbox: true
 *   nodeIntegration: false
 *
 * In this environment we do NOT have access to Node.js core modules.
 * What we CAN do:
 *   • Use Electron's `ipcRenderer` and `contextBridge`.
 *   • Manipulate the isolated-world DOM before Fluxer's preload runs.
 *   • Read/write window properties in the isolated world.
 *
 * The heavy lifting (webpack patching, plugin loading) is done in
 * src/renderer.js which is injected into the MAIN world by src/main-inject.mjs
 * via webContents.executeJavaScript().
 *
 * This preload's job is lighter:
 *   1. Register IPC handlers that relay Reflux settings/plugin commands from
 *      the renderer <-> main process.
 *   2. Expose a `window.refluxBridge` in the main world via contextBridge so
 *      renderer.js plugins can call Electron APIs they wouldn't otherwise have.
 */

'use strict';

const {contextBridge, ipcRenderer} = require('electron');

// ---------------------------------------------------------------------------
// IPC channel constants (must match src/main-inject.mjs)
// ---------------------------------------------------------------------------

const CH = {
  GET_SETTING:    'reflux:get-setting',
  SET_SETTING:    'reflux:set-setting',
  GET_ALL:        'reflux:get-all-settings',
  PLUGIN_LIST:    'reflux:plugin-list',
  PLUGIN_ENABLE:  'reflux:plugin-enable',
  PLUGIN_DISABLE: 'reflux:plugin-disable',
};

// ---------------------------------------------------------------------------
// Expose bridge to the main world (renderer.js / plugins)
// ---------------------------------------------------------------------------

try {
  contextBridge.exposeInMainWorld('refluxBridge', {
    /** Get a persisted setting (returns a Promise). */
    getSetting: (key, defaultValue) => ipcRenderer.invoke(CH.GET_SETTING, key, defaultValue),

    /** Persist a setting. */
    setSetting: (key, value) => ipcRenderer.invoke(CH.SET_SETTING, key, value),

    /** Get all settings as a plain object. */
    getAllSettings: () => ipcRenderer.invoke(CH.GET_ALL),

    /** List all discovered plugins and their enabled state. */
    listPlugins: () => ipcRenderer.invoke(CH.PLUGIN_LIST),

    /** Enable a named plugin. */
    enablePlugin: (name) => ipcRenderer.invoke(CH.PLUGIN_ENABLE, name),

    /** Disable a named plugin. */
    disablePlugin: (name) => ipcRenderer.invoke(CH.PLUGIN_DISABLE, name),

    /** Reflux version string. */
    version: '1.0.0',
  });

  console.log('[Reflux:Preload] refluxBridge exposed.');
} catch (err) {
  console.error('[Reflux:Preload] Failed to expose refluxBridge:', err);
}
