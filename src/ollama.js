import config from './config.js';
import { isMarketWarm } from './market.js';
import { trendPrompt } from './trend.js';
import { quotePrompt, crossCheck } from './quote.js';
import { SWING_SYSTEM_PROMPT, swingUserPrompt, SWING_SCHEMA } from './swing.js';

const SYSTEM_PROMPT = `You are an expert Indian markets (NSE) intraday analyst and financial researcher.
You are given live screenshots captured at the same moment:
  - Fyers (or Zerodha Kite backup) TradingView chart of the NIFTY 50 index, showing today's intraday session
    in 1-minute candles (price action, candles, volume, any indicators visible).
  - Sensibull "OI vs Strike" chart for NIFTY options (Call OI and Put OI bars per strike, plus change-in-OI if shown).
  - (Optional) Google Finance overview / financial analysis screen for the monitored share or index (price action,
    key valuation metrics like P/E and market cap, financial statements, and company/market highlights).

You are also given SESSION MEMORY: a factual log of what earlier readings of these same charts
recorded today over the last 1, 5, 10, 15 and 30 minutes and across the whole session so far.

You are also given a LIVE PRICE FEED: the current NIFTY 50 spot read from an exchange quote API at the
same moment as the screenshots. That number is measured, not read off a picture. When it disagrees with
what you think the chart shows, the feed is right and you are wrong — use it for "spot_estimate" and
anchor every level you quote to it.

Read the actual numbers and labels visible in the images. Never invent data you cannot see.
If an image is unreadable, blank, still loading, or shows a login screen, say so explicitly in the relevant field,
set "readable" to false and keep confidence low.

Analyse them TOGETHER and IN CONTEXT of the session memory: confirm or contradict the price-action read using the
options open-interest structure, then check whether it continues or breaks the trend of the last few minutes.
If a Google Finance screen is present, extract its key financial metrics, valuation, company health, and catalyst summary into "financial_analysis".
Your output is read at a glance to make a fast intraday decision, so lead with a clear, specific call.
Be concrete: quote the strike numbers, price levels, financial metrics and OI observations you can actually see.
This is technical analysis for study purposes, not investment advice.`;

const USER_PROMPT = `You have now seen the attached images, the session memory and the live price feed.
Review the charts (price action, Sensibull OI structure) and Google Finance financial metrics if provided.
Give a single unified intraday decision view, quoting the actual price levels, strike numbers and OI
observations visible in the images, judged against the session memory and anchored to the live spot.
Respond ONLY with JSON matching the requested schema.

Field rules:
- "action": the decision right now. "long"/"short" only when price, OI and the recent trend agree;
  "wait" when the setup is not ready; "avoid" when it is choppy or unreadable; "exit" when the prior move is breaking down.
- "action_line": one imperative sentence a trader can act on, with the level in it,
  e.g. "Wait for a 1-min close above 24,350 before going long."
- "conviction": integer 1-100 — how strongly you'd act on "action" (separate from how well you could read the charts).
- "confidence": integer 1-100 — how clearly you could actually read both charts and how well the two sources agree.
  Use 70+ only when both images are crisp and point the same way.
- "momentum": how the move is behaving right now versus the session memory.
- "spot_estimate": the current NIFTY level. Use the LIVE PRICE FEED number verbatim when one was given,
  e.g. "24,310 (live NSE feed)"; only fall back to reading the chart if the feed says it is unavailable.
- "key_level": the single nearest level that decides the next move.
- "entry_zone"/"stop_loss"/"target": concrete numeric levels for the "action". Use "—" if action is wait/avoid.
- "invalidation": the level or event that proves this read wrong.
- "supports"/"resistances": specific numeric levels, each with a one-line reason.
- "highest_call_oi_strike"/"highest_put_oi_strike": the strike numbers with the tallest bars in the Sensibull chart.
- "expected_range": the intraday range implied by the OI walls, e.g. "24,200 - 24,500".
- "history_read": one concrete line per window describing what happened in that window and what it means now.
  Base it on the session memory numbers; if a window has no readings, say "no earlier readings".
- "trend_vs_now": does the current chart continue, stall or reverse the recent trend? Say which.
- "watch_for": concrete triggers to monitor. "risks": what would invalidate this read.
- "financial_analysis": (if Google Finance image is provided, otherwise leave as null or omit) an object with:
  - "target_name": company or index name
  - "current_price": live price displayed
  - "day_change": price change and %
  - "key_metrics": one-line summary of key metrics (Market Cap, P/E, 52W Range, etc.)
  - "financial_health": "strong" | "moderate" | "weak" | "neutral"
  - "valuation_summary": valuation summary based on visible numbers
  - "catalysts_and_risks": key catalysts or news
  - "analyst_takeaway": 1-2 sentence fundamental takeaway`;

