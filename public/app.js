'use strict';

/* ================= Dane ================= */

const CLASSES = ['OPP A', 'OPP B', 'ILCA 4', 'ILCA 6', 'ILCA 7'];

const PREP_FLAGS = [
  { id: 'P', label: 'P', name: 'P' },
  { id: 'I', label: 'I', name: 'I' },
  { id: 'Z', label: 'Z', name: 'Z' },
  { id: 'U', label: 'U', name: 'U' },
  { id: 'B', label: 'Czarna', name: 'czarnej' },
];

// Czasy w sekundach przed startem. W przyszłości kolejne gotowe schematy.
const PRESETS = {
  fleet: { name: 'Regaty floty (5-4-1-0)', warning: 300, prep: 240, oneMin: 60 },
};

const DEFAULTS = {
  classes: ['OPP A'],
  noOffset: true,
  gaps: [],            // gaps[i]: start klasy i → sygnał ostrzeżenia klasy i+1 (s)
  preset: 'fleet',
  warning: 300,
  prep: 240,
  oneMin: 60,
  sameFlag: true,
  flag: 'P',
  classFlags: {},
  orangeTime: 300,     // flaga pomarańczowa → sygnał ostrzeżenia pierwszej klasy (s)
  startWithOrange: true,
};

const STEPS = ['classes', 'sequence', 'flags', 'orange', 'ready'];
const DEFAULT_GAP = 60;

const CONFIG_KEY = 'sailing-timer:config';
const RUN_KEY = 'sailing-timer:run';

/* ================= Stan ================= */

let config = Object.assign(structuredClone(DEFAULTS), load(CONFIG_KEY) || {});
let view = 'classes';
let run = null;
let muted = false;

const app = document.getElementById('app');

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* prywatny tryb itp. */ }
}
function saveConfig() { store(CONFIG_KEY, config); }

/* ================= Pomocnicze ================= */

const pad = (n) => String(n).padStart(2, '0');

function fmt(secs) {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function flagFor(cfg, cls) {
  return cfg.sameFlag ? cfg.flag : (cfg.classFlags[cls] || cfg.flag);
}
function flagName(id) {
  return (PREP_FLAGS.find((f) => f.id === id) || PREP_FLAGS[0]).name;
}

function syncGaps() {
  const n = Math.max(0, config.classes.length - 1);
  while (config.gaps.length < n) config.gaps.push(DEFAULT_GAP);
  config.gaps.length = n;
}

function sequenceError(cfg) {
  if (!(cfg.warning > cfg.prep)) return 'Sygnał ostrzeżenia musi być przed sygnałem przygotowania.';
  if (!(cfg.prep > cfg.oneMin)) return 'Sygnał przygotowania musi być przed sygnałem „jedna minuta”.';
  if (!(cfg.oneMin > 0)) return 'Sygnał „jedna minuta” musi być przed startem.';
  return null;
}

/* ================= Plan sekwencji ================= */

// Zwraca listę zdarzeń (czas w s od uruchomienia timera) i listę startów klas.
function buildPlan(cfg, withOrange) {
  const raw = [];
  const starts = [];
  let warning = withOrange ? cfg.orangeTime : 0;

  if (withOrange) {
    raw.push({ t: 0, kind: 'Pomarańczowa', cls: '', title: 'podniesienie flagi pomarańczowej', note: 'Flaga pomarańczowa – linia startu wystawiona' });
  }

  cfg.classes.forEach((cls, i) => {
    const fn = flagName(flagFor(cfg, cls));
    const start = warning + cfg.warning;
    raw.push({ t: warning, kind: 'Ostrzeżenie', cls, title: `podniesienie flagi ${cls}`, note: `Sygnał ostrzeżenia · ${cls}` });
    raw.push({ t: start - cfg.prep, kind: 'Przygotowanie', cls, title: `podniesienie flagi ${fn}`, note: `Sygnał przygotowania · ${cls}` });
    raw.push({ t: start - cfg.oneMin, kind: '1 minuta', cls, title: `opuszczenie flagi ${fn}`, note: `Jedna minuta · ${cls}` });
    raw.push({ t: start, kind: 'Start', cls, title: `start ${cls}`, note: `Opuszczenie flagi ${cls}` });
    starts.push({ cls, t: start });
    warning = start + (cfg.noOffset ? 0 : (cfg.gaps[i] || 0));
  });

  raw.sort((a, b) => a.t - b.t);

  // Zdarzenia w tej samej chwili (np. start A = ostrzeżenie B) łączymy w jedno.
  const events = [];
  for (const e of raw) {
    const last = events[events.length - 1];
    if (last && last.t === e.t) {
      last.title += ' + ' + e.title;
      last.note += ' / ' + e.note;
    } else {
      events.push({ t: e.t, title: e.title, note: e.note });
    }
  }
  return { raw, events, starts };
}

// Piknięcia: 30 s przed – jedno; 10…6 s – pojedyncze; 5…1 s – podwójne; na sygnał – długie.
function buildBeeps(events) {
  const prio = { short: 1, double: 2, long: 3 };
  const byTime = new Map();
  const add = (at, kind) => {
    if (at < 0) return;
    const cur = byTime.get(at);
    if (!cur || prio[kind] > prio[cur]) byTime.set(at, kind);
  };
  for (const e of events) {
    const T = e.t * 1000;
    add(T - 30000, 'short');
    for (let s = 10; s >= 6; s--) add(T - s * 1000, 'short');
    for (let s = 5; s >= 1; s--) add(T - s * 1000, 'double');
    add(T, 'long');
  }
  return [...byTime.entries()].map(([at, kind]) => ({ at, kind })).sort((a, b) => a.at - b.at);
}

/* ================= Dźwięk ================= */

let audio = null;
let audioUnlockAt = 0;

function ensureAudio() {
  audioUnlockAt = Date.now();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* iOS 16.4+ */ }
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = new AC();
  }
  if (audio.state !== 'running') audio.resume();
  // Odblokowanie na iOS: krótki cichy bufor w geście użytkownika.
  const buf = audio.createBuffer(1, 1, 22050);
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.connect(audio.destination);
  src.start(0);
}

