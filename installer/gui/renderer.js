'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
let state = 'LOADING';
const ctx = {
	found: false,
	installed: false,
	resourcesDir: null,
	detectError: null,
	lastOp: null, // 'install' | 'repair' | 'uninstall'
	doneSuccess: false,
	doneMessage: '',
};

// ── Step mapping ───────────────────────────────────────────────────────────────
const STEP_INDEX = {WELCOME: -1, TOS: 0, LOADING: 1, READY: 1, OPERATING: 1, DONE: 2};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const card = $('card');
const sectionsWrap = $('sections-wrap');
const stepsArea = $('steps-area');
const sWelcome = $('section-welcome');
const sTos = $('section-tos');
const sLoading = $('section-loading');
const sReady = $('section-ready');
const sOp = $('section-operating');
const sDone = $('section-done');
const tosBox = $('tos-box');
const tosHint = $('tos-hint');
const btnAccept = $('btn-accept');
const btnDecline = $('btn-decline');
const statusPill = $('status-pill');
const statusText = $('status-text');
const statusDesc = $('status-desc');
const errorNote = $('error-note');
const btnInstall = $('btn-install');
const btnUpdate = $('btn-update');
const btnRowUpdate = $('btn-row-update');
const btnUninstall = $('btn-uninstall');
const opTitle = $('op-title');
const logContainer = $('log-container');
const doneIconWrap = $('done-icon-wrap');
const doneTitleEl = $('done-title');
const doneMsg = $('done-message');
const btnDone = $('btn-done');

const SECTIONS = [sWelcome, sTos, sLoading, sReady, sOp, sDone];

// ── Section transitions ────────────────────────────────────────────────────────
let _active = null;