const SCHEMA = {
  type: 'object',
  properties: {
    readable: { type: 'boolean' },
    action: { type: 'string', enum: ['long', 'short', 'wait', 'exit', 'avoid'] },
    action_line: { type: 'string' },
    conviction: { type: 'integer' },
    bias: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'choppy', 'unclear'] },
    momentum: { type: 'string', enum: ['accelerating', 'steady', 'fading', 'reversing', 'flat'] },
    confidence: { type: 'integer' },
    spot_estimate: { type: 'string' },
    key_level: { type: 'string' },
    entry_zone: { type: 'string' },
    stop_loss: { type: 'string' },
    target: { type: 'string' },
    invalidation: { type: 'string' },
    timeframe_seen: { type: 'string' },
    price_action: { type: 'string' },
    supports: { type: 'array', items: { type: 'string' } },
    resistances: { type: 'array', items: { type: 'string' } },
    oi_read: { type: 'string' },
    highest_call_oi_strike: { type: 'string' },
    highest_put_oi_strike: { type: 'string' },
    expected_range: { type: 'string' },
    trend_vs_now: { type: 'string' },
    history_read: {
      type: 'object',
      properties: {
        last_1m: { type: 'string' },
        last_5m: { type: 'string' },
        last_10m: { type: 'string' },
        last_15m: { type: 'string' },
        last_30m: { type: 'string' },
        day: { type: 'string' },
      },
      required: ['last_1m', 'last_5m', 'last_10m', 'last_15m', 'last_30m', 'day'],
    },
    combined_view: { type: 'string' },
    watch_for: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    financial_analysis: {
      type: 'object',
      properties: {
        target_name: { type: 'string' },
        current_price: { type: 'string' },
        day_change: { type: 'string' },
        key_metrics: { type: 'string' },
        financial_health: { type: 'string', enum: ['strong', 'moderate', 'weak', 'neutral'] },
        valuation_summary: { type: 'string' },
        catalysts_and_risks: { type: 'string' },
        analyst_takeaway: { type: 'string' },
      },
    },
    notes: { type: 'string' },
  },
  required: [
    'readable',
    'action',
    'action_line',
    'conviction',
    'bias',
    'momentum',
    'confidence',
    'spot_estimate',
    'key_level',
    'entry_zone',
    'stop_loss',
    'target',
    'invalidation',
    'price_action',
    'supports',
    'resistances',
    'oi_read',
    'highest_call_oi_strike',
    'highest_put_oi_strike',
    'expected_range',
    'trend_vs_now',
    'history_read',
    'combined_view',
    'watch_for',
    'risks',
  ],
};

