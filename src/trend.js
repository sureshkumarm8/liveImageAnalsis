import { marketDate, todayOpenAt } from './market.js';

// Lookback windows shown in the dashboard and fed to the model as session memory.
// `minutes: null` means "since today's open".
export const WINDOWS = [
  { key: 'last_1m', label: '1 min', minutes: 1 },
  { key: 'last_5m', label: '5 min', minutes: 5 },
  { key: 'last_10m', label: '10 min', minutes: 10 },
  { key: 'last_15m', label: '15 min', minutes: 15 },
  { key: 'last_30m', label: '30 min', minutes: 30 },
  { key: 'day', label: 'Today', minutes: null },
];

const BIAS_ORDER = ['bullish', 'bearish', 'neutral', 'choppy', 'unclear'];

/**
 * Pull a numeric NIFTY level out of free text like "24,310 (last candle close)".
 * Only accepts values in a plausible index range so stray strike/percent numbers
 * in the same sentence don't get picked up.
 */
export function parseSpot(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (!text) return null;
  const matches = String(text).match(/\d[\d,]*(?:\.\d+)?/g) || [];
  for (const m of matches) {
    const n = Number(m.replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1000 && n <= 200000) return n;
  }
  return null;
}

const fmt = (n) => (n === null || n === undefined ? null : Number(n.toFixed(2)));
const sign = (n) => (n > 0 ? '+' : '');
const num = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Flatten stored runs into the few fields the trend view cares about. */
function toPoints(runs, now) {
  const today = marketDate(now);
  return runs
    .filter((r) => r?.startedAt && marketDate(new Date(r.startedAt)) === today)
    .map((r) => {
      const p = r.analysis?.parsed || null;
      // The live quote is measured; the model's chart reading is a guess. Prefer the
      // quote so the session memory, sparkline and day range are exact.
      const live = r.quote?.ok && Number.isFinite(r.quote.spot) ? r.quote.spot : null;
      return {
        id: r.id,
        t: new Date(r.startedAt).getTime(),
        spot: live ?? (p ? parseSpot(p.spot_estimate) : null),
        spotSource: live !== null ? r.quote.source : p ? 'model' : null,
        bias: (p?.bias || (r.analysis?.skipped ? 'unclear' : r.analysis?.ok ? 'unclear' : 'unclear')).toLowerCase(),
        action: p?.action ? String(p.action).toLowerCase() : null,
        confidence: Number(p?.confidence) || null,
        callOi: p?.highest_call_oi_strike || null,
        putOi: p?.highest_put_oi_strike || null,
        ok: Boolean(p),
      };
    })
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}

function summarise(points, { key, label, minutes }) {
  const withSpot = points.filter((p) => p.spot !== null);
  const first = withSpot[0] || null;
  const last = withSpot[withSpot.length - 1] || null;
  const change = first && last ? last.spot - first.spot : null;

  const counts = {};
  points.forEach((p) => {
    if (!p.ok) return;
    counts[p.bias] = (counts[p.bias] || 0) + 1;
  });
  const ranked = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || BIAS_ORDER.indexOf(a[0]) - BIAS_ORDER.indexOf(b[0]),
  );

  const spots = withSpot.map((p) => p.spot);
  return {
    key,
    label,
    minutes,
    samples: points.length,
    from: fmt(first?.spot ?? null),
    to: fmt(last?.spot ?? null),
    change: fmt(change),
    changePct: fmt(change !== null && first?.spot ? (change / first.spot) * 100 : null),
    high: spots.length ? fmt(Math.max(...spots)) : null,
    low: spots.length ? fmt(Math.min(...spots)) : null,
    direction: change === null ? 'flat' : change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat',
    dominantBias: ranked[0]?.[0] || null,
    biasCounts: counts,
    avgConfidence: (() => {
      const c = points.map((p) => p.confidence).filter(Boolean);
      return c.length ? Math.round(c.reduce((a, b) => a + b, 0) / c.length) : null;
    })(),
  };
}

/**
 * Build the rolling session memory: what the previous readings saw over the last
 * 1/5/10/15/30 minutes and across the whole day so far. Fed to the model so each
 * analysis is judged against its own recent history, and rendered in the dashboard.
 */
export function buildTrend(runs, now = new Date()) {
  const at = now.getTime();
  const points = toPoints(runs || [], now);
  const dayStart = Math.min(todayOpenAt(now), points[0]?.t ?? Infinity);

  const windows = {};
  WINDOWS.forEach((w) => {
    const from = w.minutes === null ? dayStart : at - w.minutes * 60000;
    windows[w.key] = summarise(
      points.filter((p) => p.t >= from && p.t <= at),
      w,
    );
  });

  const withSpot = points.filter((p) => p.spot !== null);
  const lastPoint = points[points.length - 1] || null;
  return {
    at: new Date(at).toISOString(),
    samples: points.length,
    spot: fmt(withSpot[withSpot.length - 1]?.spot ?? null),
    lastBias: lastPoint?.bias || null,
    lastAction: lastPoint?.action || null,
    // Trimmed series for the dashboard sparkline.
    series: withSpot.slice(-240).map((p) => ({ t: p.t, spot: fmt(p.spot), bias: p.bias })),
    windows,
    order: WINDOWS.map((w) => w.key),
  };
}

const describe = (w) => {
  if (!w.samples) return `${w.label}: no readings yet.`;
  const bits = [`${w.samples} reading${w.samples === 1 ? '' : 's'}`];
  if (w.from !== null && w.to !== null) {
    bits.push(
      w.change === null || w.change === 0
        ? `spot flat around ${num(w.to)}`
        : `spot ${num(w.from)} -> ${num(w.to)} (${sign(w.change)}${num(w.change)} pts${
            w.changePct !== null ? `, ${sign(w.changePct)}${w.changePct}%` : ''
          })`,
    );
    if (w.high !== null && w.low !== null && w.high !== w.low) bits.push(`high ${num(w.high)} / low ${num(w.low)}`);
  }
  const counts = Object.entries(w.biasCounts);
  if (counts.length) bits.push(`prior reads: ${counts.map(([b, c]) => `${b} x${c}`).join(', ')}`);
  if (w.avgConfidence) bits.push(`avg confidence ${w.avgConfidence}`);
  return `${w.label}: ${bits.join('; ')}.`;
};

/** The same trend object rendered as plain text for the model prompt. */
export function trendPrompt(trend) {
  if (!trend || !trend.samples) {
    return `SESSION MEMORY: no earlier readings today — this is the first analysis of the session. Judge the charts on their own and say so in "history_read".`;
  }
  const lines = trend.order.map((k) => `- ${describe(trend.windows[k])}`);
  return [
    'SESSION MEMORY — what the previous automated readings of these same charts recorded today',
    '(spot levels came from the live exchange quote feed at those times, so treat them as exact):',
    ...lines,
    trend.lastBias ? `- Previous reading's bias: ${trend.lastBias}${trend.lastAction ? `, action: ${trend.lastAction}` : ''}.` : '',
    '',
    'Use this memory to judge momentum (accelerating, steady, fading or reversing), whether the current chart',
    'continues or contradicts the recent trend, and where today\'s move sits in its intraday range.',
    'Fill "history_read" with one concrete line per window, and let it shape "action" and "momentum".',
  ]
    .filter(Boolean)
    .join('\n');
}

export default { buildTrend, trendPrompt, parseSpot, WINDOWS };