function showSection(el, direction = 'forward') {
	const prev = _active;
	_active = el;

	if (!prev) {
		// Initial render — no animation
		SECTIONS.forEach((s) => {
			s.style.display = 'none';
			s.className = 'section';
		});
		el.style.display = 'block';
		el.className = 'section active';
		return;
	}

	if (prev === el) return;

	// Hide all unrelated sections immediately
	SECTIONS.forEach((s) => {
		if (s !== prev && s !== el) {
			s.style.display = 'none';
			s.className = 'section';
		}
	});

	const enterClass = direction === 'forward' ? 'enter-right' : 'enter-left';
	const exitClass = direction === 'forward' ? 'exit-left' : 'exit-right';

	// Reset both elements to cancel any in-progress animation before starting new ones.
	// Without this, a fast IPC response can call showSection again before the previous
	// enter animation finishes, leaving stale animationend listeners that corrupt state.
	prev.className = 'section';
	void prev.offsetWidth;
	el.style.display = 'block';
	el.className = 'section';
	void el.offsetWidth;

	// Outgoing: absolutely positioned so it doesn't push layout
	prev.className = `section is-exiting ${exitClass}`;
	prev.addEventListener(
		'animationend',
		() => {
			prev.style.display = 'none';
			prev.className = 'section';
		},
		{once: true},
	);

	// Incoming
	el.className = `section is-entering ${enterClass}`;
	el.addEventListener(
		'animationend',
		() => {
			el.className = 'section active';
		},
		{once: true},
	);
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function updateSteps(newState) {
	const active = STEP_INDEX[newState] ?? 0;
	const showSteps = newState !== 'WELCOME';
	stepsArea.style.display = showSteps ? 'block' : 'none';
	sectionsWrap.classList.toggle('is-welcome', newState === 'WELCOME');

	for (let i = 0; i <= 2; i++) {
		const stepEl = $(`step-${i}`);
		const connectorEl = $(`connector-${i}`);
		stepEl.classList.remove('active', 'complete');
		if (i < active) stepEl.classList.add('complete');
		else if (i === active) stepEl.classList.add('active');
		if (connectorEl) connectorEl.classList.toggle('complete', i < active);
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function appendLogLine(type, message) {
	const el = document.createElement('div');
	const prefix = {step: '›', warn: '!', error: '✕', success: '✓'}[type] ?? '›';
	el.className = `log-line ${type}`;
	el.innerHTML = `<span class="log-prefix">${prefix}</span><span class="log-msg">${message}</span>`;
	logContainer.appendChild(el);
	requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
	logContainer.scrollTop = logContainer.scrollHeight;
}

function triggerShake() {
	card.classList.remove('anim-shake');
	void card.offsetWidth;
	card.classList.add('anim-shake');
}

// ── Render ─────────────────────────────────────────────────────────────────────
function render(direction = 'forward') {
	switch (state) {
		case 'WELCOME': {
			showSection(sWelcome, direction);
			break;
		}

		case 'TOS': {
			showSection(sTos, direction);
			break;
		}

		case 'LOADING': {
			showSection(sLoading, direction);
			break;
		}

		case 'READY': {
			showSection(sReady, direction);
			errorNote.style.display = 'none';

			if (!ctx.found) {
				statusPill.className = 'status-pill not-found';
				statusText.textContent = 'Fluxer Not Found';
				statusDesc.textContent = 'Could not locate Fluxer on your system. Make sure Fluxer is installed first.';
				btnRowUpdate.style.display = 'none';
				btnInstall.disabled = true;
				btnUninstall.disabled = true;
				if (ctx.detectError) {
					errorNote.textContent = ctx.detectError;
					errorNote.style.display = 'block';
				}
			} else if (ctx.installed) {
				statusPill.className = 'status-pill installed';
				statusText.textContent = 'Reflux Installed';
				statusDesc.textContent = 'Reflux is active. Restart Fluxer after making changes.';
				btnRowUpdate.style.display = 'flex';
				btnInstall.textContent = 'Repair';
				btnInstall.disabled = false;
				btnInstall.className = 'btn btn-secondary';
				btnUninstall.disabled = false;
				btnUninstall.className = 'btn btn-secondary';
			} else {
				statusPill.className = 'status-pill not-installed';
				statusText.textContent = 'Not Installed';
				statusDesc.textContent = 'Fluxer is detected. Install Reflux to get started.';
				btnRowUpdate.style.display = 'none';
				btnInstall.textContent = 'Install';
				btnInstall.disabled = false;
				btnInstall.className = 'btn btn-primary';
				btnUninstall.disabled = true;
				btnUninstall.className = 'btn btn-secondary';
			}
			break;
		}

		case 'OPERATING': {
			showSection(sOp, direction);
			logContainer.innerHTML = '';
			opTitle.textContent =
				ctx.lastOp === 'uninstall'
					? 'Uninstalling Reflux…'
					: ctx.lastOp === 'repair'
						? 'Repairing Reflux…'
						: ctx.lastOp === 'update'
							? 'Updating Reflux…'
							: 'Installing Reflux…';
			break;
		}

		case 'DONE': {
			showSection(sDone, direction);
			doneMsg.textContent = ctx.doneMessage;

			if (ctx.doneSuccess) {
				doneIconWrap.className = 'done-icon-wrap success';
				doneIconWrap.innerHTML = `
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <path class="check-path" d="M6 14 L11.5 20 L22 9"
              stroke="#4ade80" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>`;
				doneTitleEl.className = 'done-title success';
				doneTitleEl.textContent =
					ctx.lastOp === 'uninstall'
						? 'Uninstalled!'
						: ctx.lastOp === 'repair'
							? 'Repaired!'
							: ctx.lastOp === 'update'
								? 'Updated!'
								: 'Installed!';
				btnDone.textContent = 'Done';
			} else {
				doneIconWrap.className = 'done-icon-wrap error';
				doneIconWrap.innerHTML = `
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
               stroke="#f87171" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6"  x2="6"  y2="18"/>
            <line x1="6"  y1="6"  x2="18" y2="18"/>
          </svg>`;
				doneTitleEl.className = 'done-title error';
				doneTitleEl.textContent = 'Failed';
				btnDone.textContent = 'Retry';
				requestAnimationFrame(triggerShake);
			}
			break;
		}
	}
}

// ── Transition ─────────────────────────────────────────────────────────────────
function transition(newState, patch = {}, direction = 'forward') {
	Object.assign(ctx, patch);
	state = newState;
	updateSteps(newState);
	render(direction);
}

// ── ToS scroll gate ────────────────────────────────────────────────────────────
tosBox.addEventListener('scroll', () => {
	const atBottom = tosBox.scrollTop + tosBox.clientHeight >= tosBox.scrollHeight - 4;
	if (atBottom) {
		btnAccept.disabled = false;
		tosHint.classList.add('hidden');
	}
});

// ── IPC ────────────────────────────────────────────────────────────────────────
window.refluxInstaller.onProgress(({type, message}) => {
	if (state === 'OPERATING') appendLogLine(type, message);
});

window.refluxInstaller.onComplete(({success, message}) => {
	transition('DONE', {doneSuccess: success, doneMessage: message}, 'forward');
});

// ── Button handlers ────────────────────────────────────────────────────────────
$('btn-start').addEventListener('click', () => {
	transition('TOS', {}, 'forward');
});

btnDecline.addEventListener('click', () => window.refluxInstaller.close());

btnAccept.addEventListener('click', async () => {
	transition('LOADING', {}, 'forward');
	const status = await window.refluxInstaller.checkStatus();
	transition(
		'READY',
		{
			found: status.found,
			installed: status.installed,
			resourcesDir: status.resourcesDir,
			detectError: status.error,
		},
		'forward',
	);
});

btnUpdate.addEventListener('click', () => {
	transition('OPERATING', {lastOp: 'update'}, 'forward');
	window.refluxInstaller.update();
});

btnInstall.addEventListener('click', () => {
	if (btnInstall.disabled) return;
	const isRepair = ctx.installed;
	transition('OPERATING', {lastOp: isRepair ? 'repair' : 'install'}, 'forward');
	window.refluxInstaller.install();
});

btnUninstall.addEventListener('click', () => {
	if (btnUninstall.disabled) return;
	transition('OPERATING', {lastOp: 'uninstall'}, 'forward');
	window.refluxInstaller.uninstall();
});

btnDone.addEventListener('click', async () => {
	transition('LOADING', {}, 'back');
	const status = await window.refluxInstaller.checkStatus();
	transition(
		'READY',
		{
			found: status.found,
			installed: status.installed,
			resourcesDir: status.resourcesDir,
			detectError: status.error,
		},
		'back',
	);
});

$('btn-minimize').addEventListener('click', () => window.refluxInstaller.minimize());
$('btn-close').addEventListener('click', () => window.refluxInstaller.close());

// ── Init — check status on startup ─────────────────────────────────────────────
(async () => {
	updateSteps('LOADING');
	showSection(sLoading);

	window.refluxInstaller.version().then((v) => {
		const badge = $('version-badge');
		if (badge && v) badge.textContent = v;
	});

	const status = await window.refluxInstaller.checkStatus();
	if (status.installed) {
		// Already installed — skip welcome/ToS, go straight to Repair/Uninstall
		transition(
			'READY',
			{
				found: status.found,
				installed: status.installed,
				resourcesDir: status.resourcesDir,
				detectError: status.error,
			},
			'forward',
		);
	} else {
		transition('WELCOME', {}, 'forward');
	}
})();
