import { GoogleGenAI } from '@google/genai';
import config from './config.js';
import { isMarketWarm } from './market.js';
import { trendPrompt } from './trend.js';
import { quotePrompt, crossCheck } from './quote.js';
import { SWING_SYSTEM_PROMPT, swingUserPrompt, SWING_SCHEMA_GEMINI } from './swing.js';

const SYSTEM_PROMPT = `You are an expert Indian markets (NSE) intraday analyst and financial researcher.
You are given live screenshots captured at the same moment:
  - Fyers (or Zerodha Kite backup) TradingView chart of the NIFTY 50 index, showing today's intraday session
    in 1-minute candles (price action, candles, volume, any indicators visible).
  - Sensibull "OI vs Strike" chart for NIFTY options (Call OI and Put OI bars per strike, plus change-in-OI if shown).
  - (Optional) Google Finance overview / financial analysis screen for the monitored share or index.

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
- "action_line": one imperative sentence a trader can act on, with the level in it.
- "conviction": integer 1-100 — how strongly you'd act on "action".
- "confidence": integer 1-100 — how clearly you could actually read both charts and how well the two sources agree.
- "momentum": how the move is behaving right now versus the session memory.
- "spot_estimate": the current NIFTY level. Use the LIVE PRICE FEED number verbatim when one was given.
- "key_level": the single nearest level that decides the next move.
- "entry_zone"/"stop_loss"/"target": concrete numeric levels for the "action". Use "—" if action is wait/avoid.
- "invalidation": the level or event that proves this read wrong.
- "supports"/"resistances": specific numeric levels, each with a one-line reason.
- "highest_call_oi_strike"/"highest_put_oi_strike": the strike numbers with the tallest bars in the Sensibull chart.
- "expected_range": the intraday range implied by the OI walls.
- "history_read": one concrete line per window describing what happened in that window and what it means now.
- "trend_vs_now": does the current chart continue, stall or reverse the recent trend?
- "watch_for": concrete triggers to monitor. "risks": what would invalidate this read.
- "financial_analysis": (if Google Finance image is provided, otherwise leave as null or omit) an object with target_name, current_price, day_change, key_metrics, financial_health, valuation_summary, catalysts_and_risks, and analyst_takeaway.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    readable: { type: 'BOOLEAN' },
    action: { type: 'STRING', enum: ['long', 'short', 'wait', 'exit', 'avoid'] },
    action_line: { type: 'STRING' },
    conviction: { type: 'INTEGER' },
    bias: { type: 'STRING', enum: ['bullish', 'bearish', 'neutral', 'choppy', 'unclear'] },
    momentum: { type: 'STRING', enum: ['accelerating', 'steady', 'fading', 'reversing', 'flat'] },
    confidence: { type: 'INTEGER' },
    spot_estimate: { type: 'STRING' },
    key_level: { type: 'STRING' },
    entry_zone: { type: 'STRING' },
    stop_loss: { type: 'STRING' },
    target: { type: 'STRING' },
    invalidation: { type: 'STRING' },
    timeframe_seen: { type: 'STRING' },
    price_action: { type: 'STRING' },
    supports: { type: 'ARRAY', items: { type: 'STRING' } },
    resistances: { type: 'ARRAY', items: { type: 'STRING' } },
    oi_read: { type: 'STRING' },
    highest_call_oi_strike: { type: 'STRING' },
    highest_put_oi_strike: { type: 'STRING' },
    expected_range: { type: 'STRING' },
    trend_vs_now: { type: 'STRING' },
    history_read: {
      type: 'OBJECT',
      properties: {
        last_1m: { type: 'STRING' },
        last_5m: { type: 'STRING' },
        last_10m: { type: 'STRING' },
        last_15m: { type: 'STRING' },
        last_30m: { type: 'STRING' },
        day: { type: 'STRING' },
      },
      required: ['last_1m', 'last_5m', 'last_10m', 'last_15m', 'last_30m', 'day'],
    },
    combined_view: { type: 'STRING' },
    watch_for: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    financial_analysis: {
      type: 'OBJECT',
      properties: {
        target_name: { type: 'STRING' },
        current_price: { type: 'STRING' },
        day_change: { type: 'STRING' },
        key_metrics: { type: 'STRING' },
        financial_health: { type: 'STRING', enum: ['strong', 'moderate', 'weak', 'neutral'] },
        valuation_summary: { type: 'STRING' },
        catalysts_and_risks: { type: 'STRING' },
        analyst_takeaway: { type: 'STRING' },
      },
    },
    notes: { type: 'STRING' },
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

const DESCRIPTIONS = {
  fyers: 'the Fyers TradingView chart of the NIFTY 50 index (today\'s intraday session, 1-minute candles)',
  kite: 'the Zerodha Kite TradingView chart of the NIFTY 50 index (today\'s intraday session, 1-minute candles, backup chart)',
  sensibull: 'the Sensibull "OI vs Strike" chart for NIFTY options (Call OI and Put OI per strike)',
  googlefinance: 'the Google Finance overview and financial analysis screen (price action, key stats including P/E and market cap, financials, and company/market analysis)',
};

let aiClient = null;
let lastApiKey = null;

function getClient() {
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is required but not set.');
  }
  if (!aiClient || lastApiKey !== config.gemini.apiKey) {
    aiClient = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    lastApiKey = config.gemini.apiKey;
  }
  return aiClient;
}

export async function checkProvider() {
  try {
    getClient();
    // With Gemini SDK we don't have an easy /tags endpoint to ping, so we just assume it's valid if we have an API key.
    // If you wanted you could do a very tiny test request here, but we'll return ok.
    return { ok: true, hasModel: true, models: [config.gemini.model] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function unloadModel() {
  // Cloud APIs don't hold local memory to unload.
  return { ok: true };
}

export async function loadedModels() {
  return { ok: true, models: [], bytes: 0 };
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

export async function analyse(shots, trend = null, quote = null, { onToken } = {}) {
  let chartShot = shots.find((s) => s.id === 'fyers' && s.ok && s.base64 && !s.awaitingLogin);
  if (!chartShot) {
    chartShot = shots.find((s) => s.id === 'kite' && s.ok && s.base64 && !s.awaitingLogin);
  }
  if (!chartShot) {
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

  const contents = [];
  
  usable.forEach((s, i) => {
    contents.push({ text: `IMAGE ${i + 1} is attached: ${DESCRIPTIONS[s.id] || s.label}. Look at it carefully.` });
    contents.push({
      inlineData: {
        mimeType: 'image/png',
        data: s.base64
      }
    });
  });

  contents.push({ text: trendPrompt(trend) });
  
  const quoteText = quote?.ok
      ? `The live NIFTY 50 spot is ${quote.spot} and I will use exactly that for spot_estimate.`
      : 'No live feed, I will read the level off the chart carefully.';
  contents.push({ text: quotePrompt(quote) + '\\n' + quoteText });
  const userPrompt = gfShot
    ? USER_PROMPT
    : USER_PROMPT.replace(
        /- "financial_analysis":[\s\S]*analyst_takeaway\./,
        '- "financial_analysis": null (no Google Finance image provided).',
      );
  contents.push({ text: userPrompt });

  const ai = getClient();
  const started = Date.now();
  let content = '';

  try {
    const responseStream = await ai.models.generateContentStream({
      model: config.gemini.model,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: config.gemini.temperature,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA
      }
    });

    for await (const chunk of responseStream) {
      if (chunk.text) {
        content += chunk.text;
        onToken?.({ kind: 'content', delta: chunk.text });
      }
    }
  } catch (err) {
    return { ok: false, error: `Gemini request failed: ${err.message}`, durationMs: Date.now() - started };
  }

  const durationMs = Date.now() - started;
  const parsed = safeParse(content);

  if (!parsed) {
    return { ok: true, durationMs, raw: content, thinking: null, model: config.gemini.model, parsed: null, quote };
  }

  const spotCheck = crossCheck(parsed, quote);
  return { ok: true, durationMs, raw: content, thinking: null, model: config.gemini.model, parsed, quote, spotCheck };
}

export async function analyseFinancialReport(shot, { onToken, context = {} } = {}) {
  if (!shot || !shot.ok || !shot.base64) {
    return { ok: false, error: 'No valid Google Finance screenshot available to analyse.' };
  }

  const contents = [
    { text: 'Here is the Google Finance Beta screenshot for the monitored share, showing both the price action/fundamentals and the right-side AI Research panel:' },
    {
      inlineData: {
        mimeType: 'image/png',
        data: shot.base64
      }
    }
  ];

  if (shot.researchText) {
    contents.push({
      text: `Directly extracted text from the Google Finance AI Research side panel:\n"""\n${shot.researchText}\n"""`
    });
  }

  contents.push({ text: swingUserPrompt({ symbol: shot.symbol, ...context }) });

  const ai = getClient();
  const started = Date.now();
  let content = '';

  try {
    const responseStream = await ai.models.generateContentStream({
      model: config.gemini.model,
      contents,
      config: {
        systemInstruction: SWING_SYSTEM_PROMPT,
        temperature: config.gemini.temperature,
        responseMimeType: 'application/json',
        responseSchema: SWING_SCHEMA_GEMINI
      }
    });

    for await (const chunk of responseStream) {
      if (chunk.text) {
        content += chunk.text;
        onToken?.({ kind: 'content', delta: chunk.text });
      }
    }
  } catch (err) {
    return { ok: false, error: `Gemini request failed: ${err.message}`, durationMs: Date.now() - started };
  }

  const parsed = safeParse(content);
  return {
    ok: true,
    durationMs: Date.now() - started,
    raw: content,
    thinking: null,
    parsed,
  };
}

export default { analyse, analyseFinancialReport, checkProvider, unloadModel, loadedModels };
