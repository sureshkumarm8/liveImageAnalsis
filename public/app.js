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
const SCREEN_KEY = 'marketAppScreen';
const RING_LEN = 100; // path circumference for the new SVG ring

const BRIEF_KEY = 'swingBrief';

// The last session of the current one-week window, served by /api/status. Shown on the
// header and in the empty report so the horizon is never ambiguous.
let exitByLabel = '';

let shotsCollapsed = localStorage.getItem(COLLAPSE_KEY) === 'true';
let analysisCollapsed = localStorage.getItem(ANALYSIS_COLLAPSE_KEY) === 'true';
let activeScreen = 'market';

const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/* ---------- screen switcher ---------- */
function switchScreen(screenName) {
  if (screenName !== 'market' && screenName !== 'stocks') {
    screenName = 'market';
  }
  activeScreen = screenName;
  try {
    localStorage.setItem(SCREEN_KEY, screenName);
  } catch {}

  const targetHash = screenName === 'stocks' ? '#stocks' : '#market';
  if (window.location.hash !== targetHash) {
    history.replaceState(null, '', targetHash);
  }

  const marketScreen = $('screenMarket');
  const stocksScreen = $('screenStocks');
  const tabMarket = $('tabMarket');
  const tabStocks = $('tabStocks');

  if (screenName === 'stocks') {
    if (marketScreen) marketScreen.hidden = true;
    if (stocksScreen) stocksScreen.hidden = false;
    if (tabMarket) tabMarket.classList.remove('active');
    if (tabStocks) tabStocks.classList.add('active');
  } else {
    if (stocksScreen) stocksScreen.hidden = true;
    if (marketScreen) marketScreen.hidden = false;
    if (tabStocks) tabStocks.classList.remove('active');
    if (tabMarket) tabMarket.classList.add('active');
  }
}

function initScreen() {
  const hash = (window.location.hash || '').replace('#', '').toLowerCase();
  let target = 'market';
  if (hash === 'stocks' || hash === 'market') {
    target = hash;
  } else {
    try {
      const saved = localStorage.getItem(SCREEN_KEY);
      if (saved === 'stocks' || saved === 'market') target = saved;
    } catch {}
  }
  switchScreen(target);
}

window.addEventListener('hashchange', () => {
  const hash = (window.location.hash || '').replace('#', '').toLowerCase();
  if (hash === 'stocks' || hash === 'market') {
    switchScreen(hash);
  }
});

/* ---------- theme ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const next = theme === 'dark' ? 'Light' : 'Dark';
  const btn = $('themeBtn');
  if (btn) btn.title = `Switch to ${next.toLowerCase()} theme`;
  if ($('themeLabel')) $('themeLabel').textContent = `${next} theme`;
  document.querySelectorAll('#themeSegment .segment').forEach((b) => {
    b.classList.toggle('active', b.dataset.value === theme);
    b.setAttribute('aria-selected', String(b.dataset.value === theme));
  });
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

/** Drive a `role="switch"` control: the state word and the checked attribute. */
function setSwitch(btnId, stateId, on) {
  const btn = $(btnId);
  if (btn) btn.setAttribute('aria-checked', String(Boolean(on)));
  const state = $(stateId);
  if (state) state.textContent = on ? 'ON' : 'OFF';
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

  if (hasValidFinancialData(p.financial_analysis)) {
    renderFinancialReport(p.financial_analysis, run ? `Captured with run ${run.id}` : '');
    const gfShot = (run?.shots || []).find((s) => s.id === 'googlefinance' || s.target === 'googlefinance');
    if (gfShot) renderGfShot(gfShot);
  } else if (!window.__onDemandReportActive) {
    renderFinancialReport(null);
    renderGfShot(null);
  }

  currentParsed = p;
  renderTrend(trend, p);
}

function renderGfShot(shot) {
  const card = $('gfShotCard');
  const img = $('gfShotImg');
  const meta = $('gfShotMeta');
  if (!card || !img) return;
  if (!shot || !shot.url) {
    card.hidden = true;
    return;
  }
  img.src = shot.url;
  if (meta) {
    meta.textContent = `${shot.label || 'Google Finance Research'} · ${fmtTime(shot.ts || Date.now())}`;
  }
  card.hidden = false;
}

function renderGfChart(chart) {
  const card = $('gfChartCard');
  const img = $('gfChartImg');
  const meta = $('gfChartMeta');
  if (!card || !img) return;
  if (!chart || !chart.url) {
    card.hidden = true;
    return;
  }
  img.src = chart.url;
  if (meta) {
    meta.textContent = `${chart.label || 'Candlestick Chart (YTD)'} · ${fmtTime(chart.ts || Date.now())}`;
  }
  card.hidden = false;
}

function hasValidFinancialData(data) {
  if (!data || typeof data !== 'object') return false;
  // The Stocks screen shows a swing *call*, so a bare fundamentals blob (what the
  // intraday run attaches to a Google Finance shot) must not light it up.
  if (!data.short_term_verdict && !data.trade_plan) return false;
  const name = (data.target_name || data.ticker || '').trim();
  const price = (data.current_price || '').trim();
  if (!name || name === '—' || name === 'N/A' || name.toLowerCase() === 'stock' || name.toLowerCase() === 'market overview') {
    return false;
  }
  if (!price || price === '—' || price === 'N/A') {
    return false;
  }
  return true;
}

const SETUP_LABELS = {
  breakout: 'Breakout',
  pullback_to_support: 'Pullback to support',
  trend_continuation: 'Trend continuation',
  reversal: 'Reversal',
  range_fade: 'Range fade',
  momentum_burst: 'Momentum burst',
  event_driven: 'Event driven',
  no_setup: 'No setup',
};

const SCORE_ROWS = [
  ['trend', 'Trend'],
  ['momentum', 'Momentum'],
  ['volume_liquidity', 'Volume & liquidity'],
  ['catalyst', 'Catalyst'],
  ['risk_reward', 'Risk : reward'],
  ['valuation', 'Valuation'],
];

function setText(id, value, fallback = '—') {
  const el = $(id);
  if (el) el.textContent = value || fallback;
}

/** Six 0-10 components as bars, so a weak leg of the setup is visible at a glance. */
function renderScorecard(scores) {
  const wrap = $('gfReportScorecard');
  const totalEl = $('gfScoreTotal');
  if (!wrap) return;
  wrap.innerHTML = '';

  const src = scores || {};
  let sum = 0;
  let counted = 0;

  SCORE_ROWS.forEach(([key, label]) => {
    const raw = Number(src[key]);
    const val = Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : null;
    if (val !== null) {
      sum += val;
      counted += 1;
    }

    const row = document.createElement('div');
    row.className = 'gf-score-row';

    const name = document.createElement('span');
    name.className = 'gf-score-name';
    name.textContent = label;

    const track = document.createElement('div');
    track.className = 'gf-score-track';
    const fill = document.createElement('div');
    fill.className = `gf-score-fill ${val === null ? 'none' : val >= 7 ? 'good' : val >= 4 ? 'mid' : 'poor'}`;
    fill.style.width = `${(val ?? 0) * 10}%`;
    track.appendChild(fill);

    const num = document.createElement('b');
    num.className = 'gf-score-val';
    num.textContent = val === null ? '—' : `${val}/10`;

    row.append(name, track, num);
    wrap.appendChild(row);
  });

  if (totalEl) totalEl.textContent = counted ? `${sum} / ${counted * 10} overall` : '—';
}

