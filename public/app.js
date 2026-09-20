const $ = (id) => document.getElementById(id);
let status = {};
let currentRunId = null;
let currentParsed = null;
let pinned = false;
let snapping = false;

// Whether the screenshots section is collapsed. Persisted so the choice
// survives the re-render that happens on every capture cycle.
const COLLAPSE_KEY = 'shotsCollapsed';
const ANALYSIS_COLLAPSE_KEY = 'analysisCollapsed';
const THEME_KEY = 'theme';
const RING_LEN = 2 * Math.PI * 19;

let shotsCollapsed = localStorage.getItem(COLLAPSE_KEY) === 'true';
let analysisCollapsed = localStorage.getItem(ANALYSIS_COLLAPSE_KEY) === 'true';

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- theme ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $('themeBtn').title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

/* ---------- toasts ---------- */
function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function setList(el, items, empty = '—') {
  el.innerHTML = '';
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) {
    const li = document.createElement('li');
    li.textContent = empty;
    li.style.color = 'var(--muted)';
    el.appendChild(li);
    return;
  }
  arr.forEach((v) => {
    const li = document.createElement('li');
    li.textContent = v;
    el.appendChild(li);
  });
}

function applyShotsCollapsed() {
  $('shotsPanel').classList.toggle('collapsed', shotsCollapsed);
  const caret = $('shotsCaret');
  caret.setAttribute('aria-expanded', String(!shotsCollapsed));
  caret.title = shotsCollapsed ? 'Expand' : 'Collapse';
}

function applyAnalysisCollapsed() {
  $('analysisPanel').classList.toggle('collapsed', analysisCollapsed);
  const caret = $('analysisCaret');
  caret.setAttribute('aria-expanded', String(!analysisCollapsed));
  caret.title = analysisCollapsed ? 'Expand' : 'Collapse';
}

// One-line digest shown in the panel head while the snapshot is collapsed.
function setHeadSum(action, spot, conviction) {
  const el = $('headSum');
  el.innerHTML = '';
  const chip = (text, cls) => {
    const i = document.createElement('i');
    if (cls) i.className = cls;
    i.textContent = text;
    el.appendChild(i);
  };
  if (action) chip(action.text, action.kind);
  if (spot && spot !== '—') chip(spot);
  if (Number.isFinite(conviction)) chip(`${conviction}% conviction`);
}

function renderShots(run) {
  const wrap = $('shots');
  wrap.innerHTML = '';
  const shots = run.shots || [];
  $('shotsMeta').textContent = shots.length
    ? shots.map((s) => `${s.label}${s.awaitingLogin ? ' (login needed)' : ''}`).join(' · ')
    : '';

  if (!shots.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No screenshots yet — run a capture to see the charts here.';
    empty.style.flex = '1';
    wrap.appendChild(empty);
    return;
  }

  shots.forEach((s) => {
    const card = document.createElement('article');
    card.className = 'shot';

    const head = document.createElement('header');

    const left = document.createElement('div');
    left.className = 'shot-title';
    const h3 = document.createElement('h3');
    h3.textContent = s.label;
    left.appendChild(h3);
    head.appendChild(left);

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    if (s.awaitingLogin) {
      const b = document.createElement('span');
      b.className = 'badge warn';
      b.textContent = 'login needed';
      right.appendChild(b);
    }
    const rl = document.createElement('button');
    rl.className = 'btn';
    rl.style.padding = '5px 10px';
    rl.textContent = 'Reload';
    rl.onclick = async () => {
      rl.disabled = true;
      try {
        await fetch(`/api/reload/${s.id}`, { method: 'POST' });
        toast(`Reloading ${s.label}`);
      } finally {
        rl.disabled = false;
      }
    };
    right.appendChild(rl);
    head.appendChild(right);
    card.appendChild(head);

    if (s.ok && s.shotUrl) {
      const img = document.createElement('img');
      img.src = s.shotUrl;
      img.alt = s.label;
      img.loading = 'lazy';
      img.onclick = () => lightbox(s.shotUrl);
      card.appendChild(img);
    } else {
      const err = document.createElement('div');
      err.className = 'err';
      err.textContent = s.error || 'capture failed';
      card.appendChild(err);
    }
    if (s.notes && s.notes.length) {
      const n = document.createElement('div');
      n.className = 'notes';
      n.textContent = s.notes.join(' · ');
      card.appendChild(n);
    }
    wrap.appendChild(card);
  });
}

function lightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  box.appendChild(img);
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}

const ACTION_WORDS = {
  long: 'Go long',
  short: 'Go short',
  wait: 'Wait',
  exit: 'Exit',
  avoid: 'Stand aside',
};

const num = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const signed = (n) => `${n > 0 ? '+' : ''}${num(n)}`;
const dirOf = (n) => (n === null || n === undefined ? 'flat' : n > 0.5 ? 'up' : n < -0.5 ? 'down' : 'flat');

/* ---------- session-memory sparkline ---------- */
function drawSpark(series) {
  const wrap = $('sparkWrap');
  const line = $('sparkLine');
  const area = $('sparkArea');
  const pts = (series || []).filter((p) => Number.isFinite(p.spot));

  if (pts.length < 2) {
    line.setAttribute('d', '');
    area.setAttribute('d', '');
    $('sparkHi').textContent = '';
    $('sparkLo').textContent = pts.length ? '' : 'not enough readings yet';
    $('sparkLo').style.right = pts.length ? '0' : 'auto';
    wrap.className = 'spark';
    return;
  }

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const ys = pts.map((p) => p.spot);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const X = (t) => (t1 === t0 ? 100 : ((t - t0) / (t1 - t0)) * 100);
  const Y = (v) => 32 - ((v - lo) / span) * 29;

  const coords = pts.map((p) => `${X(p.t).toFixed(2)},${Y(p.spot).toFixed(2)}`);
  line.setAttribute('d', `M${coords.join(' L')}`);
  area.setAttribute('d', `M${coords.join(' L')} L${X(t1).toFixed(2)},34 L${X(t0).toFixed(2)},34 Z`);
  $('sparkHi').textContent = num(hi);
  $('sparkLo').textContent = num(lo);
  $('sparkLo').style.right = '0';
  wrap.className = `spark ${dirOf(ys[ys.length - 1] - ys[0])}`;
}

/* ---------- 1 / 5 / 10 / 15 / 30 min + whole day strip ---------- */
function renderTrend(trend, parsed) {
  const strip = $('tfStrip');
  strip.innerHTML = '';
  const t = trend || { order: [], windows: {}, series: [], samples: 0 };
  const notes = parsed?.history_read || {};

  $('memMeta').textContent = t.samples
    ? `${t.samples} reading${t.samples === 1 ? '' : 's'} today${t.at ? ` · as of ${fmtTime(t.at)}` : ''}`
    : 'no earlier readings today';

  drawSpark(t.series);

  (t.order || []).forEach((key) => {
    const w = t.windows[key];
    if (!w) return;
    const el = document.createElement('div');
    const dir = w.samples ? w.direction || dirOf(w.change) : '';
    el.className = `tf ${w.samples ? dir : 'empty-tf'}`;

    const label = document.createElement('span');
    label.className = 'tf-label';
    label.textContent = w.label;
    el.appendChild(label);

    const chg = document.createElement('b');
    chg.className = 'tf-chg';
    chg.textContent = w.change === null || w.change === undefined ? (w.samples ? '—' : 'no data') : signed(w.change);
    el.appendChild(chg);

    const sub = document.createElement('span');
    sub.className = 'tf-sub';
    sub.textContent =
      w.from !== null && w.to !== null
        ? `${num(w.from)} → ${num(w.to)}${w.changePct ? ` · ${signed(w.changePct)}%` : ''}`
        : `${w.samples} reading${w.samples === 1 ? '' : 's'}`;
    el.appendChild(sub);

    const bias = document.createElement('span');
    bias.className = `tf-bias ${w.dominantBias || 'unclear'}`;
    const counts = Object.entries(w.biasCounts || {});
    bias.textContent = counts.length
      ? counts.map(([b, c]) => `${b} ×${c}`).join(' · ')
      : w.samples
        ? `${w.samples} reading${w.samples === 1 ? '' : 's'}`
        : 'no readings';
    el.appendChild(bias);

    if (notes[key]) {
      const note = document.createElement('p');
      note.className = 'tf-note';
      note.textContent = notes[key];
      el.appendChild(note);
    }
    strip.appendChild(el);
  });

  if (!strip.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.gridColumn = '1 / -1';
    empty.textContent = 'Session memory builds up as runs complete.';
    strip.appendChild(empty);
  }
}

