<p align="center">
  <img src=".github/assets/wide_logo.png" alt="Reflux" />
</p>

# Reflux

Reflux is a Vencord-style runtime injector for the Fluxer desktop app.

## Main features

- asar injection into Fluxer's main process (ESM-compatible, no repacking for preload)
- CSP stripping so renderer scripts load without restriction
- Plugin lifecycle (`start`, `stop`, enable/disable with persistent state)
- `contextBridge` IPC bridge exposing settings and plugin management to the renderer
- Gateway WebSocket interception (`wss://gateway.fluxer.app`) for event hooks
- Injected **Reflux** section inside Fluxer's native settings panel
- Import custom `.js` plugins at runtime with `==RefluxPlugin==` metadata blocks
- Settings persisted to `%APPDATA%\Reflux\settings.json`

## Bundled plugins

| Plugin | Description |
|---|---|
| **Settings UI** | Adds a "Reflux" sidebar section to Fluxer settings with plugin toggles and import |
| **Message Logger** | Intercepts `MESSAGE_DELETE` gateway events and re-displays deleted messages inline |

## Install

```bash
cd installer
npm install
node index.js
```

Reflux auto-detects the latest Fluxer version under `%LOCALAPPDATA%\fluxer_app\`.

Override the target manually:

```bash
FLUXER_ASAR=C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8\resources\app.asar node installer/index.js
```

## Uninstall

```bash
node installer/unpatch.js
```

Restores `app.asar` from `app.asar.bak` and removes all injected lines from the unpacked preload.

## Writing a plugin

Create `src/plugins/<name>/index.js` exporting:

```js
module.exports = {
  name:        'myPlugin',       // unique ID, used as settings key
  displayName: 'My Plugin',      // shown in the UI
  description: 'Does stuff.',
  rendererSrc: require('path').join(__dirname, 'renderer-side.js'), // optional
  start() { /* main-process setup */ },
  stop()  { /* cleanup */ },
};
```

The optional `rendererSrc` file is injected into Fluxer's web context via `executeJavaScript` after the core bootstrap runs. Use `window.__reflux` and `window.refluxBridge` inside it.

### Importable plugins (`.js` files)

Drop a `.js` file into the Plugins → Import panel in Fluxer settings. Optionally include a metadata block at the top:

```js
// ==RefluxPlugin==
// @name        My Plugin
// @author      3rr0r
// @description Does cool stuff
// @version     1.0.0
// @preview     https://i.imgur.com/example.png
// ==/RefluxPlugin==
```

## Repo layout

```
installer/          Injector script (standalone, own package.json + deps)
  index.js          Inject Reflux into Fluxer
  unpatch.js        Remove Reflux from Fluxer
src/
  main-inject.mjs   ESM module injected into Fluxer's main process
  preload.js        Sandboxed preload — exposes refluxBridge via contextBridge
  renderer.js       Core bootstrap injected into the web renderer
  core/
    settings.js     Read/write %APPDATA%\Reflux\settings.json, IPC handlers
    pluginManager.js  Discover, start/stop plugins, IPC handlers
    patcher.js      Thin wrapper around window.__reflux.patcher
  plugins/
    settingsUI/     Settings panel injected into Fluxer's native settings UI
    messageLogger/  Deleted message logger via gateway WebSocket interception
```

## What injection modifies

- `resources/app.asar` — `await import(...)` line prepended to `src-electron/dist/main/index.js`
  - backup: `app.asar.bak`
- `resources/app.asar.unpacked/src-electron/dist/preload/index.js` — no longer patched directly; Reflux preload is registered via `session.setPreloads()` instead

Settings are stored at `%APPDATA%\Reflux\settings.json`.

## Default install path

- Windows: `%LOCALAPPDATA%\fluxer_app\app-<version>\resources\`
- Canary: `%LOCALAPPDATA%\Fluxer Canary\app-<version>\resources\`