function renderFinancialReport(data, metaText = '') {
  const panel = $('gfReportPanel');
  if (!panel) return;
  panel.hidden = false;

  const displaySymbol = data?.ticker || data?.target_name || $('gfActiveSymbol')?.textContent || '—';
  if ($('stocksHeaderActiveSymbol') && displaySymbol && displaySymbol !== '—') {
    $('stocksHeaderActiveSymbol').textContent = displaySymbol;
  }

  const setupChip = $('gfReportSetup');
  const gradeEl = $('gfReportGrade');
  const whyNowEl = $('gfReportWhyNow');
  const gapsCard = $('gfDataGapsCard');

  if (!hasValidFinancialData(data)) {
    $('gfReportMeta').textContent = metaText || 'No call on the desk yet';
    $('gfReportTicker').textContent = 'READY';
    $('gfReportHorizon').textContent = exitByLabel ? `One-week swing · exit by ${exitByLabel}` : 'One-week swing';
    $('gfReportName').textContent = 'Ask for a one-week swing call';
    $('gfReportPrice').textContent = '—';
    const delta = $('gfReportDelta');
    if (delta) {
      delta.textContent = '';
      delta.className = 'delta';
    }
    if (setupChip) setupChip.hidden = true;
    if (gradeEl) {
      gradeEl.textContent = '—';
      gradeEl.className = 'gf-grade-badge';
    }
    const verdictEl = $('gfReportVerdict');
    if (verdictEl) {
      verdictEl.textContent = 'AWAITING ANALYSIS';
      verdictEl.className = 'gf-verdict-badge neutral';
    }
    setText('gfReportConviction', '—');
    setText('gfReportDataConf', '', '');
    const healthBadge = $('gfReportHealth');
    if (healthBadge) {
      healthBadge.textContent = 'STANDBY';
      healthBadge.className = 'gf-health-badge neutral';
    }
    if (whyNowEl) whyNowEl.hidden = true;
    setText(
      'gfReportVerdictSummary',
      'Pick a share above (chip, or a symbol like RELIANCE:NSE), set the capital you are trading with, and click “Advise Me”. You get a verdict, an entry trigger, a structural stop, a share count sized to your risk budget, and the session you walk away on.',
    );

    ['gfReportEntry', 'gfReportSL', 'gfReportTargets', 'gfReportRR', 'gfReportQty', 'gfReportTimeStop'].forEach((id) =>
      setText(id, 'Awaiting call'),
    );
    setText('gfReportEntryTrigger', 'Buy only on the trigger');
    setText('gfReportRiskPerShare', 'Structural invalidation');
    setText('gfReportExpMove', 'Book inside the week');
    setText('gfReportCapitalDeployed', 'For your stated capital');

    ['gfReportMktCap', 'gfReportPE', 'gfReport52W', 'gfReportDiv', 'gfReportDayRange'].forEach((id) => setText(id, '—'));

    renderScorecard(null);
    setList($('gfReportAiInsights'), [
      'The Google Finance Beta AI Research panel is queried live with a one-week swing brief for the share you pick.',
      'Its answer is merged with the price screen into a single, sized trade plan.',
    ]);

    ['gfReportTrend', 'gfReportMomentum', 'gfReportVolume', 'gfReport52wProx', 'gfReportVolatility',
      'gfReportKeySupport', 'gfReportKeyResist', 'gfReportTrigger', 'gfReportExitPlan', 'gfReportSizingNote', 'gfReportInvalidation',
      'gfReportBull', 'gfReportBear', 'gfReportValuation'].forEach((id) => setText(id, '—'));

    setList($('gfReportCatalysts'), ['Awaiting the call — catalysts landing inside the week appear here.']);
    setList($('gfReportRisks'), ['Awaiting the call — what threatens the stop appears here.']);
    setList($('gfReportHighlights'), []);
    setText('gfReportTakeaway', 'Ready when you are — pick a share and ask for the call.');
    if (gapsCard) gapsCard.hidden = true;
    return;
  }

  $('gfReportMeta').textContent = metaText || (data.ticker ? `Ticker: ${data.ticker}` : '');
  $('gfReportTicker').textContent = data.ticker || data.target_name || 'Stock';
  $('gfReportHorizon').textContent = data.time_horizon || 'One-week swing';
  $('gfReportName').textContent = data.target_name || data.ticker || 'One-week swing call';
  $('gfReportPrice').textContent = data.current_price || '—';

  const delta = $('gfReportDelta');
  if (data.day_change) {
    delta.textContent = data.day_change;
    const isUp = data.day_change.includes('+');
    const isDown = data.day_change.includes('-');
    delta.className = `delta ${isUp ? 'up' : isDown ? 'down' : 'flat'}`;
  } else {
    delta.textContent = '';
    delta.className = 'delta';
  }

  // Setup type
  if (setupChip) {
    const setup = (data.setup_type || '').toLowerCase();
    if (setup) {
      setupChip.textContent = SETUP_LABELS[setup] || setup.replace(/_/g, ' ');
      setupChip.className = `gf-setup-chip${setup === 'no_setup' ? ' none' : ''}`;
      setupChip.hidden = false;
    } else {
      setupChip.hidden = true;
    }
  }

  // Setup grade — A+ / A are the only ones worth full size, so they get the loud colour.
  if (gradeEl) {
    const grade = (data.trade_grade || '').toUpperCase();
    gradeEl.textContent = grade ? grade.replace('A_PLUS', 'A+') : '—';
    gradeEl.className = `gf-grade-badge${grade ? ` g-${grade.toLowerCase().replace('_', '-')}` : ''}`;
  }

  // Verdict badge
  const rawVerdict = (data.short_term_verdict || 'NEUTRAL').toUpperCase();
  const verdictEl = $('gfReportVerdict');
  if (verdictEl) {
    verdictEl.textContent = rawVerdict.replace(/_/g, ' ');
    verdictEl.className = `gf-verdict-badge ${rawVerdict.toLowerCase().replace(/_/g, '-')}`;
  }

  setText('gfReportConviction', data.conviction_score ? `${data.conviction_score}%` : '—');
  setText(
    'gfReportDataConf',
    Number(data.data_confidence) ? `screen read ${data.data_confidence}%` : '',
    '',
  );

  const health = (data.financial_health || 'neutral').toLowerCase();
  const healthBadge = $('gfReportHealth');
  if (healthBadge) {
    healthBadge.textContent = health;
    healthBadge.className = `gf-health-badge ${health}`;
  }

  if (whyNowEl) {
    whyNowEl.textContent = data.why_now || '';
    whyNowEl.hidden = !data.why_now;
  }
  setText('gfReportVerdictSummary', data.verdict_summary || data.analyst_takeaway || 'One-week swing call generated.');

  // Order ticket
  const plan = data.trade_plan || {};
  const sizing = data.position_sizing || {};
  setText('gfReportEntry', plan.entry_zone);
  setText('gfReportEntryTrigger', plan.entry_trigger, 'Buy only on the trigger');
  setText('gfReportSL', plan.stop_loss);
  setText('gfReportRiskPerShare', sizing.risk_per_share ? `Risk/share ${sizing.risk_per_share}` : '', 'Structural invalidation');
  const t1 = plan.target_1 || '';
  const t2 = plan.target_2 || '';
  setText('gfReportTargets', t1 && t2 ? `${t1} / ${t2}` : t1 || t2);
  setText('gfReportExpMove', plan.expected_move_pct ? `Expected move ${plan.expected_move_pct}` : '', 'Book inside the week');
  setText('gfReportRR', plan.risk_reward_ratio);
  setText('gfReportQty', sizing.quantity);
  setText(
    'gfReportCapitalDeployed',
    [sizing.capital_deployed && `Deploys ${sizing.capital_deployed}`, sizing.risk_amount && `risking ${sizing.risk_amount}`]
      .filter(Boolean)
      .join(' · '),
    'For your stated capital',
  );
  setText('gfReportTimeStop', plan.time_stop);

  // Fundamentals strip
  setText('gfReportMktCap', data.market_cap);
  setText('gfReportPE', data.pe_ratio);
  setText('gfReport52W', data.year_range);
  setText('gfReportDiv', data.dividend_yield);
  setText('gfReportDayRange', data.day_range);

  renderScorecard(data.scorecard);

  // Playbook
  setText('gfReportTrigger', plan.entry_trigger);
  setText('gfReportExitPlan', plan.exit_plan);
  setText('gfReportSizingNote', sizing.binding_constraint);
  setText('gfReportInvalidation', data.invalidation);

  // Technical momentum
  const tech = data.technical_momentum || {};
  setText('gfReportTrend', tech.trend_structure);
  setText('gfReportMomentum', tech.momentum_read);
  setText('gfReportVolume', tech.volume_liquidity);
  setText('gfReport52wProx', tech.proximity_to_52w);
  setText('gfReportVolatility', tech.volatility_note);
  setText('gfReportKeySupport', tech.key_support);
  setText('gfReportKeyResist', tech.key_resistance);

  setText('gfReportBull', data.bull_case);
  setText('gfReportBear', data.bear_case);

  const researchItems = data.google_finance_ai_insights?.length
    ? data.google_finance_ai_insights
    : data.catalysts_and_news || ['AI Research panel observed; no explicit bullet points extracted.'];
  setList($('gfReportAiInsights'), researchItems);

  setList($('gfReportCatalysts'), data.near_term_catalysts || data.catalysts_and_news || []);
  setList($('gfReportRisks'), data.short_term_risks || data.risks || []);

  setText('gfReportValuation', data.valuation_summary);
  setList($('gfReportHighlights'), data.financial_highlights || (data.key_metrics ? [data.key_metrics] : []));
  setText('gfReportTakeaway', data.analyst_takeaway);

  // Everything the model could not read is stated, not hidden — it is why conviction is low.
  const gaps = (data.data_gaps || []).filter(Boolean);
  if (gapsCard) {
    gapsCard.hidden = gaps.length === 0;
    if (gaps.length) setList($('gfReportDataGaps'), gaps);
  }
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
  renderFinancialReport(null);
  renderGfShot(null);
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
  const sel = $('settingsIntervalSelect');
  if (!sel) return;
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

  if (s.kiteEnabled !== undefined) setSwitch('kiteToggleBtn', 'kiteTogglePill', s.kiteEnabled);

  if (s.googleFinance) {
    setSwitch('gfToggleBtn', 'gfTogglePill', s.googleFinance.enabled);
    const symbolEl = $('gfActiveSymbol');
    if (symbolEl && s.googleFinance.symbol) {
      symbolEl.textContent = s.googleFinance.symbol;
      if ($('stocksHeaderActiveSymbol')) $('stocksHeaderActiveSymbol').textContent = s.googleFinance.symbol;
    }
    const extLink = $('gfExtLink');
    if (extLink && s.googleFinance.url) {
      extLink.href = s.googleFinance.url;
    }
  }
  if ($('stocksHeaderAiProvider')) {
    $('stocksHeaderAiProvider').textContent = (s.provider || 'AI').toUpperCase();
  }
  if (s.advisor) {
    applyAdvisorDefaults(s.advisor);
  }
}

