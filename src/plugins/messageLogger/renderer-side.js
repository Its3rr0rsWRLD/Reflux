/**
 * src/plugins/messageLogger/renderer-side.js
 *
 * Intercepts MESSAGE_DELETE events from the Fluxer gateway WebSocket and
 * re-displays deleted messages inline as greyed-out ghost elements.
 *
 * Flow
 * ────
 * 1. JSON.parse hook  — Fluxer decompresses the zstd-stream frame then calls
 *    JSON.parse().  We intercept there; no need to reimplement zstd.
 *
 * 2. Element clone    — When a DELETE arrives the real message element is
 *    still in the DOM (React batches DOM updates to the next frame).
 *    We clone it immediately with full fidelity — username, avatar, text.
 *
 * 3. Ghost insertion  — A MutationObserver watches the message list for the
 *    original element being removed by React.  When that happens we insert
 *    the styled clone in its exact position.
 *
 * Ghost styling applied to the clone
 * ────────────────────────────────────
 *  • Red left-border + very subtle red background
 *  • Message text colour shifted to --text-muted
 *  • Timestamp updated to the moment of deletion ("Today at X:XX AM")
 *  • "DELETED" badge inserted after the message text
 *  • Action bar (react / reply / forward buttons) removed
 */

(function refluxMessageLogger() {
  'use strict';

  if (window.__reflux_messageLogger_loaded) return;
  window.__reflux_messageLogger_loaded = true;

  const TAG = '[Reflux:MessageLogger]';

  /** @type {Map<string, object>} messageId → delete-event data */
  const cache = new Map();

  // ── 1. WebSocket hook ──────────────────────────────────────────────────────
  const _OrigWS = window.WebSocket;
  let _newestGateway = null;

  function PatchedWS(url, protocols) {
    const ws = protocols != null ? new _OrigWS(url, protocols) : new _OrigWS(url);
    if (typeof url === 'string' && url.includes('gateway.fluxer.app')) {
      _newestGateway = ws;
      console.log(TAG, 'Gateway socket opened →', url);
      ws.addEventListener('close', () => {
        if (_newestGateway === ws) _newestGateway = null;
      });
    }
    return ws;
  }
  PatchedWS.prototype = _OrigWS.prototype;
  Object.setPrototypeOf(PatchedWS, _OrigWS);
  window.WebSocket = PatchedWS;

  // ── 2. JSON.parse hook ─────────────────────────────────────────────────────
  const _origParse = JSON.parse;

  JSON.parse = function interceptedJSONParse(text, ...rest) {
    const result = _origParse.call(this, text, ...rest);
    try {
      if (
        result !== null &&
        typeof result === 'object' &&
        result.op === 0 &&
        typeof result.t === 'string'
      ) {
        onGatewayDispatch(result);
      }
    } catch { /* never break Fluxer */ }
    return result;
  };

  Object.defineProperty(JSON.parse, 'toString', {
    value: () => _origParse.toString(),
    configurable: true,
  });

  // ── Gateway handler ────────────────────────────────────────────────────────

  function onGatewayDispatch(payload) {
    if (payload.t !== 'MESSAGE_DELETE') return;
    const d = payload.d;
    if (!d?.id || !d?.content) return;

    const entry = { ...d, _deletedAt: Date.now() };
    cache.set(d.id, entry);
    console.log(TAG, `Deleted: "${d.content.slice(0, 100)}"`, d);

    // The real element is still in the DOM right now — clone it before React
    // processes the state update.
    const el = document.querySelector(`[data-message-id="${d.id}"]`);
    if (el && !el.dataset.refluxDeleted) {
      prepareGhost(el, entry);
    }
  }

  // ── Ghost builder ──────────────────────────────────────────────────────────

  function prepareGhost(el, data) {
    const parent   = el.parentElement;
    if (!parent) return;

    // Record sibling BEFORE React can shift things around
    const nextSib = el.nextElementSibling;

    // Build the styled clone while the original is fully rendered
    const ghost = buildGhost(el, data);

    // Watch for React removing the original from the message list
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const removed of m.removedNodes) {
          if (removed === el || (removed.nodeType === 1 && removed.contains(el))) {
            mo.disconnect();
            insertGhost(ghost, parent, nextSib);
            return;
          }
        }
      }
    });
    mo.observe(parent, { childList: true });
    // Give up watching after 5 s (if React never removed it, the element
    // is still live and our watcher would leak).
    setTimeout(() => mo.disconnect(), 5000);
  }

  function buildGhost(el, data) {
    const ghost = el.cloneNode(true);

    // Strip the unique article id to avoid duplicate-id warnings
    ghost.removeAttribute('id');
    ghost.dataset.refluxGhost   = 'true';
    ghost.dataset.refluxDeleted = 'true';

    // Start invisible so we can fade in on insert
    ghost.style.setProperty('opacity',      '0',                            'important');
    ghost.style.setProperty('transition',   'opacity 350ms ease',           'important');
    ghost.style.setProperty('background',   'rgba(237,66,69,0.05)',          'important');
    ghost.style.setProperty('border-left',  '2px solid rgba(237,66,69,0.38)','important');
    ghost.style.setProperty('padding-left', '6px',                          'important');
    ghost.style.setProperty('box-sizing',   'border-box',                   'important');

    // Grey out message text
    const markup = ghost.querySelector('[class*="markup"]');
    if (markup) markup.style.setProperty('color', 'var(--text-muted,#949ba4)', 'important');

    // Update timestamp → deletion time
    const timeEl = ghost.querySelector('time');
    if (timeEl) applyDeletionTimestamp(timeEl, data._deletedAt);

    // Inject "DELETED" badge after the markup block
    const textWrap = ghost.querySelector('[class*="messageText"]');
    if (textWrap) appendDeletedBadge(textWrap);

    // Remove the action bar — deleted messages can't be reacted to or replied to
    const bar =
      ghost.querySelector('[class*="actionBarContainer"]') ||
      ghost.querySelector('[class*="actionBar"]');
    if (bar) bar.remove();

    // Disable any remaining interactive elements so accidental clicks do nothing
    ghost.querySelectorAll('button, a, [role="button"]').forEach(btn => {
      btn.setAttribute('disabled', '');
      btn.setAttribute('tabindex', '-1');
      btn.style.setProperty('pointer-events', 'none', 'important');
    });

    return ghost;
  }

  function insertGhost(ghost, parent, nextSib) {
    if (nextSib && parent.contains(nextSib)) {
      parent.insertBefore(ghost, nextSib);
    } else {
      parent.appendChild(ghost);
    }
    // Trigger reflow then fade in
    ghost.getBoundingClientRect();
    ghost.style.setProperty('opacity', '0.75', 'important');
  }

  // ── Timestamp helpers ──────────────────────────────────────────────────────

  function applyDeletionTimestamp(timeEl, deletedAtMs) {
    const date = new Date(deletedAtMs || Date.now());

    // Update machine-readable attribute
    timeEl.setAttribute('datetime', date.toISOString());

    // Build "Today at H:MM AM/PM" string matching Fluxer's format
    const h    = date.getHours();
    const m    = date.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12  = h % 12 || 12;
    const timeStr = `Today at ${h12}:${m} ${ampm}`;

    // Update aria-label
    timeEl.setAttribute(
      'aria-label',
      `Deleted ${date.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' })} ${h12}:${m} ${ampm}`,
    );

    // Replace the visible text node.
    // Structure: <time><i/><span> — </span>Today at 3:41 AM</time>
    // The time string is the last text node inside <time>.
    const walker = document.createTreeWalker(timeEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    // Pick the last non-empty text node (the visible time string)
    for (let i = textNodes.length - 1; i >= 0; i--) {
      if (textNodes[i].textContent.trim()) {
        textNodes[i].textContent = timeStr;
        break;
      }
    }
  }

  // ── Badge builder ──────────────────────────────────────────────────────────

  function appendDeletedBadge(container) {
    if (container.querySelector('.rx-del-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'rx-del-badge';
    badge.style.cssText = [
      'display:inline-flex', 'align-items:center',
      'font-size:10px', 'font-weight:700',
      'padding:1px 5px', 'border-radius:3px',
      'margin-left:6px', 'vertical-align:middle',
      'background:rgba(237,66,69,0.18)', 'color:#ed4245',
      'text-transform:uppercase', 'letter-spacing:.4px',
      'pointer-events:none', 'user-select:none',
    ].join(';');
    badge.textContent = 'Deleted';
    container.insertAdjacentElement('beforeend', badge);
  }

  // ── DOM watcher ────────────────────────────────────────────────────────────
  // Catches the edge case where the cache entry exists but the element wasn't
  // in the DOM yet (e.g. a batch delete arrives while navigating channels).

  let _watchTimer = null;
  const domWatcher = new MutationObserver(() => {
    if (_watchTimer) return;
    _watchTimer = setTimeout(() => {
      _watchTimer = null;
      for (const [id, data] of cache) {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        if (el && !el.dataset.refluxDeleted && !el.dataset.refluxGhost) {
          prepareGhost(el, data);
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
      window.WebSocket = _OrigWS;
      JSON.parse = _origParse;
      document.querySelectorAll('[data-reflux-ghost]').forEach(el => el.remove());
      cache.clear();
      console.log(TAG, 'Stopped, ghosts removed.');
    },
  });

  console.log(TAG, 'Loaded — watching for MESSAGE_DELETE events.');
})();
