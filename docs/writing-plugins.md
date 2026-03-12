# Writing Plugins for Reflux

Reflux plugins have two sides: a **main-process side** (Node.js) and an optional **renderer side** (browser/web context). You only need what your plugin actually uses.

---

## Quick start

There are two ways to write a Reflux plugin depending on what you want to do:

- **Contributing to Reflux** — clone the repo and add your plugin under `src/plugins/<your-plugin-name>/`. It will be discovered automatically on the next Fluxer launch.
- **Personal use / sharing** — write a standalone `.js` file and import it via **Reflux Settings → Plugins → Import Plugin**. You don't need to clone the repo at all. See [Importable plugins](#importable-plugins-js-files) below.

The rest of this section covers the built-in plugin format. For the importable format, skip to [Importable plugins](#importable-plugins-js-files).

---

Create a folder under `src/plugins/<your-plugin-name>/` and add `index.js`:

```js
'use strict';

module.exports = {
  name:        'myPlugin',       // unique ID — used as the settings key
  displayName: 'My Plugin',      // shown in the Reflux settings UI
  description: 'One-line description shown in the plugin list.',
  rendererSrc: null,             // path to renderer script, or null
  start() {},
  stop()  {},
};
```

That's it. Reflux discovers and loads it automatically on the next Fluxer launch.

---

## Plugin fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Unique ID. Used as the settings key — don't change it after release. |
| `displayName` | `string` | | Human-readable name shown in the UI. Defaults to `name`. |
| `description` | `string` | | Short description shown in the plugin card. |
| `rendererSrc` | `string \| null` | | Absolute path to a renderer-side script injected into the Fluxer web context. |
| `start()` | `function` | ✅ | Called when the plugin is enabled. |
| `stop()` | `function` | ✅ | Called when the plugin is disabled or Reflux unloads. |

---

## Main-process side

`start()` and `stop()` run in **Electron's main process** (Node.js). You have access to the full Node.js API and Electron modules.

```js
// src/plugins/myPlugin/index.js
'use strict';

const { app } = require('electron');

let _interval = null;

module.exports = {
  name:        'myPlugin',
  displayName: 'My Plugin',
  description: 'Logs a message every 10 seconds.',
  rendererSrc: null,

  start() {
    _interval = setInterval(() => {
      console.log('[myPlugin] Still running in main process');
    }, 10_000);
  },

  stop() {
    clearInterval(_interval);
    _interval = null;
  },
};
```

---

## Renderer side

If your plugin needs to interact with the Fluxer web UI, set `rendererSrc` to the path of a JavaScript file. Reflux injects it into the web context via `executeJavaScript` after the page loads.

```js
// src/plugins/myPlugin/index.js
'use strict';
const path = require('node:path');

module.exports = {
  name:        'myPlugin',
  displayName: 'My Plugin',
  description: 'Adds a banner to the Fluxer UI.',
  rendererSrc: path.join(__dirname, 'renderer-side.js'),
  start() {},
  stop()  {},
};
```

```js
// src/plugins/myPlugin/renderer-side.js
(function myPlugin() {
  if (window.__myPlugin_loaded) return;
  window.__myPlugin_loaded = true;

  const banner = document.createElement('div');
  banner.id = 'my-plugin-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:4px;background:#5865f2;color:#fff;text-align:center;z-index:9999;font-size:13px;';
  banner.textContent = 'My Plugin is active!';
  document.body.appendChild(banner);

  // Register with Reflux so stop() can clean up
  window.__reflux?.pluginManager?.register?.({
    name: 'myPlugin',
    start() {},
    stop() {
      document.getElementById('my-plugin-banner')?.remove();
      window.__myPlugin_loaded = false;
    },
  });
})();
```

> **Guard against double-injection** — always check a flag like `window.__myPlugin_loaded` at the top of your renderer script. Fluxer may reload pages without a full restart.

---

## Accessing settings from the renderer

The `refluxBridge` object is exposed by Reflux's preload script and is available in the renderer as `window.refluxBridge`.

```js
// Read a value (async)
const volume = await window.refluxBridge.getSetting('myPlugin.volume', 100);

// Write a value (async)
await window.refluxBridge.setSetting('myPlugin.volume', 80);
```

Settings are stored in `%APPDATA%\Reflux\settings.json` under your plugin's key namespace.

---

## Intercepting the gateway WebSocket

Fluxer decompresses its zstd-stream WebSocket frames and calls `JSON.parse()` on the result. Hook `JSON.parse` to intercept decoded gateway payloads without dealing with compression.

```js
(function myPlugin() {
  const _orig = JSON.parse;

  JSON.parse = function(text, ...rest) {
    const result = _orig.call(this, text, ...rest);
    try {
      if (result?.op === 0 && result?.t) onGatewayEvent(result);
    } catch {}
    return result;
  };

  function onGatewayEvent({ t, d }) {
    if (t === 'MESSAGE_CREATE') {
      console.log('New message:', d.content);
    }
  }

  window.__reflux?.pluginManager?.register?.({
    name: 'myPlugin',
    start() {},
    stop() {
      JSON.parse = _orig; // restore on disable
    },
  });
})();
```

---

## Importable plugins (`.js` files)

Users can import external `.js` plugins directly from the Reflux settings UI without touching the file system. Add a metadata block at the top of your file:

```js
// ==RefluxPlugin==
// @name        My Plugin
// @author      3rr0r
// @description Does something cool
// @version     1.0.0
// @icon        🔌
// ==/RefluxPlugin==

(function myPlugin() {
  // Your plugin code here
  console.log('My importable plugin loaded!');
})();
```

All fields in the block are optional. If omitted, the filename is used as the plugin name.

### `@icon` formats

The `@icon` field accepts three formats:

**Emoji** — simplest option:
```js
// @icon        🔌
```

**Image URL** — any publicly accessible image:
```js
// @icon        https://i.imgur.com/abc123.png
```

**Inline `data:` URI** — embed the image directly in the file so it works offline:
```js
// @icon        data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB...
```

**Raw SVG** — paste an SVG string directly:
```js
// @icon        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ef4444" d="M12 2L2 7l10 5 10-5-10-5z"/></svg>
```

Reflux renders whatever string is in `@icon` as the `src` of an `<img>` tag, falling back to displaying it as text if the image fails to load — so emojis and SVGs both work.

The user imports it via **Reflux Settings → Plugins → Import Plugin**.

---

## Full example — Delete Logger

Logs a message to the console whenever someone deletes a message. This is an importable plugin — save it as `deleteLogger.js` and import it via **Reflux Settings → Plugins → Import Plugin**.

```js
// deleteLogger.js
// ==RefluxPlugin==
// @name        Delete Logger
// @author      3rr0r
// @description Logs deleted messages to the console.
// @version     1.0.0
// @icon        🗑️
// ==/RefluxPlugin==

(function deleteLogger() {
  if (window.__reflux_deleteLogger_loaded) return;
  window.__reflux_deleteLogger_loaded = true;

  const _origParse = JSON.parse;

  JSON.parse = function(text, ...rest) {
    const result = _origParse.call(this, text, ...rest);
    try {
      if (result?.op === 0 && result?.t === 'MESSAGE_DELETE') {
        console.log('[DeleteLogger] Message deleted:', result.d.content);
      }
    } catch {}
    return result;
  };

  window.__reflux?.pluginManager?.register?.({
    name: 'deleteLogger',
    start() {},
    stop() {
      JSON.parse = _origParse;
      window.__reflux_deleteLogger_loaded = false;
    },
  });
})();
```

---

## Tips

- **Settings namespace** — prefix all your settings keys with your plugin name to avoid collisions: `myPlugin.someKey`.
- **CSS class names** — Fluxer's class names include a build hash (e.g. `Message.module__message___XzQ1Zj`). Use `[class*="message__"]` attribute selectors to match them resilently.
- **Clean up everything** — your `stop()` must undo everything `start()` did: remove DOM nodes, disconnect observers, restore patched globals.
- **No eval** — use `new Function(src)()` if you need to execute dynamic code, and be aware of the security implications.
- **Double-injection guard** — always check `window.__yourPlugin_loaded` at the top of renderer scripts.