function tickCountdown() {
  const el = $('ringLabel');
  const ring = $('ringFg');
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
    document.querySelector('.ring-wrap').title = `Market closed — next open ${fmtClock(status.nextRunAt)}`;
    setRing(0);
    return;
  }

  document.querySelector('.ring-wrap').title = 'Time until the next automatic run';
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

async function pollProvider() {
  try {
    const s = await (await fetch('/api/status')).json();
    renderQuotePill(s.quote);
    // Only this endpoint carries the full payload — the SSE `status` event is the
    // scheduler's view and has neither the provider name nor the adviser defaults.
    if (s.advisor) applyAdvisorDefaults(s.advisor);
    if ($('stocksHeaderAiProvider') && s.provider) {
      $('stocksHeaderAiProvider').textContent = s.provider.toUpperCase();
    }
    const pill = $('providerPill');
    
    if (s.provider === 'gemini') {
      if (s.ai?.ok) {
        pill.className = 'pill ok';
        $('providerText').textContent = 'gemini · ready';
        pill.title = 'Gemini API is ready to process analysis';
      } else {
        pill.className = 'pill bad';
        $('providerText').textContent = 'gemini · error';
        pill.title = s.ai?.error || 'Missing GEMINI_API_KEY';
      }
    } else {
      const gb = s.ai?.loaded?.bytes ? (s.ai.loaded.bytes / 1073741824).toFixed(1) : null;
      if (s.ai?.ok && s.ai.hasModel) {
        pill.className = 'pill ok';
        $('providerText').textContent = gb ? `ollama · ${gb}GB` : 'ollama · idle';
        pill.title = gb
          ? 'Model is resident in memory for fast analysis'
          : 'Model unloaded — memory released. It reloads automatically (~4s) on the next run.';
      } else if (s.ai?.ok) {
        pill.className = 'pill bad';
        $('providerText').textContent = 'model missing';
      } else {
        pill.className = 'pill bad';
        $('providerText').textContent = 'ollama offline';
      }
    }
    
    renderProviderSettings(s);

    const wb = $('windowBtn');
    // Window control needs CDP + TUCK_WINDOW; hide the button outright when unavailable.
    wb.hidden = s.windowControl === false;
    if (!wb.hidden) setWindowBtn(s.windowVisible);
  } catch {
    $('providerPill').className = 'pill bad';
    $('providerText').textContent = 'server offline';
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
es.addEventListener('batch', (e) => renderBatch(JSON.parse(e.data)));
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

$('kiteToggleBtn').onclick = async (e) => {
  e.stopPropagation();
  try {
    const res = await fetch('/api/kite-toggle', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setSwitch('kiteToggleBtn', 'kiteTogglePill', data.kiteEnabled);
      toast(`Kite backup capture ${data.kiteEnabled ? 'enabled' : 'disabled'}`, 'ok');
    }
  } catch (err) {
    toast(`Failed to toggle Kite backup: ${err.message}`, 'bad');
  }
};

const toggleGoogleFinance = async (e) => {
  if (e) e.stopPropagation();
  try {
    const res = await fetch('/api/google-finance/toggle', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      setSwitch('gfToggleBtn', 'gfTogglePill', data.googleFinanceEnabled);
      toast(`Google Finance in routine runs ${data.googleFinanceEnabled ? 'enabled' : 'disabled'}`, 'ok');
    }
  } catch (err) {
    toast(`Failed to toggle Google Finance: ${err.message}`, 'bad');
  }
};

$('gfToggleBtn').onclick = toggleGoogleFinance;

/* ---------- Google Finance research controls ---------- */
async function setGfTarget(query) {
  const loadBtn = $('gfLoadBtn');
  loadBtn.disabled = true;
  try {
    const res = await fetch('/api/google-finance/target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.ok) {
      $('gfActiveSymbol').textContent = data.symbol || 'Google Finance';
      if ($('stocksHeaderActiveSymbol')) $('stocksHeaderActiveSymbol').textContent = data.symbol || 'Google Finance';
      if (data.url) $('gfExtLink').href = data.url;
      toast(`Google Finance set to ${data.symbol || 'target'}`, 'ok');
    } else {
      toast(`Failed to set share: ${data.error}`, 'bad');
    }
  } catch (err) {
    toast(`Failed to set target: ${err.message}`, 'bad');
  } finally {
    loadBtn.disabled = false;
  }
}

document.querySelectorAll('.gf-chip').forEach((chip) => {
  chip.onclick = async () => {
    const ticker = chip.dataset.ticker;
    $('gfInput').value = ticker === 'overview' ? '' : ticker;
    await setGfTarget(ticker);
  };
});

$('gfForm').onsubmit = async (e) => {
  e.preventDefault();
  const val = $('gfInput').value.trim();
  await setGfTarget(val);
};

/* ---------- the client brief: capital and risk budget the adviser sizes against ---------- */
const briefDefaults = { capital: 100000, riskPct: 2, maxAllocPct: 25, currency: '₹' };
let briefSeededFromServer = false;

function readBrief() {
  const pick = (id, dflt) => {
    const v = Number($(id)?.value);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    capital: pick('gfCapital', briefDefaults.capital),
    riskPct: pick('gfRiskPct', briefDefaults.riskPct),
    maxAllocPct: pick('gfMaxAlloc', briefDefaults.maxAllocPct),
  };
}

const briefMoney = (n) => `${briefDefaults.currency}${Math.round(n).toLocaleString('en-IN')}`;

function updateBriefHint({ persist = true } = {}) {
  const b = readBrief();
  const hint = $('gfBriefHint');
  if (hint) {
    hint.textContent =
      `Risking ${briefMoney((b.capital * b.riskPct) / 100)} per trade · ` +
      `max ${briefMoney((b.capital * b.maxAllocPct) / 100)} in one position`;
  }
  if (persist) {
    try {
      localStorage.setItem(BRIEF_KEY, JSON.stringify(b));
    } catch {}
  }
}

function writeBrief(brief) {
  if ($('gfCapital')) $('gfCapital').value = brief.capital;
  if ($('gfRiskPct')) $('gfRiskPct').value = brief.riskPct;
  if ($('gfMaxAlloc')) $('gfMaxAlloc').value = brief.maxAllocPct;
}

/** Server-side defaults (.env) seed the fields once; after that your own numbers win. */
function applyAdvisorDefaults(advisor) {
  if (advisor.currency) briefDefaults.currency = advisor.currency;
  ['capital', 'riskPct', 'maxAllocPct'].forEach((k) => {
    if (Number(advisor[k]) > 0) briefDefaults[k] = Number(advisor[k]);
  });

  if (advisor.window?.exitBy) {
    exitByLabel = advisor.window.exitBy;
    if ($('stocksHeaderExitBy')) $('stocksHeaderExitBy').textContent = exitByLabel;
  }

  if (!briefSeededFromServer) {
    briefSeededFromServer = true;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(BRIEF_KEY) || 'null');
    } catch {}
    if (!saved) {
      writeBrief(briefDefaults);
      updateBriefHint({ persist: false });
    }
  }
}

