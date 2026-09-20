import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4321),
  intervalMs: num(process.env.INTERVAL_SECONDS, 60) * 1000,
  provider: process.env.AI_PROVIDER || 'ollama',

  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    temperature: num(process.env.GEMINI_TEMPERATURE, 0.3),
  },

  // Defaults for the one-week swing adviser on the Stocks screen. The dashboard can
  // override capital and risk per request; these are what a fresh browser starts with
  // and what the API falls back to when the body omits them.
  advisor: {
    capital: num(process.env.ADVISOR_CAPITAL, 100000),
    riskPct: num(process.env.ADVISOR_RISK_PCT, 2),
    maxAllocPct: num(process.env.ADVISOR_MAX_ALLOC_PCT, 25),
    currency: process.env.ADVISOR_CURRENCY || '₹',
    // How many NSE sessions the trade may live for. "Within a week" = 5.
    sessions: num(process.env.ADVISOR_SESSIONS, 5),
  },

  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'gemma4:latest',
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_SECONDS, 240) * 1000,
    temperature: num(process.env.OLLAMA_TEMPERATURE, 0.3),
    // Ask for the model's reasoning trace, streamed to the dashboard's live panel.
    // Only reasoning models (qwen3, deepseek-r1, gpt-oss…) support it; on anything else
    // the request is automatically retried without it.
    think: process.env.OLLAMA_THINK === 'true',
    // How long Ollama keeps the model in VRAM/RAM after a request. During market hours we
    // keep it warm (a cold load costs ~4s per cycle); outside them we unload immediately so
    // the ~10GB isn't held for nothing.
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || '5m',
    idleKeepAlive: process.env.OLLAMA_IDLE_KEEP_ALIVE || '0',
  },

  // Live NIFTY 50 spot, fetched alongside every capture and given to the model as ground
  // truth. Without it the model reads price off the chart image and often misreads digits.
  quote: {
    enabled: process.env.QUOTE_ENABLED !== 'false',
    // 'auto' tries NSE first (exchange's own number) and falls back to Yahoo.
    source: (process.env.QUOTE_SOURCE || 'auto').toLowerCase(),
    timeoutMs: num(process.env.QUOTE_TIMEOUT_SECONDS, 8) * 1000,
    cacheMs: num(process.env.QUOTE_CACHE_SECONDS, 5) * 1000,
    // Serve the previous quote for this long if every provider fails mid-session.
    maxStaleMs: num(process.env.QUOTE_MAX_STALE_SECONDS, 300) * 1000,
    // The model's chart reading may differ from the live feed by the larger of these
    // before it's treated as a misread and overwritten.
    tolerancePoints: num(process.env.QUOTE_TOLERANCE_POINTS, 25),
    tolerancePct: num(process.env.QUOTE_TOLERANCE_PCT, 0.1),
  },

  // Indian market hours. Captures only run inside this window; outside it the scheduler
  // sleeps until the next open and the model is unloaded.
  market: {
    tz: process.env.MARKET_TZ || 'Asia/Kolkata',
    open: process.env.MARKET_OPEN || '09:15',
    close: process.env.MARKET_CLOSE || '15:15',
    // Keep the model warm for a few minutes either side so the first/last runs aren't slow.
    // This margin affects model residency only, never whether a capture runs.
    marginMin: num(process.env.MARKET_MARGIN_MINUTES, 5),
  },

  browser: {
    headless: process.env.HEADLESS === 'true',
    profileDir: process.env.PROFILE_DIR || path.join(ROOT, 'data', 'browser-profile'),
    width: num(process.env.VIEWPORT_WIDTH, 1680),
    height: num(process.env.VIEWPORT_HEIGHT, 960),
    // Renders the page at N physical pixels per CSS pixel, so screenshots come out at
    // N× resolution (2 = "retina"). Axis labels, the last-price tag and OI strike numbers
    // are ~10px text — at 1× the vision model routinely misreads their digits.
    // Costs GPU memory in the browser; 3 is about the practical ceiling.
    deviceScaleFactor: Math.min(Math.max(num(process.env.DEVICE_SCALE_FACTOR, 2), 1), 4),
    settleMs: num(process.env.SETTLE_MS, 4000),
    navTimeoutMs: num(process.env.NAV_TIMEOUT_SECONDS, 90) * 1000,
    reloadEveryCycles: num(process.env.RELOAD_EVERY_CYCLES, 0),
    // Tuck the browser window into a screen corner at minimum size so it stays out of the
    // way while you work. Screenshots are unaffected: Playwright renders the page at the
    // configured viewport regardless of the window size. Ignored when headless.
    tuckWindow: process.env.TUCK_WINDOW !== 'false',
    tuckWidth: num(process.env.TUCK_WIDTH, 380),
    tuckHeight: num(process.env.TUCK_HEIGHT, 260),
    // Candle interval set on the Kite chart each cycle, as TradingView's data-value:
    // "1" = 1 minute, "5" = 5 minutes, "15", "60" = 1 hour, "1D" = 1 day. Empty = leave as-is.
    kiteInterval: process.env.KITE_INTERVAL === undefined ? '1' : process.env.KITE_INTERVAL,
    // Bottom date-range tab clicked on the Kite chart each cycle.
    // One of: 1d, 5d, 1m, 3m, 6m, 1yr, 5yr, All. Empty string = leave the chart alone.
    kiteRange: process.env.KITE_RANGE === undefined ? '1d' : process.env.KITE_RANGE,
    // Whether backup Kite chart capture is enabled.
    kiteEnabled: process.env.KITE_ENABLED !== 'false',
    // Whether Google Finance screen capture is enabled during routine runs (optional, defaults to false).
    googleFinanceEnabled: process.env.GOOGLE_FINANCE_ENABLED === 'true',
    // Target URL for Google Finance Beta
    googleFinanceUrl: process.env.GOOGLE_FINANCE_URL || 'https://www.google.com/finance/beta',
    // Timeout for waiting for Google Finance AI Research tool to generate insights
    // The AI Research panel streams its answer; the one-week brief is a longer question
    // than the old one, so give it time to finish before the screenshot is taken.
    googleFinanceResearchWaitMs: num(process.env.GOOGLE_FINANCE_RESEARCH_WAIT_MS, 12000),
  },

  // Every finished run is also mirrored into data/exports/ as plain JSON + PNGs, so a
  // dashboard that can't reach this machine (e.g. the Vercel build) can import the
  // analysis from the folder instead. Costs nothing: screenshots are hardlinked.
  archive: {
    enabled: process.env.ARCHIVE_ENABLED !== 'false',
    dir: process.env.ARCHIVE_DIR || path.join(ROOT, 'data', 'exports'),
  },

  paths: {
    data: path.join(ROOT, 'data'),
    shots: path.join(ROOT, 'data', 'shots'),
    history: path.join(ROOT, 'data', 'history.jsonl'),
    stocksHistory: path.join(ROOT, 'data', 'stocks-history.jsonl'),
    exports: process.env.ARCHIVE_DIR || path.join(ROOT, 'data', 'exports'),
    publicDir: path.join(ROOT, 'public'),
    // Where the "Save snapshots" button writes its PNGs.
    downloads: process.env.DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads'),
  },

  targets: [
    {
      id: 'fyers',
      label: 'Fyers — NIFTY 50 Chart (Main)',
      url: process.env.FYERS_URL || 'https://fyers.in/web/charts',
      loginHost: 'fyers.in',
    },
    {
      id: 'kite',
      label: 'Kite — NIFTY 50 Chart (Backup)',
      url: process.env.KITE_URL || 'https://kite.zerodha.com/markets/ext/chart/web/tvc/INDICES/NIFTY%2050/256265',
      loginHost: 'kite.zerodha.com',
      isBackup: true,
      backupFor: 'fyers',
    },
    {
      id: 'sensibull',
      label: 'Sensibull — OI vs Strike (NIFTY)',
      url: 'https://web.sensibull.com/open-interest/oi-vs-strike?tradingsymbol=NIFTY',
      loginHost: 'web.sensibull.com',
    },
    {
      id: 'googlefinance',
      label: 'Google Finance — Financial Analysis',
      url: process.env.GOOGLE_FINANCE_URL || 'https://www.google.com/finance/beta',
      loginHost: 'google.com',
    },
  ],

  // One-off screenshot set written to the Downloads folder by the dashboard button.
  // Each view says which already-open target page to use, and how to steer it first.
  snapshots: [
    {
      id: 'nifty-1min-1day',
      label: 'NIFTY 50 — 1 min candles, 1 day',
      target: 'fyers',
      fallbackTarget: 'kite',
      kite: { interval: '1', range: '1d' },
    },
    {
      id: 'nifty-1day-1year',
      label: 'NIFTY 50 — daily candles, 1 year',
      target: 'fyers',
      fallbackTarget: 'kite',
      // The 1yr range tab forces weekly candles, so the window is set as a custom
      // 12-month range instead, which leaves the daily interval alone.
      kite: { interval: '1D', months: 12 },
    },
    {
      id: 'sensibull-open-interest',
      label: 'Sensibull — Open Interest (OI vs Strike)',
      target: 'sensibull',
      url: 'https://web.sensibull.com/open-interest/oi-vs-strike?tradingsymbol=NIFTY',
    },
    {
      id: 'sensibull-multistrike-oi',
      label: 'Sensibull — Multistrike OI',
      target: 'sensibull',
      url: 'https://web.sensibull.com/open-interest/multistrike-oi?tradingsymbol=NIFTY',
      selectors: ['.chart-and-chart-inputs', '.sn-page--oigraphs'],
    },
    {
      id: 'google-finance-report',
      label: 'Google Finance — Financial Analysis',
      target: 'googlefinance',
    },
  ],

  historyLimit: num(process.env.HISTORY_LIMIT, 200),
  retainShots: num(process.env.RETAIN_SHOTS, 400),
};

export default config;