function tone(when, dur, freq) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(0.45, when + 0.005);
  gain.gain.setValueAtTime(0.45, when + dur - 0.015);
  gain.gain.linearRampToValueAtTime(0, when + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

function playBeep(kind, when) {
  if (!audio || muted) return;
  if (kind === 'short') tone(when, 0.15, 1000);
  else if (kind === 'double') { tone(when, 0.1, 1250); tone(when + 0.18, 0.1, 1250); }
  else tone(when, 1.0, 880);
}

function testSound() {
  ensureAudio();
  if (!audio) return;
  const t = audio.currentTime + 0.05;
  playBeep('short', t);
  playBeep('double', t + 0.6);
  playBeep('long', t + 1.3);
}

/* ================= Wake Lock ================= */

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* brak wsparcia / odmowa */ }
}
function releaseWakeLock() {
  try { wakeLock && wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}

/* ================= Ikony ================= */

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

/* ================= Widoki konfiguracji ================= */

function timeInput(key, secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `<span class="time" data-key="${key}">
    <input class="mm" type="text" inputmode="numeric" maxlength="2" value="${m}" aria-label="minuty">:<input class="ss" type="text" inputmode="numeric" maxlength="2" value="${pad(s)}" aria-label="sekundy">
  </span>`;
}

function readTimeInput(el) {
  const box = el.closest('.time');
  const m = parseInt(box.querySelector('.mm').value, 10) || 0;
  const s = Math.min(59, parseInt(box.querySelector('.ss').value, 10) || 0);
  return { key: box.dataset.key, secs: m * 60 + s };
}

function header(title) {
  const idx = STEPS.indexOf(view);
  const back = idx > 0
    ? `<button class="round-btn" data-act="back" aria-label="Wstecz">${ICON.back}</button>`
    : '<span></span>';
  return `
    <div class="topbar">${back}<h2>${esc(title)}</h2><span></span></div>
    <div class="steps">${STEPS.map((_, i) => `<span class="${i <= idx ? 'on' : ''}"></span>`).join('')}</div>`;
}

function nextButton(label = 'Dalej', disabled = false) {
  return `<div class="spacer"></div>
    <div class="actions"><button class="btn btn-primary" data-act="next" ${disabled ? 'disabled' : ''}>${esc(label)}</button></div>`;
}

function viewClasses() {
  syncGaps();
  const n = config.classes.length;
  const rows = config.classes.map((cls, i) => {
    const options = CLASSES.map((c) => {
      const used = c !== cls && config.classes.includes(c);
      return `<option value="${esc(c)}" ${c === cls ? 'selected' : ''} ${used ? 'disabled' : ''}>${esc(c)}</option>`;
    }).join('');
    const gap = (!config.noOffset && i < n - 1)
      ? `<div class="gap-row"><span>Start ${esc(cls)} → ostrzeżenie ${esc(config.classes[i + 1])}</span>${timeInput('gap:' + i, config.gaps[i])}</div>`
      : '';
    return `
      <div class="class-row">
        <span class="num">${i + 1}</span>
        <select data-idx="${i}" aria-label="Klasa ${i + 1}">${options}</select>
        <button class="icon-btn" data-act="up" data-idx="${i}" ${i === 0 ? 'disabled' : ''} aria-label="W górę">↑</button>
        <button class="icon-btn" data-act="down" data-idx="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="W dół">↓</button>
        <button class="icon-btn" data-act="remove" data-idx="${i}" ${n === 1 ? 'disabled' : ''} aria-label="Usuń">✕</button>
      </div>${gap}`;
  }).join('');

  return `
    ${header('Klasy')}
    <h1>Wybierz startujące klasy i ich kolejność</h1>
    <p class="lead">Klasy startują w kolejności z listy.</p>
    <div class="card">${rows}</div>
    <button class="add-btn" data-act="add" ${n >= CLASSES.length ? 'disabled' : ''}>+ Dodaj klasę</button>
    <label class="check"><input type="checkbox" data-field="noOffset" ${config.noOffset ? 'checked' : ''}>Brak offsetu pomiędzy klasami</label>
    ${!config.noOffset && n > 1 ? '<p class="lead">Odstęp liczony od startu jednej klasy do sygnału ostrzeżenia następnej.</p>' : ''}
    ${nextButton()}`;
}

function viewSequence() {
  const err = sequenceError(config);
  const presetOpts = Object.entries(PRESETS)
    .map(([id, p]) => `<option value="${id}" ${id === config.preset ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `
    ${header('Sekwencja')}
    <h1>Czasy sekwencji</h1>
    <p class="lead">Czas przed startem dla każdego sygnału. Domyślnie schemat dla regat floty.</p>
    <div class="card">
      <span class="field-label">Schemat</span>
      <div class="class-row"><select data-field="preset">${presetOpts}</select></div>
    </div>
    <div class="card">
      <div class="seq-row"><div><b>Ostrzeżenie</b><small>flaga klasy ↑ · 1 dźwięk</small></div>${timeInput('warning', config.warning)}</div>
      <div class="seq-row"><div><b>Przygotowanie</b><small>flaga przygotowania ↑ · 1 dźwięk</small></div>${timeInput('prep', config.prep)}</div>
      <div class="seq-row"><div><b>Jedna minuta</b><small>flaga przygotowania ↓ · 1 długi dźwięk</small></div>${timeInput('oneMin', config.oneMin)}</div>
      <div class="seq-row"><div><b>Start</b><small>flaga klasy ↓ · 1 dźwięk</small></div><span class="fixed">0:00</span></div>
    </div>
    <button class="add-btn" data-act="resetSeq">Przywróć domyślne</button>
    <p class="error" id="seq-error">${err ? esc(err) : ''}</p>
    ${nextButton('Dalej', !!err)}`;
}

function flagChips(selected, target) {
  return `<div class="chips">${PREP_FLAGS.map((f) =>
    `<button class="chip ${f.id === selected ? 'on' : ''}" data-act="flag" data-target="${esc(target)}" data-flag="${f.id}">${esc(f.label)}</button>`).join('')}</div>`;
}

function viewFlags() {
  const perClass = config.sameFlag ? '' : `
    <div class="card">${config.classes.map((cls) => `
      <div class="flag-class"><b>${esc(cls)}</b>${flagChips(flagFor(config, cls), cls)}</div>`).join('')}
    </div>`;
  return `
    ${header('Flaga przygotowania')}
    <h1>Sygnał przygotowania</h1>
    <p class="lead">Rodzaj flagi określa zasady falstartu.</p>
    ${config.sameFlag ? `<div class="card">${flagChips(config.flag, '*')}</div>` : ''}
    <label class="check"><input type="checkbox" data-field="sameFlag" ${config.sameFlag ? 'checked' : ''}>Ten sam dla wszystkich</label>
    ${perClass}
    ${nextButton()}`;
}

function viewOrange() {
  return `
    ${header('Flaga pomarańczowa')}
    <h1>Flaga pomarańczowa</h1>
    <p class="lead">Czas od wystawienia flagi pomarańczowej do rozpoczęcia procedury startowej (sygnału ostrzeżenia pierwszej klasy).</p>
    <div class="card"><div class="seq-row"><div><b>Pomarańczowa → ostrzeżenie</b><small>flaga pomarańczowa ↑ · 1 dźwięk</small></div>${timeInput('orangeTime', config.orangeTime)}</div></div>
    ${nextButton()}`;
}

function viewReady() {
  const plan = buildPlan(config, config.startWithOrange);
  const rows = plan.starts.map((s) =>
    `<div class="summary-row"><span>Start ${esc(s.cls)} · flaga ${esc(PREP_FLAGS.find((f) => f.id === flagFor(config, s.cls)).label)}</span><span>@ ${fmt(s.t)}</span></div>`).join('');
  return `
    ${header('Gotowe')}
    <div class="card first-class"><small>Pierwsza klasa</small><strong>${esc(config.classes[0])}</strong></div>
    <label class="check"><input type="checkbox" data-field="startWithOrange" ${config.startWithOrange ? 'checked' : ''}>Zacznij od flagi pomarańczowej (${fmt(config.orangeTime)})</label>
    <div class="card">${rows}</div>
    <div class="spacer"></div>
    <div class="actions"><button class="btn btn-soft" data-act="testSound">${ICON.sound} Test dźwięku</button></div>
    <div class="actions"><button class="btn btn-primary btn-big" data-act="start">${ICON.play} Start</button></div>`;
}

/* ================= Widok timera ================= */

const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;

function viewRun() {
  return `
    <div class="topbar">
      <button class="round-btn" data-act="stop" aria-label="Zatrzymaj">${ICON.close}</button>
      <h2 id="run-title"></h2><span></span>
    </div>
    <div class="run" id="run">
      <div class="ring-wrap">
        <svg viewBox="0 0 100 100">
          <circle class="ring-track" cx="50" cy="50" r="${RING_R}" fill="none" stroke-width="3.2"/>
          <circle class="ring-bar" id="ring" cx="50" cy="50" r="${RING_R}" fill="none" stroke-width="3.2" stroke-linecap="round"
            stroke-dasharray="${RING_C}" stroke-dashoffset="0"/>
        </svg>
        <div class="ring-center">
          <div class="big" id="big">0:00</div>
          <div class="total" id="total"></div>
        </div>
      </div>
      <div class="flash" id="flash"></div>
      <div class="next-info">
        <small id="next-kicker">do:</small>
        <h3 id="next-title"></h3>
        <p id="next-note"></p>
      </div>
      <div class="timeline" id="timeline">${run.plan.raw.map((e, i) =>
        `<div class="tl-item" data-i="${i}"><b>${esc(e.kind)}</b>${esc(e.cls || 'linia')}<br>@ ${fmt(e.t)}</div>`).join('')}
      </div>
    </div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="btn btn-soft" data-act="stop">${ICON.stop} Stop</button>
      <button class="btn btn-primary" data-act="mute" id="mute-btn"></button>
    </div>
    <div class="sound-overlay" id="sound-overlay" hidden>
      <button class="btn btn-primary btn-big" data-act="unlockSound">${ICON.sound} Dotknij, aby włączyć dźwięk</button>
    </div>`;
}

let lastActiveRaw = -1;
let flashTimer = null;

function updateRun() {
  if (!run) return;
  const el = (Date.now() - run.startEpoch) / 1000;
  const { events, starts, raw } = run.plan;
  const $ = (id) => document.getElementById(id);
  if (!$('big')) return;

  const idx = events.findIndex((e) => e.t > el);
  const next = events[idx];
  const prevT = idx > 0 ? events[idx - 1].t : 0;
  const nextStart = starts.find((s) => s.t > el);
  const lastStart = starts[starts.length - 1];

  if (next) {
    const rem = Math.ceil(next.t - el - 1e-6);
    $('big').textContent = fmt(rem);
    $('next-kicker').textContent = 'do:';
    $('next-title').textContent = next.title;
    $('next-note').textContent = next.note;
    const span = Math.max(1, next.t - prevT);
    const frac = Math.min(1, Math.max(0, (next.t - el) / span));
    $('ring').style.strokeDashoffset = String(RING_C * (1 - frac));
    $('run').classList.toggle('urgent', rem <= 10);
  } else {
    $('big').textContent = '+' + fmt(Math.floor(el - lastStart.t));
    $('next-kicker').textContent = 'od startu ' + lastStart.cls;
    $('next-title').textContent = 'Wszystkie klasy wystartowały';
    $('next-note').textContent = '';
    $('ring').style.strokeDashoffset = '0';
    $('run').classList.remove('urgent');
  }

  $('total').innerHTML = nextStart
    ? `do startu ${esc(nextStart.cls)}<b>${fmt(Math.ceil(nextStart.t - el - 1e-6))}</b>`
    : '';
  $('run-title').textContent = nextStart
    ? `${nextStart.cls} · ${starts.indexOf(nextStart) + 1}/${starts.length}`
    : 'Po starcie';

  // Oś zdarzeń: następne zdarzenie podświetlone.
  const activeRaw = raw.findIndex((e) => e.t > el);
  if (activeRaw !== lastActiveRaw) {
    document.querySelectorAll('.tl-item').forEach((node, i) => {
      node.classList.toggle('done', activeRaw === -1 || i < activeRaw);
      node.classList.toggle('active', i === activeRaw);
    });
    const act = document.querySelector('.tl-item.active');
    if (act) act.scrollIntoView({ behavior: lastActiveRaw === -1 ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });

    // Krótki komunikat o zdarzeniu, które właśnie nastąpiło.
    const justIdx = idx === -1 ? events.length - 1 : idx - 1;
    if (lastActiveRaw !== -1 && justIdx >= 0 && el - events[justIdx].t < 3) {
      const flash = $('flash');
      flash.textContent = '▶ ' + events[justIdx].title;
      flash.classList.remove('show');
      void flash.offsetWidth;
      flash.classList.add('show');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove('show'), 4000);
    }
    lastActiveRaw = activeRaw;
  }

  const muteBtn = $('mute-btn');
  muteBtn.innerHTML = muted ? `${ICON.mute} Wyciszony` : `${ICON.sound} Dźwięk`;
  // Pokazuj prośbę o dotknięcie dopiero, gdy dźwięk nie ruszył po ~1 s (np. po przeładowaniu).
  const soundOk = !!audio && audio.state === 'running';
  $('sound-overlay').hidden = muted || soundOk || Date.now() - audioUnlockAt < 1000;
}

/* ================= Silnik timera ================= */

const LOOKAHEAD_MS = 1500;
let loopId = null;

function scheduleBeeps() {
  if (!run) return;
  const el = Date.now() - run.startEpoch;
  while (run.beepIdx < run.beeps.length && run.beeps[run.beepIdx].at <= el + LOOKAHEAD_MS) {
    const b = run.beeps[run.beepIdx++];
    const delay = (b.at - el) / 1000;
    if (delay < -0.3) continue; // przegapione (np. aplikacja była w tle)
    if (audio && audio.state === 'running') playBeep(b.kind, audio.currentTime + Math.max(0, delay));
  }
}

function startLoop() {
  stopLoop();
  const tick = () => { scheduleBeeps(); updateRun(); };
  tick();
  loopId = setInterval(tick, 100);
}
function stopLoop() {
  if (loopId) clearInterval(loopId);
  loopId = null;
}

function beginRun(startEpoch, cfg, withOrange) {
  const plan = buildPlan(cfg, withOrange);
  const beeps = buildBeeps(plan.events);
  const el = Date.now() - startEpoch;
  run = {
    startEpoch, cfg, withOrange, plan, beeps,
    beepIdx: Math.max(0, beeps.findIndex((b) => b.at >= el - 300)),
  };
  if (beeps.every((b) => b.at < el - 300)) run.beepIdx = beeps.length;
  lastActiveRaw = -1;
  view = 'run';
  render();
  requestWakeLock();
  startLoop();
}

function startRun() {
  ensureAudio();
  const startEpoch = Date.now();
  const cfg = structuredClone(config);
  store(RUN_KEY, { startEpoch, cfg, withOrange: cfg.startWithOrange });
  beginRun(startEpoch, cfg, cfg.startWithOrange);
}

function stopRun() {
  if (!confirm('Zatrzymać odliczanie?')) return;
  stopLoop();
  run = null;
  store(RUN_KEY, null);
  releaseWakeLock();
  view = 'ready';
  render();
}

// Wznowienie po przeładowaniu / zamknięciu aplikacji w trakcie sekwencji.
function resumeRun() {
  const saved = load(RUN_KEY);
  if (!saved || !saved.cfg) return false;
  const plan = buildPlan(saved.cfg, saved.withOrange);
  const lastStart = plan.starts[plan.starts.length - 1].t;
  if ((Date.now() - saved.startEpoch) / 1000 > lastStart + 3600) {
    store(RUN_KEY, null);
    return false;
  }
  beginRun(saved.startEpoch, saved.cfg, saved.withOrange);
  return true;
}

/* ================= Render i zdarzenia ================= */

function render() {
  const views = { classes: viewClasses, sequence: viewSequence, flags: viewFlags, orange: viewOrange, ready: viewReady, run: viewRun };
  app.innerHTML = views[view]();
  if (view === 'run') updateRun();
  window.scrollTo(0, 0);
}

function go(delta) {
  const i = STEPS.indexOf(view) + delta;
  if (i >= 0 && i < STEPS.length) { view = STEPS[i]; render(); }
}

app.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const i = Number(btn.dataset.idx);
  const c = config.classes;
  switch (btn.dataset.act) {
    case 'next': go(1); break;
    case 'back': go(-1); break;
    case 'add': {
      const free = CLASSES.find((x) => !c.includes(x));
      if (free) c.push(free);
      break;
    }
    case 'remove': {
      const [removed] = c.splice(i, 1);
      config.gaps.splice(Math.min(i, config.gaps.length - 1), 1);
      delete config.classFlags[removed];
      break;
    }
    case 'up': [c[i - 1], c[i]] = [c[i], c[i - 1]]; break;
    case 'down': [c[i + 1], c[i]] = [c[i], c[i + 1]]; break;
    case 'resetSeq': {
      const { warning, prep, oneMin } = PRESETS[config.preset];
      Object.assign(config, { warning, prep, oneMin });
      break;
    }
    case 'flag':
      if (btn.dataset.target === '*') config.flag = btn.dataset.flag;
      else config.classFlags[btn.dataset.target] = btn.dataset.flag;
      break;
    case 'testSound': testSound(); return;
    case 'start': startRun(); return;
    case 'stop': stopRun(); return;
    case 'mute': muted = !muted; if (!muted) ensureAudio(); updateRun(); return;
    case 'unlockSound': ensureAudio(); setTimeout(updateRun, 50); return;
    default: return;
  }
  syncGaps();
  saveConfig();
  render();
});

app.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.matches('select[data-idx]')) {
    config.classes[Number(el.dataset.idx)] = el.value;
  } else if (el.dataset.field === 'preset') {
    config.preset = el.value;
    const { warning, prep, oneMin } = PRESETS[el.value];
    Object.assign(config, { warning, prep, oneMin });
  } else if (el.type === 'checkbox' && el.dataset.field) {
    config[el.dataset.field] = el.checked;
    if (el.dataset.field === 'sameFlag' && !el.checked) {
      config.classes.forEach((cls) => { config.classFlags[cls] = config.classFlags[cls] || config.flag; });
    }
  } else if (el.closest('.time')) {
    render(); // normalizuje wpisany czas (np. 75 s → 1:15)
    return;
  } else {
    return;
  }
  syncGaps();
  saveConfig();
  render();
});

app.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.closest('.time')) return;
  el.value = el.value.replace(/\D/g, '').slice(0, 2);
  const { key, secs } = readTimeInput(el);
  if (key.startsWith('gap:')) config.gaps[Number(key.slice(4))] = secs;
  else config[key] = secs;
  saveConfig();

  if (view === 'sequence') {
    const err = sequenceError(config);
    document.getElementById('seq-error').textContent = err || '';
    document.querySelector('[data-act="next"]').disabled = !!err;
  }
});

app.addEventListener('focusin', (ev) => {
  if (ev.target.matches('.time input')) ev.target.select();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !run) return;
  requestWakeLock();
  if (audio && audio.state !== 'running') audio.resume().catch(() => {});
  updateRun();
});

/* ================= Start aplikacji ================= */

syncGaps();
if (!resumeRun()) render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