(function initBrief() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(BRIEF_KEY) || 'null');
  } catch {}
  if (saved) writeBrief({ ...briefDefaults, ...saved });
  ['gfCapital', 'gfRiskPct', 'gfMaxAlloc'].forEach((id) => {
    const el = $(id);
    if (el) el.oninput = () => updateBriefHint();
  });
  updateBriefHint({ persist: false });
})();

$('gfAnalyseBtn').onclick = async () => {
  const btn = $('gfAnalyseBtn');
  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" class="spin"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg> Advising…`;
  toast('Asking Google Finance Beta AI Research for a one-week read…');
  try {
    let inputVal = $('gfInput').value.trim();
    if (!inputVal) {
      const activeText = $('gfActiveSymbol')?.textContent?.trim();
      if (activeText && !activeText.toLowerCase().includes('overview')) {
        inputVal = activeText;
      } else {
        inputVal = 'RELIANCE:NSE';
        $('gfInput').value = 'RELIANCE:NSE';
      }
    }
    const brief = readBrief();
    const res = await fetch('/api/google-finance/analyse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: inputVal, ...brief }),
    });
    const data = await res.json();
    if (data.ok && data.report?.parsed) {
      window.__onDemandReportActive = true;
      renderFinancialReport(data.report.parsed, `Google Finance AI Analysis at ${new Date().toLocaleTimeString()}`);
      if (data.shot?.url) {
        renderGfShot(data.shot);
      }
      renderGfChart(data.chart || null);
      toast('One-week swing call ready.', 'ok');
      await loadStockHistory();
      $('gfReportPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      const errMsg = data.error || data.report?.error || 'Failed to extract financial data from the screen.';
      toast(`Report failed: ${errMsg}`, 'bad');
    }
  } catch (err) {
    toast(`Error: ${err.message}`, 'bad');
  } finally {
    btn.innerHTML = origHtml;
    setSingleAnalyseBlocked(Boolean(batchState?.active));
  }
};

let gfReportCollapsed = false;
$('gfReportToggle').onclick = () => {
  gfReportCollapsed = !gfReportCollapsed;
  $('gfReportPanel').classList.toggle('collapsed', gfReportCollapsed);
  $('gfReportCaret').setAttribute('aria-expanded', String(!gfReportCollapsed));
  $('gfReportCaret').title = gfReportCollapsed ? 'Expand' : 'Collapse';
};

let gfShotCollapsed = false;
if ($('gfShotToggle')) {
  $('gfShotToggle').onclick = () => {
    gfShotCollapsed = !gfShotCollapsed;
    $('gfShotCard').classList.toggle('collapsed', gfShotCollapsed);
    if ($('gfShotCaret')) {
      $('gfShotCaret').setAttribute('aria-expanded', String(!gfShotCollapsed));
      $('gfShotCaret').title = gfShotCollapsed ? 'Expand' : 'Collapse';
    }
  };
}

let gfChartCollapsed = false;
if ($('gfChartToggle')) {
  $('gfChartToggle').onclick = () => {
    gfChartCollapsed = !gfChartCollapsed;
    $('gfChartCard').classList.toggle('collapsed', gfChartCollapsed);
    if ($('gfChartCaret')) {
      $('gfChartCaret').setAttribute('aria-expanded', String(!gfChartCollapsed));
      $('gfChartCaret').title = gfChartCollapsed ? 'Expand' : 'Collapse';
    }
  };
}

