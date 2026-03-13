/**
 * src/plugins/settingsUI/renderer-side.js
 *
 * Injects a "Reflux" section into Fluxer's settings sidebar.
 *
 * Panel rendering strategy
 * ─────────────────────────
 * We discover every CSS class name by reading them off existing live DOM
 * elements (resilient to hash changes between Fluxer builds), then build
 * our panel using the *exact* same HTML structure Fluxer uses.
 *
 * To avoid breaking React's reconciler we never touch the real tabpanel.
 * Instead we insert our panel as a sibling, and simply toggle display:none
 * on the real tabpanel while ours is active. React keeps rendering into
 * its (hidden) div normally.
 *
 * Imported plugins
 * ────────────────
 * Stored in settings at `reflux.importedPlugins`. Supports a Tampermonkey-
 * style metadata block at the top of each file:
 *   // ==RefluxPlugin==
 *   // @name        My Plugin
 *   // @author      Brady
 *   // @description Does cool stuff
 *   // @version     1.0.0
 *   // @preview     https://i.imgur.com/abc.png
 *   // ==/RefluxPlugin==
 */

(function refluxSettingsUI() {
  'use strict';

  if (window.__reflux_settingsUI_loaded) return;
  window.__reflux_settingsUI_loaded = true;

  // ─── SVG paths ────────────────────────────────────────────────────────────
  const SVG_PLUG   = 'M229.66,26.34a8,8,0,0,0-11.32,0L160,84.69l-5.38-5.38a32.05,32.05,0,0,0-45.25,0L96,92.69,82.34,79A8,8,0,0,0,71,90.34L84.69,104,48,140.69a32,32,0,0,0,0,45.26L57.37,195,26.34,226.06a8,8,0,0,0,11.32,11.32L68.69,206.63l9.37,9.38a32,32,0,0,0,45.26,0L160,179.32l13.66,13.65a8,8,0,0,0,11.32-11.31L171.32,168l13.37-13.38a32,32,0,0,0,0-45.25l-5.38-5.38,58.35-58.34A8,8,0,0,0,229.66,26.34ZM91.32,204.69a16,16,0,0,1-22.63,0L31.32,167.32a16,16,0,0,1,0-22.63L88,108l60,60Zm82.05-60.06L160,158l-62-62,13.38-13.37a16,16,0,0,1,22.62,0l49.38,49.37A16,16,0,0,1,173.37,144.63Z';
  const SVG_UPLOAD = 'M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z';
  const SVG_TRASH  = 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z';
  const SVG_PUZZLE = 'M223.07,111.06l-32-16A8,8,0,0,0,180,102.46V120H160V102.46a8,8,0,0,0-11.07-7.4l-32,16a8,8,0,0,0,0,14.88L144,136.2V160H128a8,8,0,0,0,0,16h16v23.8l-27.07,10.74a8,8,0,0,0,0,14.88l32,16A8,8,0,0,0,160,224V206.54a8,8,0,0,0,11.07,7.4l32-16a8,8,0,0,0,0-14.88L176,172.72V160h16a8,8,0,0,0,0-16H176V136.2l27.07-10.26a8,8,0,0,0,0-14.88ZM160,64V48a8,8,0,0,0-16,0V64a8,8,0,0,0,16,0ZM88,160H64a8,8,0,0,0,0,16H88a8,8,0,0,0,0-16Zm144-64H216a8,8,0,0,0,0,16h16a8,8,0,0,0,0-16ZM40,96H56a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16Zm48-32A8,8,0,0,0,99.31,58.34l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,88,64Zm128,128a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,216,192ZM88,192a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32l32-32A8,8,0,0,0,88,192Z';

  function svgEl(path, w = 20, h = 20, extraStyle = '') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" fill="currentColor" viewBox="0 0 256 256"${extraStyle ? ` style="${extraStyle}"` : ''}><path d="${path}"></path></svg>`;
  }

  /**
   * Renders a plugin icon from three accepted formats:
   *   - Raw SVG string  (<svg …>)
   *   - Image URL       (https://… or data:…)
   *   - Emoji / text    (anything else — short string)
   * Falls back to the generic puzzle SVG when icon is falsy.
   */
  function renderIcon(icon) {
    if (!icon) return svgEl(SVG_PUZZLE, 18, 18);
    const s = String(icon).trim();
    if (/^<svg/i.test(s)) return s;
    if (/^(https?:|data:)/i.test(s)) {
      return `<img src="${esc(s)}" width="22" height="22" style="object-fit:contain;border-radius:4px;" alt="" onerror="this.replaceWith(document.createRange().createContextualFragment('${svgEl(SVG_PUZZLE, 18, 18).replace(/'/g, "\\'")}'))">`;
    }
    // Emoji or short text
    return `<span style="font-size:20px;line-height:1;user-select:none;">${esc(s)}</span>`;
  }

  // ─── Utility ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function uid() { return '_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // ─── Class discovery ──────────────────────────────────────────────────────
  function discoverClasses() {
    const panel = document.querySelector('[role="tabpanel"]');
    if (!panel) return null;

    function pickAll(el) { return el ? Array.from(el.classList).join(' ') : ''; }

    const pad        = panel.querySelector('div');
    const card       = pad?.querySelector('div');
    const header     = panel.querySelector('[class*="desktopHeader"]');
    const titleCont  = panel.querySelector('[class*="titleContent"]');
    const h1         = panel.querySelector('h1');
    const scrollWrap = panel.querySelector('[class*="scrollerWrap"]');
    const scroller   = panel.querySelector('[data-settings-scroll-container]');
    const scrollCh   = scroller?.firstElementChild;
    const spacerTop  = scrollCh?.querySelector('[class*="ScrollSpacerTop"]');
    const scrollInner= scrollCh?.querySelector('[class*="desktopScrollInner"]');
    const spacerBot  = scrollCh?.querySelector('[class*="ScrollSpacerBottom"]');
    const tabCont    = scrollInner?.firstElementChild;
    const subsec     = tabCont?.firstElementChild;
    const subsecHdr  = subsec?.querySelector('[class*="subsectionHeader"]');
    const subsecTitle= subsecHdr?.querySelector('h4');
    const subsecDesc = subsecHdr?.querySelector('p');
    const subsecCont = subsec?.querySelector('[class*="subsectionContent"]');
    const trackEl    = panel.querySelector('[class*="ScrollerTrack"][class*="track"]');
    const thumbEl    = trackEl?.querySelector('[class*="thumb"]');

    return {
      desktopContent:    pickAll(panel),
      desktopContentPad: pickAll(pad),
      desktopContentCard:pickAll(card),
      desktopHeader:     pickAll(header),
      titleContent:      pickAll(titleCont),
      title:             pickAll(h1),
      scrollerWrap:      pickAll(scrollWrap),
      scroller:          pickAll(scroller),
      scrollerChildren:  pickAll(scrollCh),
      spacerTop:         pickAll(spacerTop),
      scrollInner:       pickAll(scrollInner),
      spacerBot:         pickAll(spacerBot),
      tabContainer:      pickAll(tabCont),
      subsection:        pickAll(subsec),
      subsectionHeader:  pickAll(subsecHdr),
      subsectionTitle:   pickAll(subsecTitle),
      subsectionDesc:    pickAll(subsecDesc),
      subsectionContent: pickAll(subsecCont),
      scrollTrack:       pickAll(trackEl),
      scrollTrackThumb:  pickAll(thumbEl),
      // sidebar (filled in by discoverSidebarClasses)
      cat: '', catTitle: '', item: '', itemIcon: '', itemLabel: '', tabLabel: '',
    };
  }

  function discoverSidebarClasses(devSection) {
    function pick(el) { return el ? Array.from(el.classList).join(' ') : ''; }
    const btn  = devSection.querySelector('button');
    const svgE = btn?.querySelector('svg');
    const span = btn?.querySelector('span');
    const inner= btn?.querySelector('span > div');
    return {
      cat:      pick(devSection),
      catTitle: pick(devSection.querySelector('h2')),
      item:     pick(btn),
      itemIcon: pick(svgE),
      itemLabel:pick(span),
      tabLabel: pick(inner),
    };
  }

  // ─── Sidebar highlight override ───────────────────────────────────────────
  // Injected while our panel is active so the previously-selected Fluxer tab
  // loses its highlight and our button gains it.
  let _styleTag = null;

  function injectActiveStyle() {
    if (_styleTag) return;
    _styleTag = document.createElement('style');
    _styleTag.id = 'reflux-active-style';
    // Suppress highlight on all non-Reflux sidebar tabs
    _styleTag.textContent = `
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="tab"][aria-selected="true"],
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="tab"][data-selected="true"] {
        background: transparent !important;
        color: var(--interactive-normal, #b9bbbe) !important;
      }
      [class*="sidebarCategory"]:not(#reflux-sidebar-section) [role="tab"][aria-selected="true"] > * {
        opacity: 0.6 !important;
      }
      #reflux-tab-plugins {
        background: var(--background-modifier-selected, rgba(255,255,255,0.1)) !important;
        color: var(--interactive-active, #fff) !important;
      }
    `;
    document.head.appendChild(_styleTag);
  }

  function removeActiveStyle() {
    _styleTag?.remove();
    _styleTag = null;
  }

  // ─── Imported plugin storage ───────────────────────────────────────────────
  async function getImported() {
    try { return await window.refluxBridge?.getSetting('reflux.importedPlugins', []) ?? []; }
    catch { return []; }
  }
  async function saveImported(list) {
    try { await window.refluxBridge?.setSetting('reflux.importedPlugins', list); }
    catch (e) { console.error('[Reflux:SettingsUI] save failed', e); }
  }

  function parseMetadata(src, filename) {
    const meta = { name: filename.replace(/\.js$/i,''), description: '', author: '', version: '', preview: '', icon: '' };
    const block = src.match(/\/\/\s*==RefluxPlugin==([\s\S]*?)\/\/\s*==\/RefluxPlugin==/i);
    if (block) {
      for (const line of block[1].split('\n')) {
        const m = line.match(/\/\/\s*@(\w+)\s+(.*)/);
        if (m && m[1] in meta) meta[m[1]] = m[2].trim();
      }
    }
    return meta;
  }

  function runPlugin(src) {
    try { new Function(src)(); }
    catch (e) { console.error('[Reflux:SettingsUI] Plugin runtime error:', e); }
  }

  getImported().then(list => list.filter(p => p.enabled !== false).forEach(p => runPlugin(p.source)));

  // ─── Plugin card component ─────────────────────────────────────────────────
  // Uses inline styles + CSS vars — zero dependency on Fluxer's hashed classes.
  function makePluginCard({ id, icon, name, description, author, version, badge, enabled, onToggle, onRemove }) {
    const card = document.createElement('div');
    card.dataset.rxId = id;
    card.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'padding:12px 0',
      'border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,0.06))',
    ].join(';');

    // Left: icon — use plugin-specific icon if available, else generic puzzle
    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = [
      'width:36px', 'height:36px', 'border-radius:8px', 'flex-shrink:0',
      'background:var(--background-tertiary,#2b2d31)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'color:var(--interactive-normal,#b9bbbe)',
    ].join(';');
    iconWrap.innerHTML = renderIcon(icon);

    // Middle: text info
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px;';
    nameRow.innerHTML = `<span style="font-size:15px;font-weight:600;color:var(--text-normal,#dbdee1);">${esc(name)}</span>`;
    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.style.cssText = [
        'font-size:10px', 'font-weight:700', 'padding:1px 5px',
        'border-radius:3px', 'letter-spacing:.3px',
        'background:var(--background-modifier-accent,rgba(255,255,255,0.1))',
        'color:var(--text-muted,#949ba4)', 'text-transform:uppercase',
      ].join(';');
      badgeEl.textContent = badge;
      nameRow.appendChild(badgeEl);
    }
    info.appendChild(nameRow);

    const meta = [author ? `by ${author}` : '', version ? `v${version}` : ''].filter(Boolean).join(' · ');
    if (meta) {
      const metaEl = document.createElement('div');
      metaEl.style.cssText = 'font-size:12px;color:var(--text-muted,#949ba4);margin-bottom:3px;';
      metaEl.textContent = meta;
      info.appendChild(metaEl);
    }
    if (description) {
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:13px;color:var(--text-muted,#949ba4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      desc.textContent = description;
      info.appendChild(desc);
    }

    // Right: toggle
    const toggle = makeToggle(enabled, onToggle);

    // Right: remove button (imported plugins only)
    card.appendChild(iconWrap);
    card.appendChild(info);
    card.appendChild(toggle);
    if (onRemove) {
      const del = document.createElement('button');
      del.type = 'button';
      del.title = 'Remove plugin';
      del.style.cssText = [
        'background:none', 'border:none', 'cursor:pointer',
        'padding:4px', 'border-radius:4px',
        'color:var(--status-danger,#ed4245)', 'opacity:.6',
        'display:flex', 'align-items:center', 'flex-shrink:0',
        'transition:opacity 120ms, background 120ms',
      ].join(';');
      del.innerHTML = svgEl(SVG_TRASH, 16, 16);
      del.addEventListener('mouseenter', () => { del.style.opacity = '1'; del.style.background = 'rgba(237,66,69,.1)'; });
      del.addEventListener('mouseleave', () => { del.style.opacity = '.6'; del.style.background = 'none'; });
      del.addEventListener('click', onRemove);
      card.appendChild(del);
    }

    return card;
  }

  function makeToggle(initialChecked, onChange) {
    let checked = initialChecked;
    const TRACK_ON  = 'var(--brand-500,#5865f2)';
    const TRACK_OFF = 'var(--background-modifier-accent,#4e5058)';

    const track = document.createElement('button');
    track.type = 'button';
    track.setAttribute('role', 'switch');
    track.setAttribute('aria-checked', String(checked));
    track.style.cssText = [
      'position:relative', 'width:40px', 'height:22px',
      'border-radius:11px', 'border:none', 'cursor:pointer',
      `background:${checked ? TRACK_ON : TRACK_OFF}`,
      'transition:background 200ms', 'flex-shrink:0', 'padding:0',
    ].join(';');

    const thumb = document.createElement('span');
    thumb.style.cssText = [
      'position:absolute', 'top:3px',
      `left:${checked ? '21px' : '3px'}`,
      'width:16px', 'height:16px', 'border-radius:50%',
      'background:#fff', 'transition:left 200ms',
      'pointer-events:none',
    ].join(';');
    track.appendChild(thumb);

    const applyState = (on) => {
      checked = on;
      track.setAttribute('aria-checked', String(on));
      track.style.background = on ? TRACK_ON : TRACK_OFF;
      thumb.style.left = on ? '21px' : '3px';
    };

    track.addEventListener('click', async () => {
      const next = !checked;
      applyState(next);
      track.disabled = true;
      try { await onChange(next); } catch { applyState(!next); } finally { track.disabled = false; }
    });

    return track;
  }

  // ─── Subsection builder ───────────────────────────────────────────────────
  function makeSubsection(c, title, description) {
    const sec = document.createElement('div');
    sec.className = c.subsection;

    const hdr = document.createElement('div');
    hdr.className = c.subsectionHeader;
    hdr.innerHTML = `<h4 class="${c.subsectionTitle}">${esc(title)}</h4>` +
      (description ? `<p class="${c.subsectionDesc}">${esc(description)}</p>` : '');

    const content = document.createElement('div');
    content.className = c.subsectionContent;

    sec.appendChild(hdr);
    sec.appendChild(content);
    return { sec, content };
  }

  // ─── Full page builder ────────────────────────────────────────────────────
  async function buildPluginsPage(c) {
    const page = document.createElement('div');
    page.className = c.desktopContent;
    page.setAttribute('role', 'tabpanel');
    page.id = 'reflux-tabpanel-plugins';

    page.innerHTML = `
      <div class="${c.desktopContentPad}">
        <div class="${c.desktopContentCard}">
          <div class="${c.desktopHeader}" style="transition-duration:200ms;">
            <div class="${c.titleContent}" style="opacity:1;">
              <h1 class="${c.title}">Plugins</h1>
            </div>
          </div>
          <div role="group" class="${c.scrollerWrap}">
            <div class="${c.scroller}" dir="ltr" data-settings-scroll-container="true" style="overflow:hidden auto;">
              <div class="${c.scrollerChildren}">
                <div class="${c.spacerTop}"></div>
                <div class="${c.scrollInner}">
                  <div class="${c.tabContainer}" id="rx-tab-inner"></div>
                </div>
                <div class="${c.spacerBot}"></div>
              </div>
            </div>
            <div class="${c.scrollTrack}" role="presentation" style="pointer-events:none;">
              <div class="${c.scrollTrackThumb}" data-scroller-thumb="true" role="presentation" style="height:0"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const inner = page.querySelector('#rx-tab-inner');

    // ── Installed Plugins subsection ─────────────────────────────────────
    const { sec: instSec, content: instContent } = makeSubsection(
      c, 'Installed Plugins',
      'Toggle plugins on or off. Changes take effect immediately.',
    );
    inner.appendChild(instSec);

    async function renderPlugins() {
      instContent.innerHTML = '';

      // Built-ins from main process
      let builtins = [];
      try {
        builtins = (await window.refluxBridge?.listPlugins() ?? [])
          .filter(p => p.name !== 'settingsUI');
      } catch { /* ignore */ }

      for (const p of builtins) {
        const card = makePluginCard({
          id:          'rx-' + p.name,
          icon:        p.icon || null,
          name:        p.displayName || p.name,
          description: p.description || '',
          badge:       'Built-in',
          enabled:     p.enabled ?? true,
          onToggle: async (on) => {
            try {
              if (on) await window.refluxBridge?.enablePlugin(p.name);
              else    await window.refluxBridge?.disablePlugin(p.name);
            } catch (e) { console.error(e); throw e; }
          },
        });
        instContent.appendChild(card);
      }

      // Imported plugins
      const imported = await getImported();
      for (const p of imported) {
        const card = makePluginCard({
          id:          'rx-imp-' + p.id,
          icon:        p.icon || null,
          name:        p.name,
          description: p.description || '',
          author:      p.author || '',
          version:     p.version || '',
          badge:       'Imported',
          enabled:     p.enabled !== false,
          onToggle: async (on) => {
            const all = await getImported();
            const t = all.find(x => x.id === p.id);
            if (t) { t.enabled = on; await saveImported(all); }
          },
          onRemove: async () => {
            const all = await getImported();
            const idx = all.findIndex(x => x.id === p.id);
            if (idx !== -1) { all.splice(idx, 1); await saveImported(all); renderPlugins(); }
          },
        });
        instContent.appendChild(card);
      }

      if (!instContent.hasChildNodes()) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color:var(--text-muted,#949ba4);font-size:14px;margin:8px 0 0;';
        empty.textContent = 'No plugins installed. Import a .js file below.';
        instContent.appendChild(empty);
      }
    }

    await renderPlugins();

    // ── Import subsection ─────────────────────────────────────────────────
    const { sec: impSec, content: impContent } = makeSubsection(
      c, 'Import Plugin',
      'Load a .js plugin file from your computer. The plugin runs immediately and on every future launch.',
    );
    inner.appendChild(impSec);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.js';
    fileInput.style.display = 'none';
    impContent.appendChild(fileInput);

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:8px',
      'padding:8px 16px', 'border-radius:4px', 'border:none',
      'cursor:pointer', 'font-size:14px', 'font-weight:500',
      'background:var(--brand-500,#5865f2)', 'color:#fff',
      'transition:filter 120ms',
    ].join(';');
    importBtn.innerHTML = svgEl(SVG_UPLOAD, 16, 16) + ' Import Plugin';
    importBtn.addEventListener('mouseenter', () => importBtn.style.filter = 'brightness(1.1)');
    importBtn.addEventListener('mouseleave', () => importBtn.style.filter = '');
    importBtn.addEventListener('click', () => fileInput.click());
    impContent.appendChild(importBtn);

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const source = ev.target.result;
        const meta   = parseMetadata(source, file.name);
        const plugin = { id: uid(), ...meta, enabled: true, source };
        const all    = await getImported();
        all.push(plugin);
        await saveImported(all);
        runPlugin(source);
        await renderPlugins();
      };
      reader.readAsText(file);
      fileInput.value = '';
    });

    return page;
  }

  // ─── Overlay management ───────────────────────────────────────────────────
  let _ourPanel  = null;
  let _realPanel = null;
  let _cleanupFn = null;

  async function showRefluxPanel(sc) {
    // Discover structural classes; retry once if DOM not fully settled
    let c = discoverClasses();
    if (!c || !c.desktopContentPad) {
      await new Promise(r => setTimeout(r, 200));
      c = discoverClasses();
      if (!c) return;
    }
    Object.assign(c, sc);

    _realPanel = document.querySelector('[role="tabpanel"]');
    if (!_realPanel) return;

    // Remove any stale panel from a previous open
    document.getElementById('reflux-tabpanel-plugins')?.remove();

    _ourPanel = await buildPluginsPage(c);

    _realPanel.insertAdjacentElement('afterend', _ourPanel);
    _realPanel.style.display = 'none';

    // Override sidebar highlight CSS
    injectActiveStyle();

    // Restore when any native Fluxer tab is clicked
    if (_cleanupFn) _cleanupFn();
    const handler = (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab && tab.id !== 'reflux-tab-plugins') hideRefluxPanel();
    };
    document.addEventListener('click', handler, true);
    _cleanupFn = () => document.removeEventListener('click', handler, true);
  }

  function hideRefluxPanel() {
    removeActiveStyle();
    if (_realPanel)  { _realPanel.style.display = ''; _realPanel = null; }
    if (_ourPanel)   { _ourPanel.remove(); _ourPanel = null; }
    if (_cleanupFn)  { _cleanupFn(); _cleanupFn = null; }
    document.getElementById('reflux-tab-plugins')?.setAttribute('aria-selected', 'false');
    document.getElementById('reflux-tab-plugins')?.setAttribute('tabindex', '-1');
  }

  // ─── Sidebar injection ────────────────────────────────────────────────────
  function findDeveloperSection() {
    for (const s of document.querySelectorAll('[class*="sidebarCategory"]')) {
      if (s.querySelector('h2')?.textContent.trim() === 'Developer') return s;
    }
    return null;
  }

  function buildSidebarSection(sc) {
    const section = document.createElement('section');
    section.id = 'reflux-sidebar-section';
    section.className = sc.cat;
    section.setAttribute('aria-labelledby', 'reflux-sidebar-heading');

    const h2 = document.createElement('h2');
    h2.id = 'reflux-sidebar-heading';
    h2.className = sc.catTitle;
    h2.textContent = 'Reflux';
    section.appendChild(h2);

    const btn = document.createElement('button');
    btn.id = 'reflux-tab-plugins';
    btn.type = 'button';
    btn.className = sc.item;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('tabindex', '-1');

    const iconWrap = document.createElement('span');
    iconWrap.innerHTML = svgEl(SVG_PLUG);
    const svgE = iconWrap.firstElementChild;
    if (svgE) svgE.setAttribute('class', sc.itemIcon);

    const ver = window.refluxBridge?.version;

    const labelSpan = document.createElement('span');
    labelSpan.className = sc.itemLabel;
    labelSpan.innerHTML = `<div class="${sc.tabLabel}"><span>Plugins</span></div>`;

    btn.appendChild(svgE || iconWrap);
    btn.appendChild(labelSpan);

    const verSpan = document.createElement('span');
    verSpan.id = 'reflux-version-badge';
    verSpan.textContent = `Reflux${ver ? ` (${ver})` : ''}`;
    verSpan.style.cssText = [
      'font-size:10px', 'font-weight:600',
      'color:var(--text-muted,#949ba4)',
      'padding:1px 5px', 'border-radius:3px',
      'background:var(--background-tertiary,#2b2d31)',
      'white-space:nowrap', 'flex-shrink:0',
    ].join(';');
    btn.appendChild(verSpan);

    btn.addEventListener('click', async () => {
      btn.setAttribute('aria-selected', 'true');
      btn.setAttribute('tabindex', '0');
      await showRefluxPanel(sc);
    });

    section.appendChild(btn);
    return section;
  }

  function inject(devSection) {
    if (document.getElementById('reflux-sidebar-section')) return;
    const sc = discoverSidebarClasses(devSection);
    devSection.parentNode.insertBefore(buildSidebarSection(sc), devSection);
    console.log('[Reflux:SettingsUI] Sidebar injected.');
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────
  let _timer = null;
  function tryInject() {
    const dev = findDeveloperSection();
    if (dev) inject(dev);
  }

  tryInject();

  const observer = new MutationObserver(() => {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; tryInject(); }, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  window.__reflux?.pluginManager?.register?.({
    name: 'settingsUI',
    start() {},
    stop() {
      observer.disconnect();
      clearTimeout(_timer);
      hideRefluxPanel();
      document.getElementById('reflux-sidebar-section')?.remove();
      removeActiveStyle();
      window.__reflux_settingsUI_loaded = false;
    },
  });

  console.log('[Reflux:SettingsUI] Ready.');
})();
