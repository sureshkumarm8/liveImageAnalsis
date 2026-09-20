import config from './config.js';
import { parseSpot } from './trend.js';

/**
 * Live NIFTY 50 spot, used as ground truth for the vision model.
 *
 * The model reads price off a chart image and regularly misreads digits, which then
 * poisons the session memory (every window's from/to/high/low comes from those reads).
 * So each cycle we fetch the real index level from a public quote API, hand it to the
 * model as fact, and correct its answer afterwards if it still drifted.
 *
 * Two independent sources, tried in order:
 *   nse    — www.nseindia.com/api/allIndices. The exchange's own number, so it matches
 *            the Kite chart tick for tick. Needs a browser-ish User-Agent and a cookie
 *            picked up from the home page.
 *   yahoo  — query1.finance.yahoo.com chart API for ^NSEI. No auth, very reliable,
 *            but can lag the exchange by a few seconds.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NSE_HOME = 'https://www.nseindia.com/';
const NSE_API = 'https://www.nseindia.com/api/allIndices';
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const round2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);
const numOrNull = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** NSE hands out a session cookie on any page hit; the JSON API 403s without it. */
let nseCookie = null;
let nseCookieAt = 0;
const COOKIE_TTL_MS = 10 * 60 * 1000;

async function nseCookieHeader(signal) {
  if (nseCookie && Date.now() - nseCookieAt < COOKIE_TTL_MS) return nseCookie;
  const res = await fetch(NSE_HOME, {
    signal,
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const jar = res.headers.getSetCookie?.() || [];
  const cookie = jar.map((c) => c.split(';')[0]).join('; ');
  // A 403 on the home page still sets usable cookies, so don't treat it as fatal.
  await res.arrayBuffer().catch(() => {});
  if (cookie) {
    nseCookie = cookie;
    nseCookieAt = Date.now();
  }
  return nseCookie || '';
}

async function fromNse(signal) {
  const cookie = await nseCookieHeader(signal).catch(() => '');
  const res = await fetch(NSE_API, {
    signal,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.nseindia.com/market-data/live-market-indices',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) {
    nseCookie = null;
    throw new Error(`NSE responded ${res.status}`);
  }
  const body = await res.json();
  const row = (body?.data || []).find((d) => String(d.indexSymbol).toUpperCase() === 'NIFTY 50');
  if (!row) throw new Error('NIFTY 50 not present in NSE response');
  const spot = numOrNull(row.last);
  if (spot === null) throw new Error('NSE returned no last price');

  return {
    source: 'nse',
    spot: round2(spot),
    open: round2(numOrNull(row.open)),
    high: round2(numOrNull(row.high)),
    low: round2(numOrNull(row.low)),
    previousClose: round2(numOrNull(row.previousClose)),
    change: round2(numOrNull(row.variation)),
    changePct: round2(numOrNull(row.percentChange)),
    quoteTime: null,
  };
}

async function fromYahoo(signal) {
  let lastErr = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/%5ENSEI?interval=1m&range=1d`, {
        signal,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Yahoo responded ${res.status}`);
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      const spot = numOrNull(meta?.regularMarketPrice ?? meta?.fulldayPrice);
      if (spot === null) throw new Error('Yahoo returned no market price');
      // meta.previousClose is often a stale session behind, which would make the day
      // change wildly wrong. fulldayChange tracks the live session, so derive from it.
      const change = numOrNull(meta?.fulldayChange);
      const changePct = numOrNull(meta?.fulldayChangePercent ?? meta?.regularMarketChangePercent);
      const prev = change === null ? numOrNull(meta?.previousClose) : spot - change;
      return {
        source: 'yahoo',
        spot: round2(spot),
        open: null,
        high: round2(numOrNull(meta?.regularMarketDayHigh)),
        low: round2(numOrNull(meta?.regularMarketDayLow)),
        previousClose: round2(prev),
        change: change === null && prev !== null ? round2(spot - prev) : round2(change),
        changePct: changePct !== null ? round2(changePct) : prev ? round2(((spot - prev) / prev) * 100) : null,
        quoteTime: meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Yahoo unavailable');
}

const PROVIDERS = { nse: fromNse, yahoo: fromYahoo };

function providerOrder() {
  const wanted = String(config.quote.source || 'auto').toLowerCase();
  if (wanted === 'auto') return ['nse', 'yahoo'];
  const rest = ['nse', 'yahoo'].filter((p) => p !== wanted);
  return PROVIDERS[wanted] ? [wanted, ...rest] : ['nse', 'yahoo'];
}

let cached = null;
let inFlight = null;

/**
 * Current NIFTY 50 spot. Results are cached briefly and concurrent callers share one
 * request, so a manual run firing next to a scheduled one can't double-hit the API.
 */
export async function getQuote({ force = false } = {}) {
  if (!config.quote.enabled) return { ok: false, disabled: true, error: 'live quote lookup disabled' };
  if (!force && cached?.ok && Date.now() - cached.fetchedMs < config.quote.cacheMs) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const errors = [];
    for (const name of providerOrder()) {
      try {
        const quote = await PROVIDERS[name](AbortSignal.timeout(config.quote.timeoutMs));
        cached = { ok: true, ...quote, fetchedAt: new Date().toISOString(), fetchedMs: Date.now() };
        return cached;
      } catch (err) {
        errors.push(`${name}: ${err.message}`);
      }
    }
    // Keep serving the last good number for a short while rather than nothing at all.
    if (cached?.ok && Date.now() - cached.fetchedMs < config.quote.maxStaleMs) {
      return { ...cached, stale: true, ageMs: Date.now() - cached.fetchedMs, error: errors.join('; ') };
    }
    return { ok: false, error: errors.join('; ') || 'no quote provider available' };
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

const fmt = (n) => (n === null || n === undefined ? null : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/** The live quote rendered as an authoritative fact turn for the model. */
export function quotePrompt(quote) {
  if (!quote?.ok) {
    return [
      'LIVE PRICE FEED: unavailable for this reading.',
      'Read the NIFTY 50 level off IMAGE 1 as carefully as you can — use the last-price tag on the',
      'right-hand price axis (the highlighted box), not a rounded gridline label.',
    ].join('\n');
  }

  const lines = [
    `LIVE PRICE FEED (authoritative, from the ${quote.source === 'nse' ? 'NSE' : 'Yahoo Finance'} quote API, fetched at the same moment as the screenshots):`,
    `- NIFTY 50 spot right now: ${fmt(quote.spot)}`,
  ];
  if (quote.previousClose !== null) lines.push(`- Previous close: ${fmt(quote.previousClose)}`);
  if (quote.change !== null) {
    lines.push(`- Change today: ${quote.change > 0 ? '+' : ''}${fmt(quote.change)} pts (${quote.changePct > 0 ? '+' : ''}${quote.changePct}%)`);
  }
  if (quote.high !== null && quote.low !== null) lines.push(`- Day high / low: ${fmt(quote.high)} / ${fmt(quote.low)}`);
  if (quote.stale) lines.push(`- Note: this quote is ${Math.round((quote.ageMs || 0) / 1000)}s old.`);

  lines.push(
    '',
    'This number is measured, not read off a picture — it OVERRIDES anything you think you see on the chart.',
    `Set "spot_estimate" to ${fmt(quote.spot)} exactly (you may add a short qualifier in brackets).`,
    'Anchor every other level you quote — supports, resistances, entry, stop, target, key level — around this',
    'spot, and make sure they are on the correct side of it. If the chart looks like it is at a very different',
    'level, trust this feed, say so in "notes", and lower "confidence".',
  );
  return lines.join('\n');
}

/**
 * Compare what the model said against the live feed and correct it if it drifted.
 * A misread spot is the single worst failure mode here, because it silently becomes
 * tomorrow's session memory — so the live number always wins.
 */
export function crossCheck(parsed, quote) {
  if (!parsed || !quote?.ok || quote.spot === null) return null;

  const model = parseSpot(parsed.spot_estimate);
  const tolerance = Math.max(config.quote.tolerancePoints, (quote.spot * config.quote.tolerancePct) / 100);
  const diff = model === null ? null : round2(model - quote.spot);
  const agrees = diff !== null && Math.abs(diff) <= tolerance;

  const check = {
    live: quote.spot,
    source: quote.source,
    model,
    diff,
    diffPct: diff === null ? null : round2((diff / quote.spot) * 100),
    tolerance: round2(tolerance),
    agrees,
    corrected: false,
  };

  if (agrees) return check;

  // Rewrite the field the whole app keys off, keeping the model's own reading visible.
  const qualifier =
    model === null
      ? `${quote.source.toUpperCase()} live feed`
      : `${quote.source.toUpperCase()} live feed; chart was misread as ${fmt(model)}`;
  parsed.spot_estimate = `${fmt(quote.spot)} (${qualifier})`;
  check.corrected = true;

  const warning =
    model === null
      ? `Spot corrected to the live ${quote.source.toUpperCase()} feed (${fmt(quote.spot)}); the model gave no readable level.`
      : `Spot corrected: model read ${fmt(model)} off the chart, live ${quote.source.toUpperCase()} feed says ${fmt(
          quote.spot,
        )} (${diff > 0 ? '+' : ''}${fmt(diff)} pts out).`;
  parsed.notes = parsed.notes ? `${warning} ${parsed.notes}` : warning;

  // The chart clearly wasn't read reliably, so the readability score can't stay high.
  const confidence = Number(parsed.confidence);
  if (Number.isFinite(confidence) && confidence > 50) parsed.confidence = 50;

  return check;
}

export default { getQuote, quotePrompt, crossCheck };