// Bind Screen Switching Tabs
if ($('tabMarket')) $('tabMarket').onclick = () => switchScreen('market');
if ($('tabStocks')) $('tabStocks').onclick = () => switchScreen('stocks');

/* ---------- Batch analysis: a screener CSV in, a ranked shortlist out ---------- */

/** RFC-4180-ish: quoted fields, escaped quotes, commas inside quotes, CRLF, BOM. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const colIndex = (headers, ...patterns) => {
  for (const re of patterns) {
    const i = headers.findIndex((h) => re.test(h));
    if (i !== -1) return i;
  }
  return -1;
};

const looksLikeTicker = (v) => /^[A-Z][A-Z0-9&_-]{1,19}$/.test(String(v || '').trim());

/**
 * A one-week swing needs a liquid, tradeable share. Funds, rights entitlements and
 * near-zero prices come through screener exports too, so they are flagged and left
 * unticked rather than silently dropped.
 */
function tradeabilityNote(symbol, name, close) {
  const sym = String(symbol || '').toUpperCase();
  const nm = String(name || '').toUpperCase();
  if (/-RE$/.test(sym) || /\bRIGHTS?\b|\bRE\b$/.test(nm)) return 'Rights entitlement';
  if (/\bETF\b|\bFUND\b|LIQUID|BEES|GOLD|SILVER|NIFTY|SENSEX|NASDAQ/.test(nm) || /ETF$|BEES$|LIQ/.test(sym)) {
    return 'Fund / ETF';
  }
  const price = Number(String(close || '').replace(/[^\d.]/g, ''));
  if (Number.isFinite(price) && price > 0 && price < 5) return 'Below ₹5';
  return '';
}

let batchRows = [];           // every parsed row
let batchState = null;        // the server's view of the running/last job
const BATCH_MAX = 60;

