/**
 * src/core/patcher.js
 *
 * Renderer-side module patcher for Reflux plugins.
 *
 * Fluxer's web client (https://web.fluxer.app) is a webpack/rspack bundle.
 * The "modules" that plugins intercept are webpack module IDs and their
 * exports — not Node.js require() paths.
 *
 * This file is a thin wrapper around the patcher already instantiated by
 * src/renderer.js.  It is intended to be used by plugin code that runs in
 * the renderer main world and wants to access the shared patcher instance
 * without coupling directly to renderer.js internals.
 *
 * Usage (inside a renderer plugin):
 *
 *   const { patch, patchByExportKey, findModules } = window.__reflux.patcher;
 *
 *   // Patch any module that exports a `sendMessage` function.
 *   const unpatch = patchByExportKey('sendMessage', (exports) => {
 *     const original = exports.sendMessage;
 *     exports.sendMessage = (channelId, content, ...rest) => {
 *       console.log('[Reflux] sendMessage:', channelId, content);
 *       return original(channelId, content, ...rest);
 *     };
 *   });
 *
 *   // Call unpatch() in plugin.stop() to remove the patch.
 *   unpatch();
 *
 * ─── Patching strategies ─────────────────────────────────────────────────
 *
 * 1. patchByExportKey(key, cb)        — module has a specific export name
 * 2. patchByDisplayName(name, cb)     — React component with displayName
 * 3. patch(filter, cb)                — arbitrary filter on exports object
 * 4. findModules(filter)              — search already-loaded module cache
 *
 * All four are available on window.__reflux.patcher after renderer.js runs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * NOTE: This file is documentation + a convenience re-export.  The actual
 * implementation lives in src/renderer.js (IIFE bootstrapped into the web
 * context).  If you need the patcher in a context where window.__reflux is
 * not yet available, wait for the 'reflux-ready' custom event:
 *
 *   window.addEventListener('reflux-ready', () => {
 *     const { patcher } = window.__reflux;
 *     // …
 *   });
 */

'use strict';

/**
 * Returns the shared patcher from the global __reflux object, or throws if
 * Reflux hasn't bootstrapped yet.
 * @returns {import('../renderer').Patcher}
 */
function getPatcher() {
  if (!window.__reflux) {
    throw new Error('[Reflux] Patcher not available — window.__reflux is not set. ' +
      'Ensure renderer.js has been injected before calling getPatcher().');
  }
  return window.__reflux.patcher;
}

// Convenience passthrough helpers.

/** @see {import('../renderer').Patcher.patch} */
function patch(filter, callback)              { return getPatcher().patch(filter, callback); }

/** @see {import('../renderer').Patcher.patchByExportKey} */
function patchByExportKey(key, callback)      { return getPatcher().patchByExportKey(key, callback); }

/** @see {import('../renderer').Patcher.patchByDisplayName} */
function patchByDisplayName(name, callback)   { return getPatcher().patchByDisplayName(name, callback); }

/** @see {import('../renderer').Patcher.findModules} */
function findModules(filter)                  { return getPatcher().findModules(filter); }

module.exports = { patch, patchByExportKey, patchByDisplayName, findModules, getPatcher };
