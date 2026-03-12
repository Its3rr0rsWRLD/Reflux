/**
 * src/plugins/messageLogger/renderer-side.js
 *
 * Intercepts MESSAGE_DELETE and MESSAGE_UPDATE events from the Fluxer gateway
 * WebSocket and re-displays deleted/edited messages inline.
 *
 * DOM structure (discovered from live Fluxer HTML):
 *
 *   <message-list>                       ← container (grandparent)
 *     <div role="group"
 *          data-group-id="…">           ← group  (parent of message)
 *       <div data-message-id="…"
 *            data-message-index="0">    ← the actual message element
 *         …
 *       </div>
 *     </div>
 *   </message-list>
 *
 * DELETE — React removes the entire group div.  We watch the grandparent for
 *   that removal and re-insert a styled clone of the whole group.
 *
 * EDIT   — React updates the message element in place (group stays).  We read
 *   the original text from the DOM before React patches it, then inject an
 *   "Original" block below the new content after React's update fires.
 */

(function refluxMessageLogger() {
  'use strict';

  if (window.__reflux_messageLogger_loaded) return;
  window.__reflux_messageLogger_loaded = true;

  const TAG = '[Reflux:MessageLogger]';

  /** @type {Map<string, object>} messageId → delete-event data (deleted messages only) */
  const deleteCache = new Map();

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
    const { t, d } = payload;
    if (!d?.id) return;

    if (t === 'MESSAGE_DELETE') {
      if (!d.content) return;
      const entry = { ...d, _deletedAt: Date.now() };
      deleteCache.set(d.id, entry);
      console.log(TAG, `Deleted: "${d.content.slice(0, 100)}"`, d);

      const el = document.querySelector(`[data-message-id="${d.id}"]`);
      if (el && !el.dataset.refluxDeleted) prepareDeleteGhost(el, entry);

    } else if (t === 'MESSAGE_UPDATE') {
      if (!d.content) return;
      const el = document.querySelector(`[data-message-id="${d.id}"]`);
      if (!el || el.dataset.refluxEdited) return;

      // Read the original content from the DOM NOW — before React patches it
      const markupEl = el.querySelector('[class*="markup"]');
      const originalText = markupEl?.textContent?.trim();
      if (!originalText || originalText === d.content) return; // no visible change

      console.log(TAG, `Edited: "${originalText.slice(0, 100)}" → "${d.content.slice(0, 100)}"`, d);
      watchForEdit(el, originalText);
    }
  }

  // ── DELETE: ghost group ────────────────────────────────────────────────────

  function prepareDeleteGhost(el, data) {
    // Guard: mark the live element immediately so domWatcher doesn't
    // call us again while we're waiting for React to remove the group.
    if (el.dataset.refluxPending) return;
    el.dataset.refluxPending = 'true';

    const group = el.parentElement;
    const list  = group?.parentElement;
    if (!group || !list) return;

    const nextSib = group.nextElementSibling;
    const ghost   = buildDeleteGhost(group, el, data);

    // Watch the entire body subtree — React may tear down a large ancestor
    // rather than removing the group as a direct child of `list`.
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const removed of m.removedNodes) {
          if (removed === group || (removed.nodeType === 1 && removed.contains(group))) {
            mo.disconnect();
            insertNode(ghost, list, nextSib);
            return;
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 5000);
  }

  function buildDeleteGhost(group, el, data) {
    const ghost   = group.cloneNode(true);
    ghost.dataset.refluxGhost = 'true';

    // Remove any sibling messages that aren't the deleted one
    ghost.querySelectorAll('[data-message-id]').forEach(sibling => {
      if (sibling.dataset.messageId !== data.id) sibling.remove();
    });

    const ghostMsg = ghost.querySelector(`[data-message-id="${data.id}"]`) || ghost;
    ghostMsg.dataset.refluxDeleted = 'true';
    ghostMsg.style.setProperty('background',   'rgba(237,66,69,0.05)',           'important');
    ghostMsg.style.setProperty('border-left',  '2px solid rgba(237,66,69,0.38)', 'important');
    ghostMsg.style.setProperty('padding-left', '6px',                            'important');
    ghostMsg.style.setProperty('box-sizing',   'border-box',                     'important');

    const markup = ghostMsg.querySelector('[class*="markup"]');
    if (markup) markup.style.setProperty('color', 'var(--text-muted,#949ba4)', 'important');

    const timeEl = ghostMsg.querySelector('time');
    if (timeEl) applyTimestamp(timeEl, data._deletedAt, 'Deleted');

    const textWrap = ghostMsg.querySelector('[class*="messageText"]');
    if (textWrap) appendBadge(textWrap, 'Deleted', '#ed4245', 'rgba(237,66,69,0.18)');

    const bar =
      ghostMsg.querySelector('[class*="actionBarContainer"]') ||
      ghostMsg.querySelector('[class*="actionBar"]');
    if (bar) bar.remove();

    ghost.querySelectorAll('button, a, [role="button"]').forEach(btn => {
      btn.setAttribute('disabled', '');
      btn.setAttribute('tabindex', '-1');
      btn.style.setProperty('pointer-events', 'none', 'important');
    });

    ghost.style.setProperty('opacity',    '0',                  'important');
    ghost.style.setProperty('transition', 'opacity 350ms ease', 'important');
    return ghost;
  }

  // ── EDIT: inject original content block ────────────────────────────────────

  function watchForEdit(el, originalText) {
    const markup = el.querySelector('[class*="markup"]');
    if (!markup) return;

    // React will update the markup subtree when it processes the edit
    const mo = new MutationObserver(() => {
      mo.disconnect();
      injectOriginalBlock(el, originalText);
    });
    mo.observe(markup, { childList: true, subtree: true, characterData: true });
    setTimeout(() => mo.disconnect(), 5000);
  }

  function injectOriginalBlock(el, originalText) {
    if (el.querySelector('.rx-edit-original')) return;
    el.dataset.refluxEdited = 'true';

    const textWrap = el.querySelector('[class*="messageText"]');
    if (!textWrap) return;

    // Block showing the original content
    const block = document.createElement('div');
    block.className = 'rx-edit-original';
    block.style.cssText = [
      'display:flex', 'align-items:baseline', 'gap:6px',
      'margin-top:4px', 'padding:5px 8px',
      'border-left:2px solid rgba(240,178,50,0.45)',
      'background:rgba(240,178,50,0.05)',
      'border-radius:0 3px 3px 0',
      'box-sizing:border-box',
    ].join(';');

    const label = document.createElement('span');
    label.style.cssText = [
      'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
      'letter-spacing:.4px', 'color:rgba(240,178,50,0.85)',
      'white-space:nowrap', 'flex-shrink:0',
    ].join(';');
    label.textContent = 'Original';

    const text = document.createElement('span');
    text.style.cssText = 'font-size:14px;color:var(--text-muted,#949ba4);';
    text.textContent = originalText;

    block.appendChild(label);
    block.appendChild(text);
    textWrap.insertAdjacentElement('afterend', block);
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  function insertNode(node, parent, nextSib) {
    if (nextSib && parent.contains(nextSib)) {
      parent.insertBefore(node, nextSib);
    } else {
      parent.appendChild(node);
    }
    node.getBoundingClientRect(); // force reflow
    node.style.setProperty('opacity', '0.85', 'important');
  }

  function applyTimestamp(timeEl, ms, verb) {
    const date = new Date(ms || Date.now());
    timeEl.setAttribute('datetime', date.toISOString());

    const h     = date.getHours();
    const min   = date.getMinutes().toString().padStart(2, '0');
    const ampm  = h >= 12 ? 'PM' : 'AM';
    const h12   = h % 12 || 12;
    const str   = `Today at ${h12}:${min} ${ampm}`;

    timeEl.setAttribute('aria-label',
      `${verb} ${date.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' })} ${h12}:${min} ${ampm}`,
    );

    const walker = document.createTreeWalker(timeEl, NodeFilter.SHOW_TEXT);
    const nodes  = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].textContent.trim()) { nodes[i].textContent = str; break; }
    }
  }

  function appendBadge(container, label, color, bg) {
    const cls = `rx-badge-${label.toLowerCase()}`;
    if (container.querySelector(`.${cls}`)) return;
    const badge = document.createElement('span');
    badge.className = cls;
    badge.style.cssText = [
      'display:inline-flex', 'align-items:center',
      'font-size:10px', 'font-weight:700',
      'padding:1px 5px', 'border-radius:3px',
      'margin-left:6px', 'vertical-align:middle',
      `background:${bg}`, `color:${color}`,
      'text-transform:uppercase', 'letter-spacing:.4px',
      'pointer-events:none', 'user-select:none',
    ].join(';');
    badge.textContent = label;
    container.insertAdjacentElement('beforeend', badge);
  }

  // ── DOM watcher ────────────────────────────────────────────────────────────

  let _watchTimer = null;
  const domWatcher = new MutationObserver(() => {
    if (_watchTimer) return;
    _watchTimer = setTimeout(() => {
      _watchTimer = null;
      for (const [id, data] of deleteCache) {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        if (el && !el.dataset.refluxDeleted && !el.dataset.refluxPending && !el.closest('[data-reflux-ghost]')) {
          prepareDeleteGhost(el, data);
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
      document.querySelectorAll('.rx-edit-original').forEach(el => el.remove());
      document.querySelectorAll('[data-reflux-edited]').forEach(el => {
        delete el.dataset.refluxEdited;
      });
      document.querySelectorAll('[data-reflux-pending]').forEach(el => {
        delete el.dataset.refluxPending;
      });
      deleteCache.clear();
      console.log(TAG, 'Stopped.');
    },
  });

  console.log(TAG, 'Loaded — watching for MESSAGE_DELETE and MESSAGE_UPDATE events.');
})();