function readBatchCsv(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadBatchRows(parseCsv(String(reader.result)), file.name);
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}`, 'bad');
    }
  };
  reader.onerror = () => toast(`Could not read ${file.name}`, 'bad');
  reader.readAsText(file);
}

function loadBatchRows(rows, fileName) {
  if (!rows.length) {
    toast('That CSV looks empty.', 'bad');
    return;
  }

  const header = rows[0].map((h) => h.trim());
  const headerLooksLikeData = looksLikeTicker(header[0]) || header.every((h) => /^[\d.,%-]*$/.test(h));
  const headers = headerLooksLikeData ? header.map((_, i) => `col${i}`) : header;
  const body = headerLooksLikeData ? rows : rows.slice(1);

  let symbolIdx = colIndex(headers, /^(symbol|ticker|scrip|code)$/i, /symbol|ticker|scrip/i);
  const nameIdx = colIndex(headers, /(stock|company).*name|^name$/i, /name|company/i);
  const closeIdx = colIndex(headers, /^(close|price|ltp|cmp)$/i, /close|price|ltp|cmp/i);
  const chgIdx = colIndex(headers, /change|chg|%/i);
  const volIdx = colIndex(headers, /volume|qty|traded/i);

  // No usable header: fall back to the column that actually holds tickers.
  if (symbolIdx === -1) {
    const widths = headers.map((_, i) => body.filter((r) => looksLikeTicker(r[i])).length);
    symbolIdx = widths.indexOf(Math.max(...widths));
  }
  if (symbolIdx === -1 || !body.length) {
    toast('No symbol column found in that CSV.', 'bad');
    return;
  }

  const seen = new Set();
  batchRows = [];
  for (const r of body) {
    const symbol = String(r[symbolIdx] || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const name = nameIdx !== -1 ? String(r[nameIdx] || '').trim() : '';
    const close = closeIdx !== -1 ? String(r[closeIdx] || '').trim() : '';
    batchRows.push({
      symbol,
      name,
      close,
      change: chgIdx !== -1 ? String(r[chgIdx] || '').trim() : '',
      volume: volIdx !== -1 ? String(r[volIdx] || '').trim() : '',
      note: tradeabilityNote(symbol, name, close),
      selected: false,
    });
  }

  if (!batchRows.length) {
    toast('No symbols found in that CSV.', 'bad');
    return;
  }

  // Nothing is ticked on import: the whole file is previewed and the choice is the
  // user's. The quick picks make a sensible selection one click away.
  const flagged = batchRows.filter((r) => r.note).length;
  $('batchFileName').textContent = fileName || 'watchlist.csv';
  $('batchRowInfo').textContent =
    `${batchRows.length} symbol${batchRows.length === 1 ? '' : 's'}${flagged ? ` · ${flagged} flagged` : ''}`;
  $('batchPick').hidden = false;
  renderBatchRows();
  $('batchPick').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast(`${batchRows.length} stocks loaded — pick the ones to analyse`, 'ok');
}

function selectBatch(mode) {
  const tradeable = (r) => !r.note;
  if (mode === 'none') batchRows.forEach((r) => { r.selected = false; });
  else if (mode === 'all') batchRows.forEach((r, i) => { r.selected = i < BATCH_MAX; });
  else if (mode === 'tradeable') {
    let n = 0;
    batchRows.forEach((r) => { r.selected = tradeable(r) && n < BATCH_MAX && ++n > 0; });
  } else {
    const limit = Number(mode) || 10;
    let n = 0;
    batchRows.forEach((r) => { r.selected = tradeable(r) && n < limit && ++n > 0; });
  }
  renderBatchRows();
}

const selectedBatchRows = () => batchRows.filter((r) => r.selected);

function renderBatchRows() {
  const tbody = $('batchRows');
  if (!tbody) return;
  tbody.innerHTML = '';

  batchRows.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.note) tr.classList.add('flagged');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = r.selected;
    cb.setAttribute('aria-label', `Select ${r.symbol}`);
    cb.onchange = () => {
      r.selected = cb.checked;
      updateBatchEstimate();
    };
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text || '—';
      if (cls) td.className = cls;
      return td;
    };
    tr.appendChild(cell(r.symbol, 'sym'));
    tr.appendChild(cell(r.name, 'nm'));
    tr.appendChild(cell(r.close, 'num'));

    const chg = cell(r.change, 'num');
    if (/^-/.test(r.change)) chg.classList.add('down');
    else if (r.change && r.change !== '0%') chg.classList.add('up');
    tr.appendChild(chg);

    tr.appendChild(cell(r.volume, 'num'));

    const tdNote = document.createElement('td');
    if (r.note) {
      const flag = document.createElement('span');
      flag.className = 'batch-flag';
      flag.textContent = r.note;
      tdNote.appendChild(flag);
    }
    tr.appendChild(tdNote);

    tr.ondblclick = () => { $('gfInput').value = r.symbol; setGfTarget(r.symbol); };
    tr.title = `${r.symbol} — double-click to load this one share in the Google Finance window`;
    tbody.appendChild(tr);
  });

  updateBatchEstimate();
}

function updateBatchEstimate() {
  const n = selectedBatchRows().length;
  const all = $('batchCheckAll');
  if (all) {
    all.checked = n > 0 && n === batchRows.length;
    all.indeterminate = n > 0 && n < batchRows.length;
  }
  const perItemMs = batchState?.avgMs || 70000;
  const mins = Math.max(1, Math.round((n * perItemMs) / 60000));
  const est = $('batchEstimate');
  if (est) {
    est.textContent = n ? `${n} of ${batchRows.length} picked · about ${mins} min` : 'pick at least one stock';
  }
  const label = $('batchRunLabel');
  if (label) label.textContent = n ? `Analyse ${n} stock${n === 1 ? '' : 's'}` : 'Analyse selected';
  const btn = $('batchRunBtn');
  if (btn) btn.disabled = n === 0 || Boolean(batchState?.active);
}

/** Best call first: verdict, then setup grade, then conviction. */
const VERDICT_RANK = { STRONG_BUY: 0, TACTICAL_BUY: 1, WAIT_PULLBACK: 2, NEUTRAL: 3, AVOID: 4 };
const GRADE_RANK = { A_PLUS: 0, A: 1, B: 2, C: 3, D: 4 };

function rankResults(results) {
  return [...results].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const v = (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9);
    if (v) return v;
    const g = (GRADE_RANK[a.grade] ?? 9) - (GRADE_RANK[b.grade] ?? 9);
    if (g) return g;
    return (b.conviction || 0) - (a.conviction || 0);
  });
}

let batchWasActive = false;

function renderBatch(state) {
  batchState = state && state.id ? state : null;
  const prog = $('batchProgress');
  const results = $('batchResults');
  const meta = $('batchMeta');
  if (!prog || !results) return;

  if (!batchState) {
    prog.hidden = true;
    if (meta) meta.textContent = 'Load a CSV of symbols';
    setSingleAnalyseBlocked(false);
    updateBatchEstimate();
    return;
  }

  const { active, total, completed, current, etaMs, status, succeeded, failed } = batchState;

  // One capture browser, one queue: a single-share request during a batch would just sit
  // behind it and navigate the same tab, so the button is held until the batch is done.
  setSingleAnalyseBlocked(active);
  if (batchWasActive && !active) {
    loadStockHistory();
    toast(
      status === 'stopped'
        ? `Batch stopped — ${succeeded} call${succeeded === 1 ? '' : 's'} on the desk`
        : `Batch finished — ${succeeded} analysed${failed ? `, ${failed} failed` : ''}`,
      failed && !succeeded ? 'bad' : 'ok',
    );
  }
  batchWasActive = active;

  prog.hidden = !active;
  if (active) {
    $('batchProgNow').textContent = current
      ? `Analysing ${current.symbol}${current.name ? ` · ${current.name}` : ''}…`
      : 'Waiting for the capture browser…';
    $('batchProgCount').textContent = `${completed} / ${total}`;
    $('batchBarFill').style.width = `${total ? (completed / total) * 100 : 0}%`;
    $('batchProgEta').textContent = etaMs
      ? `about ${Math.max(1, Math.round(etaMs / 60000))} min left`
      : 'estimating…';
  }

  if (meta) {
    meta.textContent = active
      ? `Running · ${completed} of ${total}`
      : `${status === 'stopped' ? 'Stopped' : 'Finished'} · ${succeeded} analysed${failed ? `, ${failed} failed` : ''}`;
  }

  renderBatchResults(batchState.results || []);
  updateBatchEstimate();
}

function renderBatchResults(list) {
  const wrap = $('batchResults');
  const tbody = $('batchResultRows');
  if (!wrap || !tbody) return;

  if (!list.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const ranked = rankResults(list);
  const meta = $('batchResultMeta');
  if (meta) {
    const buys = ranked.filter((r) => r.ok && (r.verdict === 'STRONG_BUY' || r.verdict === 'TACTICAL_BUY')).length;
    meta.textContent = `${ranked.length} analysed · ${buys} worth a trade this week`;
  }

  tbody.innerHTML = '';
  ranked.forEach((r) => {
    const tr = document.createElement('tr');

    if (!r.ok) {
      tr.className = 'failed';
      const sym = document.createElement('td');
      sym.className = 'sym';
      sym.textContent = r.symbol;
      tr.appendChild(sym);
      const err = document.createElement('td');
      err.colSpan = 9;
      err.className = 'batch-err';
      err.textContent = r.error || 'Failed';
      tr.appendChild(err);
      tbody.appendChild(tr);
      return;
    }

    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text || '—';
      if (cls) td.className = cls;
      return td;
    };

    tr.appendChild(cell(r.symbol, 'sym'));

    const tdVerdict = document.createElement('td');
    const badge = document.createElement('span');
    const verdict = (r.verdict || 'NEUTRAL').toUpperCase();
    badge.className = `gf-verdict-badge ${verdict.toLowerCase().replace(/_/g, '-')}`;
    badge.textContent = verdict.replace(/_/g, ' ');
    tdVerdict.appendChild(badge);
    tr.appendChild(tdVerdict);

    const tdGrade = document.createElement('td');
    tdGrade.className = 'num';
    if (r.grade) {
      const g = document.createElement('span');
      g.className = `gf-grade-badge g-${r.grade.toLowerCase().replace('_', '-')}`;
      g.textContent = r.grade.replace('A_PLUS', 'A+');
      tdGrade.appendChild(g);
    } else tdGrade.textContent = '—';
    tr.appendChild(tdGrade);

    tr.appendChild(cell(r.conviction ? `${r.conviction}%` : '—', 'num'));
    tr.appendChild(cell(r.price, 'num'));
    tr.appendChild(cell(r.entry));
    tr.appendChild(cell(r.stop));
    tr.appendChild(cell(r.target));
    tr.appendChild(cell(r.rr, 'num'));
    tr.appendChild(cell(r.quantity, 'num'));

    tr.classList.add('clickable');
    tr.title = `${r.symbol} — open the full adviser note`;
    tr.onclick = () => openStockRun(r.id);
    tbody.appendChild(tr);
  });
}

/** Pull one stored run and show it in the report panel above. */
async function openStockRun(id) {
  if (!id) return;
  try {
    const res = await fetch(`/api/stocks/run/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    selectStockHistoryItem(await res.json());
  } catch (err) {
    toast(`Could not open that report: ${err.message}`, 'bad');
  }
}

function setSingleAnalyseBlocked(blocked) {
  const btn = $('gfAnalyseBtn');
  if (!btn) return;
  btn.disabled = blocked;
  btn.title = blocked
    ? 'A batch is using the capture browser — it will free up when the batch finishes'
    : 'Ask the swing adviser for a one-week call on this share';
}

async function startBatch() {
  const items = selectedBatchRows().map((r) => ({ symbol: r.symbol, name: r.name }));
  if (!items.length) return;

  const btn = $('batchRunBtn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/stocks/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, ...readBrief() }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'could not start');
    renderBatch(data.state);
    toast(`Batch started — ${items.length} symbols queued`, 'ok');
  } catch (err) {
    toast(`Batch failed to start: ${err.message}`, 'bad');
    btn.disabled = false;
  }
}