export async function checkOllama() {
  const res = await fetch(`${config.ollama.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
  const body = await res.json();
  const names = (body.models || []).map((m) => m.name);
  return { ok: true, models: names, hasModel: names.includes(config.ollama.model) };
}

/** Which keep_alive to send: warm around trading hours, immediate unload otherwise. */
export const keepAliveFor = (now = new Date()) =>
  isMarketWarm(now) ? config.ollama.keepAlive : config.ollama.idleKeepAlive;

/** Ask Ollama to drop the model from memory right now. */
export async function unloadModel() {
  try {
    const res = await fetch(`${config.ollama.host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.ollama.model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Which models Ollama currently holds in memory, and how much they occupy. */
export async function loadedModels() {
  try {
    const res = await fetch(`${config.ollama.host}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, models: [] };
    const body = await res.json();
    const models = (body.models || []).map((m) => ({ name: m.name, bytes: m.size, expiresAt: m.expires_at }));
    return { ok: true, models, bytes: models.reduce((a, m) => a + (m.bytes || 0), 0) };
  } catch {
    return { ok: false, models: [] };
  }
}

function safeParse(content) {
  if (!content || typeof content !== 'string') return null;
  const clean = content.trim();
  try {
    return JSON.parse(clean);
  } catch {}

  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

const DESCRIPTIONS = {
  fyers: 'the Fyers TradingView chart of the NIFTY 50 index (today\'s intraday session, 1-minute candles)',
  kite: 'the Zerodha Kite TradingView chart of the NIFTY 50 index (today\'s intraday session, 1-minute candles, backup chart)',
  sensibull: 'the Sensibull "OI vs Strike" chart for NIFTY options (Call OI and Put OI per strike)',
  googlefinance: 'the Google Finance overview and financial analysis screen (price action, key stats including P/E and market cap, financials, and company/market analysis)',
};

/**
 * POST to /api/chat with `stream: true` and feed every delta to `onToken`, so the
 * dashboard can show the model working instead of a spinner. Ollama streams NDJSON:
 * one JSON object per line, the last one carrying `done: true` plus the timings.
 */
async function streamChat(body, onToken, signal) {
  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Ollama ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let final = null;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (obj.error) throw new Error(`Ollama: ${obj.error}`);
    const deltaThink = obj.message?.thinking || '';
    const deltaText = obj.message?.content || '';
    if (deltaThink) {
      thinking += deltaThink;
      onToken?.({ kind: 'thinking', delta: deltaThink });
    }
    if (deltaText) {
      content += deltaText;
      onToken?.({ kind: 'content', delta: deltaText });
    }
    if (obj.done) final = obj;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last piece may be a partial line; keep it for the next chunk.
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  return { content, thinking, final };
}

/** Ollama rejects `think` outright on models without the capability. */
const isThinkUnsupported = (err) => /think/i.test(err?.body || err?.message || '');

export async function analyse(shots, trend = null, quote = null, { onToken } = {}) {
  // Select primary chart (Fyers) if available and not awaiting login, otherwise fallback to Kite.
  let chartShot = shots.find((s) => s.id === 'fyers' && s.ok && s.base64 && !s.awaitingLogin);
  if (!chartShot) {
    chartShot = shots.find((s) => s.id === 'kite' && s.ok && s.base64 && !s.awaitingLogin);
  }
  if (!chartShot) {
    // If neither chart target is logged in / ready, pick fyers or kite for login/error reporting
    chartShot = shots.find((s) => s.id === 'fyers') || shots.find((s) => s.id === 'kite');
  }

  const oiShot = shots.find((s) => s.id === 'sensibull') || shots.find((s) => s.id !== 'fyers' && s.id !== 'kite' && s.id !== 'googlefinance');

  const gfShot = shots.find((s) => s.id === 'googlefinance' && s.ok && s.base64 && !s.awaitingLogin);

  const selectedShots = [chartShot, oiShot, gfShot].filter(Boolean);

  const blocked = selectedShots.filter((s) => s.awaitingLogin).map((s) => s.label);
  if (blocked.length) {
    return {
      ok: false,
      skipped: true,
      error: `Waiting for manual login in the browser window: ${blocked.join(', ')}. Analysis skipped for this cycle.`,
    };
  }

  const usable = selectedShots.filter((s) => s.ok && s.base64);
  if (usable.length === 0) {
    return { ok: false, error: 'No screenshots available to analyse.' };
  }

  // Each image goes in its own labelled turn — the model attributes them far more
  // reliably than when several images ride on a single message.
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  usable.forEach((s, i) => {
    messages.push({
      role: 'user',
      content: `IMAGE ${i + 1} is attached: ${DESCRIPTIONS[s.id] || s.label}. Look at it carefully and hold on to it.`,
      images: [s.base64],
    });
    messages.push({ role: 'assistant', content: `Noted IMAGE ${i + 1}.` });
  });
  // The rolling session memory goes in its own turn so the model treats it as given
  // fact rather than something to re-derive from the images.
  messages.push({ role: 'user', content: trendPrompt(trend) });
  messages.push({ role: 'assistant', content: 'Noted the session memory.' });
  // The live quote goes last of the fact turns — closest to the question, where it has
  // the most pull on the answer.
  messages.push({ role: 'user', content: quotePrompt(quote) });
  messages.push({
    role: 'assistant',
    content: quote?.ok
      ? `Noted. The live NIFTY 50 spot is ${quote.spot} and I will use exactly that for spot_estimate.`
      : 'Noted — no live feed, I will read the level off the chart carefully.',
  });
  const userPrompt = gfShot
    ? USER_PROMPT
    : USER_PROMPT.replace(
        /- "financial_analysis":[\s\S]*analyst_takeaway/,
        '- "financial_analysis": null (no Google Finance image provided).',
      );
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model: config.ollama.model,
    // Streamed so the dashboard can render the answer as it's written; the pieces are
    // reassembled here and parsed exactly as before.
    stream: true,
    think: config.ollama.think,
    format: SCHEMA,
    keep_alive: keepAliveFor(),
    options: { temperature: config.ollama.temperature },
    messages,
  };

  const started = Date.now();
  let stream;
  try {
    stream = await streamChat(body, onToken, AbortSignal.timeout(config.ollama.timeoutMs));
  } catch (err) {
    // Thinking is opt-in and model-specific — if this one can't do it, drop it and retry
    // rather than losing the whole cycle.
    if (body.think && isThinkUnsupported(err)) {
      try {
        stream = await streamChat({ ...body, think: false }, onToken, AbortSignal.timeout(config.ollama.timeoutMs));
      } catch (retryErr) {
        return { ok: false, error: `Ollama request failed: ${retryErr.message}`, durationMs: Date.now() - started };
      }
    } else {
      return { ok: false, error: `Ollama request failed: ${err.message}`, durationMs: Date.now() - started };
    }
  }

  const content = stream.content;
  const thinking = stream.thinking || null;
  const parsed = safeParse(content);
  const durationMs = Date.now() - started;

  if (!parsed) {
    return { ok: true, durationMs, raw: content, thinking, model: config.ollama.model, parsed: null, quote };
  }
  // Last line of defence: if the model still quoted a level that disagrees with the live
  // feed, overwrite it here so the stored run and the session memory stay truthful.
  const spotCheck = crossCheck(parsed, quote);
  return { ok: true, durationMs, raw: content, thinking, model: config.ollama.model, parsed, quote, spotCheck };
}

export async function analyseFinancialReport(shot, { onToken, context = {} } = {}) {
  if (!shot || !shot.ok || !shot.base64) {
    return { ok: false, error: 'No valid Google Finance screenshot available to analyse.' };
  }

  const userContent = shot.researchText
    ? `Here is the Google Finance Beta screenshot for the monitored share, showing the chart, fundamentals, and the right-side AI Research panel.\n\nExtracted AI Research panel text:\n"""\n${shot.researchText}\n"""`
    : 'Here is the Google Finance Beta screenshot for the monitored share (including the right-side AI Research panel):';

  const messages = [
    { role: 'system', content: SWING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: userContent,
      images: [shot.base64],
    },
    { role: 'assistant', content: 'Understood. I have inspected the Google Finance Beta screen and AI Research panel.' },
    { role: 'user', content: swingUserPrompt({ symbol: shot.symbol, ...context }) },
  ];

  const body = {
    model: config.ollama.model,
    stream: true,
    think: config.ollama.think,
    format: SWING_SCHEMA,
    keep_alive: keepAliveFor(),
    options: { temperature: config.ollama.temperature },
    messages,
  };

  const started = Date.now();
  let stream;
  try {
    stream = await streamChat(body, onToken, AbortSignal.timeout(config.ollama.timeoutMs));
  } catch (err) {
    if (body.think && isThinkUnsupported(err)) {
      try {
        stream = await streamChat({ ...body, think: false }, onToken, AbortSignal.timeout(config.ollama.timeoutMs));
      } catch (retryErr) {
        return { ok: false, error: `Ollama request failed: ${retryErr.message}`, durationMs: Date.now() - started };
      }
    } else {
      return { ok: false, error: `Ollama request failed: ${err.message}`, durationMs: Date.now() - started };
    }
  }

  const parsed = safeParse(stream.content);
  return {
    ok: true,
    durationMs: Date.now() - started,
    raw: stream.content,
    thinking: stream.thinking,
    parsed,
  };
}

export default { analyse, analyseFinancialReport, checkOllama, unloadModel, loadedModels };