function setMeter(fillId, textId, value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  $(fillId).style.width = `${v}%`;
  $(textId).textContent = v;
}

function renderAnalysis(run) {
  const a = run.analysis || {};
  const p = a.parsed;
  const trend = run.trend || null;

  $('runMeta').textContent = `${fmtTime(run.startedAt)} · capture+analysis ${(run.durationMs / 1000).toFixed(1)}s${
    a.durationMs ? ` (model ${(a.durationMs / 1000).toFixed(1)}s)` : ''
  }${run.manual ? ' · manual' : ''}`;
  // Reasoning models stream a thinking trace; keep it with the raw JSON for later review.
  $('rawOut').textContent = [
    a.thinking ? `----- model thinking -----\n${a.thinking}\n\n----- model output -----` : '',
    a.raw || a.error || '(no output)',
  ]
    .filter(Boolean)
    .join('\n');

  // Day move, computed from the stored readings rather than the model's own arithmetic.
  const day = trend?.windows?.day;
  const dayChange = day?.change ?? null;
  const delta = $('spotDelta');
  if (dayChange === null) {
    delta.textContent = '';
    delta.className = 'delta';
  } else {
    delta.textContent = `${signed(dayChange)}${day.changePct !== null ? ` (${signed(day.changePct)}%)` : ''} today`;
    delta.className = `delta ${dirOf(dayChange)}`;
  }
  $('dayRange').textContent = day && day.low !== null && day.high !== null ? `${num(day.low)} – ${num(day.high)}` : '—';

  if (!p) {
    const skipped = a.skipped;
    currentParsed = null;
  $('callBox').className = 'call avoid';
    $('actionText').textContent = skipped ? 'Login' : a.ok ? 'Unparsed' : 'Error';
    $('actionLine').textContent = a.error || 'Model did not return structured output — see raw output below.';
    $('biasText').className = 'biasLabel unclear';
    $('biasText').textContent = skipped ? 'login' : 'unclear';
    setMeter('convFill', 'convText', 0);
    setMeter('confFill', 'confText', 0);
    ['spotText', 'momentumText', 'keyLevel', 'rangeText', 'entryZone', 'stopLoss', 'targetLvl', 'invalidation',
      'combinedView', 'priceAction', 'oiRead', 'callOi', 'putOi'].forEach((id) => { $(id).textContent = '—'; });
    $('spotNote').textContent = '';
    $('trendVsNow').textContent = '—';
    setHeadSum({ text: skipped ? 'Login' : a.ok ? 'Unparsed' : 'Error', kind: 'avoid' }, '', null);
    setList($('supports'), []);
    setList($('resistances'), []);
    setList($('watchFor'), []);
    setList($('risks'), []);
    renderTrend(trend, null);
    return;
  }

  const action = (p.action || 'wait').toLowerCase();
  $('callBox').className = `call ${action}`;
  $('actionText').textContent = ACTION_WORDS[action] || action;
  $('actionLine').textContent = p.action_line || p.combined_view || '—';

  const bias = (p.bias || 'unclear').toLowerCase();
  $('biasText').className = `biasLabel ${bias}`;
  $('biasText').textContent = bias;

  setMeter('convFill', 'convText', p.conviction ?? p.confidence);
  setMeter('confFill', 'confText', p.confidence);

  // "24,310 (last candle close)" -> big number + a small qualifier, so the hero never wraps.
  const spotRaw = p.spot_estimate || '';
  const spotSplit = spotRaw.match(/^([^(]+?)\s*[(\u2014-]\s*(.+?)\)?$/);
  $('spotText').textContent = (spotSplit ? spotSplit[1] : spotRaw).trim() || '—';
  $('spotText').title = spotRaw;
  const check = a.spotCheck;
  if (check?.corrected) {
    $('spotNote').textContent = `live ${String(check.source).toUpperCase()} feed · chart misread as ${
      check.model === null ? 'n/a' : num(check.model)
    }`;
    $('spotNote').title = `The model read ${check.model === null ? 'no level' : num(check.model)} off the chart; the live feed said ${num(
      check.live,
    )}. The live number was used.`;
  } else if (check) {
    $('spotNote').textContent = `verified vs live ${String(check.source).toUpperCase()} feed`;
    $('spotNote').title = `Model read ${num(check.model)}, live feed ${num(check.live)} — within the ${check.tolerance} pt tolerance.`;
  } else {
    $('spotNote').textContent = spotSplit ? spotSplit[2].trim() : '';
    $('spotNote').title = '';
  }
  const convVal = Number(p.conviction ?? p.confidence);
  setHeadSum(
    { text: ACTION_WORDS[action] || action, kind: action },
    $('spotText').textContent,
    Number.isFinite(convVal) ? Math.round(convVal) : null,
  );
  $('momentumText').textContent = p.momentum || '—';
  $('keyLevel').textContent = p.key_level || '—';
  $('rangeText').textContent = p.expected_range || '—';
  $('entryZone').textContent = p.entry_zone || '—';
  $('stopLoss').textContent = p.stop_loss || '—';
  $('targetLvl').textContent = p.target || '—';
  $('invalidation').textContent = p.invalidation || '—';
  $('trendVsNow').textContent = p.trend_vs_now || '—';

  $('combinedView').textContent = p.combined_view || '—';
  $('priceAction').textContent = [p.price_action, p.timeframe_seen ? `(${p.timeframe_seen})` : '']
    .filter(Boolean)
    .join(' ');
  $('oiRead').textContent = p.oi_read || '—';
  $('callOi').textContent = p.highest_call_oi_strike || '—';
  $('putOi').textContent = p.highest_put_oi_strike || '—';
  setList($('supports'), p.supports);
  setList($('resistances'), p.resistances);
  setList($('watchFor'), p.watch_for);
  setList($('risks'), p.risks);

  currentParsed = p;
  renderTrend(trend, p);
}

/**
 * The 1/5/10/15/30-minute windows slide even when no new run has landed, so re-pull the
 * server-computed memory periodically. The model's per-window notes stay as they were.
 */
async function refreshTrend() {
  if (pinned) return;
  try {
    renderTrend(await (await fetch('/api/trend')).json(), currentParsed);
  } catch {
    /* server offline — the pill already says so */
  }
}

function resetView() {
  currentRunId = null;
  currentParsed = null;
  pinned = false;
  renderShots({ shots: [] });
  $('shotsMeta').textContent = '';
  $('runMeta').textContent = 'waiting for first run…';
  $('rawOut').textContent = '';
  $('callBox').className = 'call';
  $('actionText').textContent = '—';
  $('actionLine').textContent = 'Waiting for the first analysis…';
  $('biasText').className = 'biasLabel unclear';
  $('spotDelta').textContent = '';
  setMeter('convFill', 'convText', 0);
  setMeter('confFill', 'confText', 0);
  ['biasText', 'spotText', 'momentumText', 'keyLevel', 'rangeText', 'dayRange', 'entryZone', 'stopLoss',
    'targetLvl', 'invalidation', 'combinedView', 'priceAction', 'oiRead', 'callOi', 'putOi',
    'trendVsNow'].forEach((id) => { $(id).textContent = '—'; });
  $('spotNote').textContent = '';
  setHeadSum(null, '', null);
  ['supports', 'resistances', 'watchFor', 'risks'].forEach((id) => setList($(id), []));
  renderTrend(null, null);
}

function showRun(run) {
  if (!run) return;
  currentRunId = run.id;
  renderShots(run);
  renderAnalysis(run);
  document.querySelectorAll('.hrow').forEach((r) => r.classList.toggle('active', r.dataset.id === run.id));
}

async function loadHistory() {
  const runs = await (await fetch('/api/history?limit=60')).json();
  const el = $('history');
  el.innerHTML = '';
  $('histCount').textContent = runs.length ? `${runs.length} run(s)` : '';

  if (!runs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No runs stored yet.';
    el.appendChild(empty);
    return;
  }

  runs.forEach((r) => {
    const p = r.analysis?.parsed;
    const bias = (p?.bias || (r.analysis?.skipped ? 'login' : r.analysis?.ok ? 'unclear' : 'failed')).toLowerCase();
    const action = (p?.action || 'none').toLowerCase();
    const move = r.trend?.windows?.last_5m?.change ?? null;
    const spot = Number.isFinite(r.quote?.spot) ? r.quote.spot : null;

    const row = document.createElement('div');
    row.className = 'hrow';
    row.dataset.id = r.id;
    row.title = 'Show this run';
    if (r.id === currentRunId) row.classList.add('active');
    row.innerHTML =
      `<span class="t">${fmtTime(r.startedAt)}</span>` +
      `<span class="p"></span>` +
      `<span class="a ${action}"></span>` +
      `<span class="b ${bias}">${bias}</span>` +
      `<span class="m ${dirOf(move)}"></span>` +
      `<span class="s"></span>`;
    row.querySelector('.p').textContent = spot === null ? '—' : Math.round(spot).toLocaleString('en-IN');
    row.querySelector('.a').textContent = action === 'none' ? '—' : action;
    row.querySelector('.m').textContent = move === null ? '—' : `${signed(move)} /5m`;
    row.querySelector('.s').textContent = p?.action_line || p?.combined_view || r.analysis?.error || '—';
    row.onclick = async () => {
      pinned = true;
      const full = await (await fetch(`/api/run/${r.id}`)).json();
      showRun(full);
    };
    el.appendChild(row);
  });
}

/* ---------- interval dropdown ---------- */
let intervalOptsKey = '';

const fmtMins = (m) => (m === 1 ? '1 min' : Number.isInteger(m) ? `${m} mins` : `${m} mins`);

function syncIntervalSelect(s) {
  const sel = $('intervalSel');
  const current = Math.round(((s.intervalMs || 60000) / 60000) * 100) / 100;
  const opts = [...(s.intervalOptions || [1, 2, 5, 10, 15])];
  // Keep an out-of-list interval (e.g. one set via INTERVAL_SECONDS) visible rather than lying.
  if (!opts.includes(current)) opts.push(current);
  opts.sort((a, b) => a - b);

  const key = opts.join(',');
  if (key !== intervalOptsKey) {
    intervalOptsKey = key;
    sel.innerHTML = '';
    opts.forEach((m) => {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = `Every ${fmtMins(m)}`;
      sel.appendChild(o);
    });
  }
  // Don't fight the user while the dropdown is open.
  if (document.activeElement !== sel) sel.value = String(current);
}

const fmtClock = (ms) =>
  new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Live NIFTY spot pill — the ground-truth number the model is checked against. */
function renderQuotePill(q) {
  const pill = $('quotePill');
  const text = $('quoteText');
  if (!q || !q.ok) {
    pill.className = 'pill bad';
    text.textContent = 'no live quote';
    pill.title = q?.error ? `Live quote unavailable — ${q.error}` : 'Live quote unavailable';
    return;
  }
  pill.className = `pill ${q.stale ? 'warn' : 'ok'}`;
  const chg = q.change === null || q.change === undefined ? '' : ` ${signed(q.change)}`;
  text.textContent = `NIFTY ${num(q.spot)}${chg}`;
  pill.title = `Live NIFTY 50 spot ${num(q.spot)} from the ${String(q.source).toUpperCase()} quote API${
    q.fetchedAt ? ` at ${fmtTime(q.fetchedAt)}` : ''
  }${q.stale ? ' (stale — providers are failing)' : ''}. This is what the model's chart reading is checked against.`;
}

function applyStatus(s) {
  status = s;
  $('modelName').textContent = s.model || 'gemma';
  syncIntervalSelect(s);

  const market = s.market || { open: s.marketOpen };
  // SSE status events don't carry the quote; only refresh the pill when one is present.
  if (s.quote) renderQuotePill(s.quote);
  const marketPill = $('marketPill');
  marketPill.className = `pill ${market.open ? 'ok' : 'bad'}`;
  $('marketText').textContent = market.open
    ? `market open · till ${market.closesAt || '15:15'}`
    : 'market closed';
  marketPill.title = market.open
    ? `NSE session ${market.opensAt}–${market.closesAt} IST — captures run only in this window`
    : `Captures are paused outside ${market.opensAt || '09:15'}–${market.closesAt || '15:15'} IST${
        market.nextOpenAt ? `. Next open: ${fmtClock(market.nextOpenAt)}` : ''
      }`;

  const phasePill = $('phasePill');
  const label = s.paused
    ? 'paused'
    : s.waitingForMarket
      ? 'waiting for open'
      : s.phase === 'capturing'
        ? 'capturing…'
        : s.phase === 'analysing'
          ? 'analysing…'
          : 'live';
  $('phaseText').textContent = label;
  phasePill.className = `pill ${s.paused || s.waitingForMarket ? 'bad' : s.phase === 'idle' ? 'ok' : 'busy'}`;
  $('pauseLabel').textContent = s.paused ? 'Resume' : 'Pause';
  $('pauseBtn').classList.toggle('is-paused', !!s.paused);
  $('pauseBtn').title = s.paused ? 'Resume the schedule' : 'Pause the schedule';
  $('runNow').disabled = !!s.running;
  $('runNow').title = market.open
    ? 'Capture and analyse right now'
    : 'Market is closed — this runs a one-off capture anyway';
  $('snapBtn').disabled = !!s.running || snapping;
}

function tickCountdown() {
  const el = $('countdown');
  const ring = $('ringFill');
  const setRing = (frac) => {
    ring.style.strokeDashoffset = String(RING_LEN * (1 - Math.max(0, Math.min(1, frac))));
  };

  if (status.paused) { el.textContent = '॥'; setRing(0); return; }
  if (status.running) { el.textContent = 'now'; setRing(1); return; }
  if (!status.nextRunAt) { el.textContent = '--:--'; setRing(0); return; }

  const left = Math.max(0, status.nextRunAt - Date.now());

  // Outside market hours the ring counts down to the next open in hours:minutes.
  if (status.waitingForMarket) {
    const h = Math.floor(left / 3600000);
    const mm = Math.floor((left % 3600000) / 60000);
    el.textContent = h > 0 ? `${h}h${String(mm).padStart(2, '0')}` : `${mm}m`;
    $('ringWrap').title = `Market closed — next open ${fmtClock(status.nextRunAt)}`;
    setRing(0);
    return;
  }

  $('ringWrap').title = 'Time until the next automatic run';
  const m = Math.floor(left / 60000);
  const sec = Math.floor((left % 60000) / 1000);
  el.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  setRing(left / (status.intervalMs || 60000));
}

/** Keep the always-visible browser toggle in sync with the real window state. */
function setWindowBtn(visible) {
  const btn = $('windowBtn');
  btn.dataset.visible = String(!!visible);
  $('windowLabel').textContent = visible ? 'Hide browser' : 'Show browser';
  btn.title = visible
    ? 'Tuck the capture browser window out of the way (shortcut: B)'
    : 'Bring the capture browser window back on screen (shortcut: B)';
}

async function pollOllama() {
  try {
    const s = await (await fetch('/api/status')).json();
    renderQuotePill(s.quote);
    const pill = $('ollamaPill');
    const gb = s.ollama?.loaded?.bytes ? (s.ollama.loaded.bytes / 1073741824).toFixed(1) : null;
    if (s.ollama?.ok && s.ollama.hasModel) {
      pill.className = 'pill ok';
      $('ollamaText').textContent = gb ? `ollama · ${gb}GB` : 'ollama · idle';
      pill.title = gb
        ? 'Model is resident in memory for fast analysis'
        : 'Model unloaded — memory released. It reloads automatically (~4s) on the next run.';
    } else if (s.ollama?.ok) {
      pill.className = 'pill bad';
      $('ollamaText').textContent = 'model missing';
    } else {
      pill.className = 'pill bad';
      $('ollamaText').textContent = 'ollama offline';
    }

    const wb = $('windowBtn');
    // Window control needs CDP + TUCK_WINDOW; hide the button outright when unavailable.
    wb.hidden = s.windowControl === false;
    if (!wb.hidden) setWindowBtn(s.windowVisible);
  } catch {
    $('ollamaPill').className = 'pill bad';
    $('ollamaText').textContent = 'server offline';
  }
}

/* ---------- live model stream ---------- */
// The analysis is streamed token by token so the wait shows the model actually working,
// rather than a spinner. Reasoning models also stream a `thinking` trace, which is shown
// in preference to the JSON being assembled.
const live = { runId: null, thinking: '', content: '', startedAt: 0, ticker: null };

const FIELD_LABELS = {
  readable: 'readability', action_line: 'the call', spot_estimate: 'spot', key_level: 'key level',
  entry_zone: 'entry zone', stop_loss: 'stop loss', price_action: 'price action', oi_read: 'open interest',
  highest_call_oi_strike: 'max call OI', highest_put_oi_strike: 'max put OI', expected_range: 'expected range',
  trend_vs_now: 'trend vs now', history_read: 'session memory', combined_view: 'combined view',
  watch_for: 'what to watch', last_1m: 'the 1-min window', last_5m: 'the 5-min window',
  last_10m: 'the 10-min window', last_15m: 'the 15-min window', last_30m: 'the 30-min window', day: 'today',
};

/** Name of the schema field the model is filling in right now, from the partial JSON. */
function currentField(json) {
  const keys = json.match(/"([a-z_0-9]+)"\s*:/gi);
  if (!keys || !keys.length) return '';
  const key = keys[keys.length - 1].replace(/["':\s]/g, '');
  return FIELD_LABELS[key] || key.replace(/_/g, ' ');
}

function liveTick() {
  if (!live.startedAt) return;
  const secs = ((Date.now() - live.startedAt) / 1000).toFixed(1);
  const chars = live.thinking.length + live.content.length;
  $('liveStats').textContent = `${secs}s · ${chars.toLocaleString()} chars`;
}

function liveStart(e) {
  live.runId = e.runId;
  live.thinking = '';
  live.content = '';
  live.startedAt = Date.now();
  const panel = $('liveThink');
  panel.hidden = false;
  panel.classList.remove('done');
  $('liveTitle').textContent = 'Model is analysing the charts…';
  $('liveOut').textContent = '';
  $('liveField').textContent = '';
  clearInterval(live.ticker);
  live.ticker = setInterval(liveTick, 100);
  liveTick();
}

function liveToken(e) {
  // A reconnect mid-analysis misses the start event, so adopt the run on first token.
  if (live.runId !== e.runId || $('liveThink').hidden) liveStart(e);
  live.thinking += e.thinking || '';
  live.content += e.content || '';

  const out = $('liveOut');
  // A reasoning trace reads far better than the JSON, so prefer it when there is one.
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  out.textContent = live.thinking || live.content;
  if (atBottom) out.scrollTop = out.scrollHeight;

  $('liveTitle').textContent = live.thinking ? 'Model is thinking…' : 'Model is writing the analysis…';
  $('liveField').textContent = live.thinking ? '' : currentField(live.content);
  liveTick();
}

function liveEnd() {
  clearInterval(live.ticker);
  live.ticker = null;
  const panel = $('liveThink');
  if (panel.hidden) return;
  panel.classList.add('done');
  $('liveTitle').textContent = 'Analysis complete';
  $('liveField').textContent = '';
  liveTick();
  live.startedAt = 0;
  // Leave the finished trace up briefly, then hand the space back to the results.
  setTimeout(() => {
    if (panel.classList.contains('done')) panel.hidden = true;
  }, 2500);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
  es.addEventListener('run', (e) => {
    const run = JSON.parse(e.data);
    if (!pinned) showRun(run);
    loadHistory();
  });
  es.addEventListener('analysis-start', (e) => liveStart(JSON.parse(e.data)));
  es.addEventListener('analysis-token', (e) => liveToken(JSON.parse(e.data)));
  es.addEventListener('analysis-end', () => liveEnd());
  es.addEventListener('error-event', (e) => {
    const d = JSON.parse(e.data);
    // `info` events (e.g. the market closing) are notices, not failures.
    if (!d.info) $('runMeta').textContent = `error: ${d.message}`;
    toast(d.message, d.info ? '' : 'bad');
  });
  es.onerror = () => {
    $('phasePill').className = 'pill bad';
    $('phaseText').textContent = 'disconnected';
  };
}

/* ---------- overflow menu ---------- */
function setMenu(open) {
  $('moreMenu').hidden = !open;
  $('moreBtn').setAttribute('aria-expanded', String(open));
}
const closeMenu = () => setMenu(false);

$('moreBtn').onclick = (e) => {
  e.stopPropagation();
  setMenu($('moreMenu').hidden);
};
$('moreMenu').onclick = (e) => { if (e.target.closest('.menu-item')) closeMenu(); };
document.addEventListener('click', (e) => {
  if (!e.target.closest('#moreWrap')) closeMenu();
});

/* ---------- controls ---------- */
$('runNow').onclick = async () => {
  pinned = false;
  $('runNow').disabled = true;
  toast('Capture started');
  await fetch('/api/run-now', { method: 'POST' });
};

$('snapBtn').onclick = async () => {
  const btn = $('snapBtn');
  const label = $('snapLabel');
  btn.disabled = true;
  snapping = true;
  label.textContent = 'Capturing…';
  toast('Capturing 4 snapshots — this takes ~30s');
  try {
    const r = await fetch('/api/snapshots', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'failed');
    const saved = (d.results || []).filter((x) => x.ok);
    const failed = (d.results || []).filter((x) => !x.ok);
    if (saved.length) toast(`Saved ${saved.length} snapshot(s) to ${d.dir}`, failed.length ? '' : 'ok');
    failed.forEach((f) => toast(`${f.label}: ${f.error}`, 'bad'));
  } catch (err) {
    toast(`Snapshots failed: ${err.message}`, 'bad');
  } finally {
    label.textContent = 'Save snapshots';
    snapping = false;
    btn.disabled = !!status.running;
  }
};

$('pauseBtn').onclick = async () => {
  const wasPaused = status.paused;
  await fetch(wasPaused ? '/api/resume' : '/api/pause', { method: 'POST' });
  toast(wasPaused ? 'Schedule resumed' : 'Schedule paused');
};

$('intervalSel').onchange = async (e) => {
  const sel = e.target;
  const minutes = Number(sel.value);
  sel.disabled = true;
  try {
    const r = await fetch('/api/interval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes }),
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || 'failed');
    applyStatus(s);
    toast(`Capturing every ${fmtMins(minutes)}`, 'ok');
  } catch (err) {
    toast(`Could not change interval: ${err.message}`, 'bad');
    syncIntervalSelect(status);
  } finally {
    sel.disabled = false;
  }
};

$('themeBtn').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};

$('shotsToggle').onclick = () => {
  shotsCollapsed = !shotsCollapsed;
  localStorage.setItem(COLLAPSE_KEY, String(shotsCollapsed));
  applyShotsCollapsed();
};
applyShotsCollapsed();

$('analysisToggle').onclick = () => {
  analysisCollapsed = !analysisCollapsed;
  localStorage.setItem(ANALYSIS_COLLAPSE_KEY, String(analysisCollapsed));
  applyAnalysisCollapsed();
};
applyAnalysisCollapsed();

async function toggleBrowserWindow() {
  const btn = $('windowBtn');
  if (btn.disabled || btn.hidden) return;
  const action = btn.dataset.visible === 'true' ? 'hide' : 'show';
  btn.disabled = true;
  try {
    const r = await (await fetch(`/api/window/${action}`, { method: 'POST' })).json();
    setWindowBtn(r.windowVisible);
    toast(r.windowVisible ? 'Browser window shown' : 'Browser window hidden');
  } catch (err) {
    toast(`Could not ${action} the browser window: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
}

$('windowBtn').onclick = toggleBrowserWindow;

/* ---------- clear data ---------- */
const closeModal = () => { $('clearModal').hidden = true; };

$('clearBtn').onclick = () => { $('clearModal').hidden = false; $('clearCancel').focus(); };
$('clearCancel').onclick = closeModal;
$('clearModal').onclick = (e) => { if (e.target === $('clearModal')) closeModal(); };

$('clearConfirm').onclick = async () => {
  const btn = $('clearConfirm');
  btn.disabled = true;
  try {
    const r = await (await fetch('/api/history', { method: 'DELETE' })).json();
    closeModal();
    resetView();
    await loadHistory();
    toast(`Cleared ${r.runs} run(s) and ${r.shots} screenshot(s)`, 'ok');
  } catch (err) {
    toast(`Clear failed: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
};

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleBrowserWindow();
    return;
  }
  if (e.key === 'Escape') {
    pinned = false;
    closeMenu();
    closeModal();
    document.querySelector('.lightbox')?.remove();
  }
});

resetView();
connect();
loadHistory();
pollOllama();
refreshTrend();
setInterval(tickCountdown, 250);
setInterval(pollOllama, 15000);
setInterval(refreshTrend, 30000);