function exportBatchCsv() {
  const rows = rankResults(batchState?.results || []);
  if (!rows.length) return;
  const head = ['Symbol', 'Name', 'Verdict', 'Grade', 'Conviction', 'Price', 'Entry', 'Stop', 'Target 1', 'R:R', 'Qty', 'Summary'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) => (r.ok
    ? [r.symbol, r.name, r.verdict, r.grade, r.conviction, r.price, r.entry, r.stop, r.target, r.rr, r.quantity, r.summary]
    : [r.symbol, r.name, 'FAILED', '', '', '', '', '', '', '', '', r.error]).map(esc).join(','));

  const blob = new Blob([[head.map(esc).join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `swing-calls-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* batch wiring */
if ($('batchPanel')) {
  const drop = $('batchDrop');
  const fileInput = $('batchFile');

  $('batchBrowse').onclick = () => fileInput.click();
  drop.onclick = (e) => { if (e.target === drop || e.target.closest('svg')) fileInput.click(); };
  fileInput.onchange = () => {
    if (fileInput.files?.[0]) readBatchCsv(fileInput.files[0]);
    fileInput.value = '';
  };

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) readBatchCsv(file);
  });

  document.querySelectorAll('.batch-quick [data-select]').forEach((b) => {
    b.onclick = () => selectBatch(b.dataset.select);
  });
  $('batchCheckAll').onchange = (e) => selectBatch(e.target.checked ? 'all' : 'none');
  $('batchRunBtn').onclick = startBatch;
  $('batchStopBtn').onclick = async () => {
    $('batchStopBtn').disabled = true;
    try {
      const r = await (await fetch('/api/stocks/batch/stop', { method: 'POST' })).json();
      renderBatch(r.state);
      toast('Batch will stop after the current symbol', 'ok');
    } finally {
      $('batchStopBtn').disabled = false;
    }
  };
  $('batchExportBtn').onclick = exportBatchCsv;
  $('batchClearBtn').onclick = () => {
    batchState = null;
    $('batchResults').hidden = true;
    $('batchMeta').textContent = 'Load a CSV of symbols';
  };

  let batchCollapsed = false;
  $('batchToggle').onclick = () => {
    batchCollapsed = !batchCollapsed;
    $('batchPanel').classList.toggle('collapsed', batchCollapsed);
    $('batchCaret').setAttribute('aria-expanded', String(!batchCollapsed));
  };

  // Restore a batch that is still running after a refresh.
  fetch('/api/stocks/batch')
    .then((r) => r.json())
    .then((state) => { if (state?.id) renderBatch(state); })
    .catch(() => {});
}

/* ---------- Stock Analysis History Logic ---------- */
let stockHistoryItems = [];
let currentStockRunId = null;

async function loadStockHistory() {
  const container = $('stocksHistory');
  if (!container) return;

  try {
    const res = await fetch('/api/stocks/history');
    if (res.ok) {
      stockHistoryItems = await res.json();
      try {
        localStorage.setItem('stocksHistory', JSON.stringify(stockHistoryItems));
      } catch {}
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    try {
      stockHistoryItems = JSON.parse(localStorage.getItem('stocksHistory') || '[]');
    } catch {
      stockHistoryItems = [];
    }
  }

  renderStockHistory(stockHistoryItems);
}

function renderStockHistory(items) {
  const container = $('stocksHistory');
  const countEl = $('stocksHistCount');
  const clearBtn = $('clearStocksHistBtn');
  if (!container) return;

  container.innerHTML = '';

  if (!items || !items.length) {
    if (countEl) countEl.textContent = '0 analyses';
    if (clearBtn) clearBtn.style.display = 'none';
    const empty = document.createElement('div');
    empty.className = 'stocks-hist-empty';
    empty.innerHTML = `No calls on the desk yet. Pick a share above and click <b>Advise Me</b>.`;
    container.appendChild(empty);
    return;
  }

  if (countEl) {
    countEl.textContent = `${items.length} analys${items.length === 1 ? 'is' : 'es'}`;
  }
  if (clearBtn) {
    clearBtn.style.display = 'inline-flex';
  }

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = `stock-hist-card ${item.id === currentStockRunId ? 'active' : ''}`;
    card.dataset.id = item.id;

    // Main Left Column
    const mainCol = document.createElement('div');
    mainCol.className = 'sh-main';

    const topRow = document.createElement('div');
    topRow.className = 'sh-top-row';

    const tickerSpan = document.createElement('span');
    tickerSpan.className = 'sh-ticker';
    tickerSpan.textContent = item.ticker || 'STOCK';
    topRow.appendChild(tickerSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'sh-name';
    nameSpan.textContent = item.target_name || item.ticker || 'Stock Analysis';
    topRow.appendChild(nameSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'sh-time';
    const d = item.at ? new Date(item.at) : new Date();
    timeSpan.textContent = `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmtTime(d)}`;
    topRow.appendChild(timeSpan);

    mainCol.appendChild(topRow);

    const summaryP = document.createElement('p');
    summaryP.className = 'sh-summary-text';
    summaryP.textContent =
      item.summary || item.report?.parsed?.analyst_takeaway || 'One-week swing call: setup, sized trade plan and exit date.';
    mainCol.appendChild(summaryP);

    card.appendChild(mainCol);

    // Metrics Middle Column
    const metricsCol = document.createElement('div');
    metricsCol.className = 'sh-metrics';

    // Verdict badge
    const rawVerdict = (item.verdict || 'NEUTRAL').toUpperCase();
    const verdictCls = rawVerdict.toLowerCase().replace(/_/g, '-');
    const verdictBadge = document.createElement('span');
    verdictBadge.className = `gf-verdict-badge ${verdictCls}`;
    verdictBadge.textContent = rawVerdict.replace(/_/g, ' ');
    metricsCol.appendChild(verdictBadge);

    const grade = (item.grade || item.report?.parsed?.trade_grade || '').toUpperCase();
    if (grade) {
      const gradeBadge = document.createElement('span');
      gradeBadge.className = `gf-grade-badge g-${grade.toLowerCase().replace('_', '-')}`;
      gradeBadge.textContent = grade.replace('A_PLUS', 'A+');
      gradeBadge.title = 'Setup grade';
      metricsCol.appendChild(gradeBadge);
    }

    // Conviction pill
    if (item.conviction) {
      const convPill = document.createElement('span');
      convPill.className = 'sh-conv';
      convPill.innerHTML = `Conviction <b>${item.conviction}%</b>`;
      metricsCol.appendChild(convPill);
    }

    // Price and change
    if (item.price && item.price !== '—') {
      const priceWrap = document.createElement('div');
      priceWrap.className = 'sh-price-wrap';

      const priceSpan = document.createElement('span');
      priceSpan.className = 'sh-price';
      priceSpan.textContent = item.price;
      priceWrap.appendChild(priceSpan);

      if (item.day_change) {
        const deltaSpan = document.createElement('span');
        const isUp = item.day_change.includes('+');
        const isDown = item.day_change.includes('-');
        deltaSpan.className = `delta ${isUp ? 'up' : isDown ? 'down' : 'flat'}`;
        deltaSpan.textContent = item.day_change;
        priceWrap.appendChild(deltaSpan);
      }
      metricsCol.appendChild(priceWrap);
    }

    card.appendChild(metricsCol);

    // Actions Right Column
    const actionsCol = document.createElement('div');
    actionsCol.className = 'sh-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'sh-view-btn';
    viewBtn.textContent = 'View Report';
    viewBtn.title = 'View the full one-week trade plan, sizing and fundamentals';
    viewBtn.onclick = (e) => {
      e.stopPropagation();
      selectStockHistoryItem(item);
    };
    actionsCol.appendChild(viewBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'sh-del-btn';
    delBtn.title = `Delete ${item.ticker || 'this analysis'}`;
    delBtn.setAttribute('aria-label', `Delete ${item.ticker || 'analysis'}`);
    delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      await deleteStockHistoryItem(item.id, card, item.ticker || item.target_name);
    };
    actionsCol.appendChild(delBtn);

    card.appendChild(actionsCol);

    // Clicking anywhere on card views report
    card.onclick = () => selectStockHistoryItem(item);

    container.appendChild(card);
  });
}

function selectStockHistoryItem(item) {
  currentStockRunId = item.id;
  document.querySelectorAll('.stock-hist-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.id === item.id);
  });

  window.__onDemandReportActive = true;
  const parsedData = item.report?.parsed || item.report || item;
  renderFinancialReport(parsedData, `History: ${item.ticker || item.target_name} at ${new Date(item.at || Date.now()).toLocaleTimeString()}`);

  if (item.shot?.url) {
    renderGfShot(item.shot);
  } else {
    renderGfShot(null);
  }
  renderGfChart(item.chart || null);

  if ($('gfInput')) {
    $('gfInput').value = item.ticker || '';
  }
  if ($('stocksHeaderActiveSymbol')) {
    $('stocksHeaderActiveSymbol').textContent = item.ticker || item.target_name || 'Stock';
  }

  $('gfReportPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast(`Loaded history for ${item.ticker || item.target_name}`, 'ok');
}

async function deleteStockHistoryItem(id, cardEl, label = 'Stock') {
  cardEl.classList.add('removing');

  try {
    const res = await fetch(`/api/stocks/history/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      console.warn('Server delete failed, updating local client');
    }
  } catch (err) {
    console.warn('Network error during delete:', err.message);
  }

  stockHistoryItems = stockHistoryItems.filter((x) => x.id !== id);
  try {
    localStorage.setItem('stocksHistory', JSON.stringify(stockHistoryItems));
  } catch {}

  setTimeout(() => {
    cardEl.remove();
    const countEl = $('stocksHistCount');
    const clearBtn = $('clearStocksHistBtn');
    if (countEl) countEl.textContent = `${stockHistoryItems.length} analys${stockHistoryItems.length === 1 ? 'is' : 'es'}`;
    if (!stockHistoryItems.length) {
      if (clearBtn) clearBtn.style.display = 'none';
      const container = $('stocksHistory');
      if (container) {
        container.innerHTML = `<div class="stocks-hist-empty">No calls on the desk yet. Pick a share above and click <b>Advise Me</b>.</div>`;
      }
    }
  }, 250);

  toast(`Deleted analysis for ${label}`, 'ok');
}

