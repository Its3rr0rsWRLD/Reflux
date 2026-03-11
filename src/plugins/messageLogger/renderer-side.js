/**
 * src/plugins/messageLogger/renderer-side.js
 *
 * Intercepts Fluxer's gateway WebSocket to catch MESSAGE_DELETE events and
 * re-displays deleted messages inline with a "Deleted" badge.
 *
 * How it works
 * ─────────────
 * 1.  WebSocket hook  — wraps the global WebSocket constructor so we always
 *     have a reference to the newest gateway.fluxer.app socket (the URL may
 *     change between versions, so we match on the hostname).
 *
 * 2.  JSON.parse hook — Fluxer decompresses the zstd-stream binary frames
 *     itself and then calls JSON.parse() on the result.  We intercept at
 *     that point so we never need to reimplement the zstd codec.
 *
 * 3.  DOM marking     — when a MESSAGE_DELETE arrives we find the message
 *     element, style it grey + add a "Deleted" badge, then watch for React
 *     removing it and re-insert a clone so it stays visible.
 */

(function refluxMessageLogger() {
  'use strict';

  if (window.__reflux_messageLogger_loaded) return;
  window.__reflux_messageLogger_loaded = true;

  const TAG = '[Reflux:MessageLogger]';

  /** Map<messageId, gatewayDeleteData> */
  const cache = new Map();

  // ── 1. WebSocket hook ──────────────────────────────────────────────────────
  // Track the newest gateway socket so we always reference the right one.
  // The URL may include a different version query string over time; we only
  // match on the hostname portion.

  const _OrigWS = window.WebSocket;
  let _newestGateway = null;

  function PatchedWS(url, protocols) {
    const ws = (protocols != null)
      ? new _OrigWS(url, protocols)
      : new _OrigWS(url);

    if (typeof url === 'string' && url.includes('gateway.fluxer.app')) {
      _newestGateway = ws;
      console.log(TAG, 'Gateway socket opened →', url);
      ws.addEventListener('close', () => {
        if (_newestGateway === ws) _newestGateway = null;
        console.log(TAG, 'Gateway socket closed');
      });
    }

    return ws;
  }

  // Preserve static constants and prototype so existing code keeps working
  PatchedWS.prototype = _OrigWS.prototype;
  Object.setPrototypeOf(PatchedWS, _OrigWS);
  Object.defineProperties(PatchedWS, {
    CONNECTING: { value: 0 }, OPEN:    { value: 1 },
    CLOSING:    { value: 2 }, CLOSED:  { value: 3 },
  });

  window.WebSocket = PatchedWS;

  // ── 2. JSON.parse hook ─────────────────────────────────────────────────────
  // Fluxer receives compressed binary frames, decompresses them in JS, then
  // calls JSON.parse() on the resulting string.  By intercepting JSON.parse
  // we see every decoded gateway payload without touching zstd at all.

  const _origParse = JSON.parse;

  JSON.parse = function interceptedJSONParse(text, ...rest) {
    const result = _origParse.call(this, text, ...rest);
    try {
      // Gateway DISPATCH: { op: 0, t: "<EVENT>", s: <seq>, d: { ... } }
      if (
        result !== null &&
        typeof result === 'object' &&
        result.op === 0 &&
        typeof result.t === 'string' &&
        result.d !== undefined
      ) {
        onGatewayDispatch(result);
      }
    } catch { /* never let our code break Fluxer */ }
    return result;
  };

  // Keep native toString so devtools / Object.is checks don't trip up
  Object.defineProperty(JSON.parse, 'toString', {
    value: () => _origParse.toString(),
    configurable: true,
  });

  // ── Gateway dispatch handler ───────────────────────────────────────────────

  function onGatewayDispatch(payload) {
    if (payload.t !== 'MESSAGE_DELETE') return;

    const d = payload.d;
    if (!d || !d.id || !d.content) return;   // server omitted content → nothing to show

    cache.set(d.id, { ...d, _deletedAt: Date.now() });
    console.log(TAG, `Deleted: "${d.content.slice(0, 100)}"`, d);

    // Mark the DOM element now (before React's next reconcile removes it)
    const el = findMsgEl(d.id);
    if (el && !el.dataset.refluxDeleted) {
      watchAndGhost(el, d);
    }
  }

  // ── 3. DOM helpers ─────────────────────────────────────────────────────────

  /** Try common attribute patterns Fluxer might use for message elements. */
  function findMsgEl(id) {
    return (
      document.querySelector(`[data-id="${id}"]`)         ||
      document.querySelector(`[id="${id}"]`)              ||
      document.querySelector(`[data-message-id="${id}"]`) ||
      document.querySelector(`[data-item-id="${id}"]`)
    );
  }

  /** Apply the "deleted" visual to an element. */
  function styleDeleted(el) {
    el.style.setProperty('background',    'rgba(237,66,69,0.06)',    'important');
    el.style.setProperty('border-left',   '2px solid rgba(237,66,69,0.4)', 'important');
    el.style.setProperty('padding-left',  '8px',                    'important');
    el.style.setProperty('opacity',       '0.65',                   'important');
    el.style.setProperty('box-sizing',    'border-box',             'important');
    el.dataset.refluxDeleted = 'true';

    if (!el.querySelector('.rx-del-badge')) {
      const badge = document.createElement('span');
      badge.className = 'rx-del-badge';
      badge.style.cssText = [
        'display:inline-flex', 'align-items:center',
        'font-size:10px', 'font-weight:700', 'padding:1px 5px',
        'border-radius:3px', 'margin-left:6px', 'vertical-align:middle',
        'background:rgba(237,66,69,0.18)', 'color:#ed4245',
        'text-transform:uppercase', 'letter-spacing:.4px',
        'pointer-events:none', 'user-select:none',
      ].join(';');
      badge.textContent = 'Deleted';

      // Attach after the message content block if we can find it
      const target = (
        el.querySelector('[class*="messageContent"]') ||
        el.querySelector('[class*="content"]')        ||
        el.querySelector('p')
      );
      if (target) target.insertAdjacentElement('afterend', badge);
      else        el.insertAdjacentElement('beforeend', badge);
    }
  }

  /**
   * Style the element, then watch its parent for removal.
   * If React removes it, clone and re-insert so it stays visible.
   */
  function watchAndGhost(el, data) {
    styleDeleted(el);

    const parent      = el.parentElement;
    if (!parent) return;

    // Record the next sibling so we know where to re-insert later
    const nextSibling = el.nextElementSibling;

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const removed of m.removedNodes) {
          if (removed === el || (removed.nodeType === 1 && removed.contains(el))) {
            mo.disconnect();
            insertGhost(parent, el, nextSibling, data);
            return;
          }
        }
      }
    });

    mo.observe(parent, { childList: true });

    // Stop watching after 4 s — if React hasn't removed it by then, the
    // styled element is already persisted in the DOM.
    setTimeout(() => mo.disconnect(), 4000);
  }

  /** Re-insert a styled clone of the removed message. */
  function insertGhost(parent, original, nextSibling, data) {
    const ghost = original.cloneNode(true);
    ghost.dataset.refluxGhost   = 'true';
    ghost.dataset.refluxDeleted = 'true';

    // Re-apply styles (cloneNode copies attributes but we want to be sure)
    styleDeleted(ghost);

    // Fade in
    ghost.style.setProperty('transition', 'opacity 350ms ease', 'important');
    ghost.style.setProperty('opacity', '0', 'important');

    if (nextSibling && parent.contains(nextSibling)) {
      parent.insertBefore(ghost, nextSibling);
    } else {
      parent.appendChild(ghost);
    }

    // Trigger reflow then fade in
    ghost.getBoundingClientRect();
    ghost.style.setProperty('opacity', '0.65', 'important');

    console.log(TAG, 'Ghost persisted for message', data.id);
  }

  // ── DOM watcher ─────────────────────────────────────────────────────────────
  // Handles the case where the cache entry existed before the element rendered
  // (unlikely but possible if a batch delete arrives before the chat panel mounts).

  let _watchTimer = null;
  const domWatcher = new MutationObserver(() => {
    if (_watchTimer) return;
    _watchTimer = setTimeout(() => {
      _watchTimer = null;
      for (const [id, data] of cache) {
        const el = findMsgEl(id);
        if (el && !el.dataset.refluxDeleted && !el.dataset.refluxGhost) {
          watchAndGhost(el, data);
        }
      }
    }, 250);
  });

  domWatcher.observe(document.body, { childList: true, subtree: true });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  window.__reflux?.pluginManager?.register?.({
    name: 'messageLogger',
    start() {},
    stop() {
      domWatcher.disconnect();
      clearTimeout(_watchTimer);

      // Restore originals
      window.WebSocket = _OrigWS;
      JSON.parse = _origParse;

      // Remove ghost elements
      document.querySelectorAll('[data-reflux-ghost]').forEach(el => el.remove());

      // Restore styled-but-not-removed elements to their original appearance
      document.querySelectorAll('[data-reflux-deleted]').forEach(el => {
        el.removeAttribute('data-reflux-deleted');
        ['background','border-left','padding-left','opacity','box-sizing','transition']
          .forEach(p => el.style.removeProperty(p));
        el.querySelector('.rx-del-badge')?.remove();
      });

      cache.clear();
      console.log(TAG, 'Stopped, DOM restored.');
    },
  });

  console.log(TAG, 'Loaded — watching for MESSAGE_DELETE events.');
})();