if ($('clearStocksHistBtn')) {
  $('clearStocksHistBtn').onclick = async () => {
    if (!confirm('Are you sure you want to delete all stock analysis history?')) return;
    try {
      await fetch('/api/stocks/history', { method: 'DELETE' });
    } catch {}
    stockHistoryItems = [];
    try {
      localStorage.removeItem('stocksHistory');
    } catch {}
    renderStockHistory([]);
    toast('All stock analysis history cleared', 'ok');
  };
}

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
  // Apply the response rather than waiting for the SSE tick: the button is icon-only
  // now, so its paused styling is the only feedback that the click landed.
  const r = await fetch(wasPaused ? '/api/resume' : '/api/pause', { method: 'POST' });
  if (r.ok) applyStatus(await r.json());
  toast(wasPaused ? 'Schedule resumed' : 'Schedule paused');
};

$('settingsIntervalSelect').onchange = async (e) => {
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
const closeModal = () => { $('clearModal').hidden = true; $('settingsModal').hidden = true; };

$('windowBtn').onclick = async () => {
  const isVis = $('windowBtn').dataset.visible === 'true';
  await fetch(`/api/window/${isVis ? 'hide' : 'show'}`, { method: 'POST' });
};

/* ---------- settings dialog ---------- */
const settingsModal = $('settingsModal');
const closeSettings = () => { settingsModal.hidden = true; };

$('settingsBtn').onclick = () => {
  settingsModal.hidden = false;
  $('settingsClose').focus();
};
$('settingsClose').onclick = closeSettings;
settingsModal.onclick = (e) => { if (e.target === settingsModal) closeSettings(); };

/** Provider section: which segment is live, the model in use, and the key row. */
function renderProviderSettings(s) {
  const provider = s.provider || 'ollama';
  document.querySelectorAll('#providerSegment .segment').forEach((btn) => {
    const on = btn.dataset.value === provider;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  if ($('geminiKeyRow')) $('geminiKeyRow').hidden = provider !== 'gemini';

  const model = s.model || s.ai?.model || (s.ai?.models || [])[0];
  if (model && $('modelName')) $('modelName').textContent = model;
  if ($('settingsFootMeta')) {
    $('settingsFootMeta').textContent = `${provider}${model ? ` · ${model}` : ''}`;
  }
  if ($('geminiKeyState') && provider === 'gemini') {
    $('geminiKeyState').innerHTML = s.ai?.ok
      ? 'A key is configured. Enter a new one to replace it for this session.'
      : 'No working key. Paste one here for this session, or add <code>GEMINI_API_KEY</code> to <code>.env</code> to persist it.';
  }
}

document.querySelectorAll('#providerSegment .segment').forEach((btn) => {
  btn.onclick = async () => {
    const provider = btn.dataset.value;
    try {
      const r = await fetch('/api/provider', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error || 'failed to change provider');
      applyStatus(s);
      renderProviderSettings(s);
      pollProvider();
      toast(`AI provider switched to ${provider}`, 'ok');
    } catch (e) {
      toast(`Could not switch provider: ${e.message}`, 'bad');
    }
  };
});

document.querySelectorAll('#themeSegment .segment').forEach((btn) => {
  btn.onclick = () => applyTheme(btn.dataset.value);
});

$('geminiKeyReveal').onclick = () => {
  const input = $('geminiKeyInput');
  input.type = input.type === 'password' ? 'text' : 'password';
  input.focus();
};

$('settingsClearBtn').onclick = () => {
  closeSettings();
  $('clearModal').hidden = false;
  $('clearCancel').focus();
};

$('saveGeminiKeyBtn').onclick = async () => {
  const apiKey = $('geminiKeyInput').value.trim();
  if (!apiKey) {
    toast('Please enter a valid API key', 'error');
    return;
  }
  try {
    const r = await fetch('/api/gemini/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const s = await r.json();
    if (!r.ok) throw new Error(s.error || 'failed to save API key');
    toast('Gemini API Key updated successfully!');
    $('geminiKeyInput').value = ''; // clear for security
  } catch (e) {
    toast(`Error saving API key: ${e.message}`, 'error');
  }
};

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

applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
resetView();
initScreen();
connect();
loadHistory();
loadStockHistory();
pollProvider();
refreshTrend();
setInterval(tickCountdown, 250);
setInterval(pollProvider, 15000);
setInterval(refreshTrend, 30000);
