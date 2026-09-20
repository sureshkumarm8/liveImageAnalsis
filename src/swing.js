/**
 * One-week swing-trade adviser: the prompt, the trading-window helper and the response
 * schema, shared by both providers so Ollama and Gemini always answer the same question
 * in the same shape.
 *
 * The horizon is deliberately short: a position must be opened *and* closed inside one
 * trading week (2-7 sessions). Everything here — sizing, targets, the time stop — is
 * written against that constraint.
 */

const IST = 'Asia/Kolkata';

const dayLabel = (d) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short' }).format(d);

const weekday = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'short' }).format(d);

/**
 * The next `count` NSE sessions starting today (weekends skipped; exchange holidays are
 * not tracked, so the model is told the list is calendar-derived).
 */
export function tradingWindow(now = new Date(), count = 5) {
  const [dd, mm, yyyy] = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('/');

  // Noon UTC ≈ 17:30 IST — far enough from either midnight that a day step never slips.
  let cursor = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 12, 0, 0));
  const sessions = [];
  while (sessions.length < count) {
    const wd = weekday(cursor);
    if (wd !== 'Sat' && wd !== 'Sun') sessions.push(dayLabel(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }

  return { today: dayLabel(now), sessions, exitBy: sessions[sessions.length - 1] };
}

export const SWING_SYSTEM_PROMPT = `You are a senior swing-trading adviser on an Indian (NSE) equity desk, speaking to one client about their own money.
You run a disciplined ONE-WEEK book: every position you recommend is opened and fully closed inside a single trading week (2-7 sessions).
You are paid for realised profit and for protecting capital — not for opinions — so "there is no trade here this week" is a valid and frequent answer.

WHAT YOU ARE LOOKING AT
- A high-resolution screenshot of Google Finance Beta for one instrument: last price, day change, day range, 52-week range, market cap, P/E, dividend yield, the price chart, financials and news.
- Usually also the right-hand Google Finance AI Research panel ("Ask anything"); its text may additionally be supplied to you verbatim.

HARD RULES
1. Use only numbers that are actually visible on the screen or present in the supplied research text. Never invent a price, level, ratio, date or statistic. Anything you needed but could not read goes into "data_gaps" and must pull "data_confidence" — and usually "conviction_score" — down.
2. Anchor every level to the last price shown, and keep the arithmetic consistent: risk_reward_ratio = (target_1 − entry midpoint) ÷ (entry midpoint − stop_loss), to one decimal. Every percentage you quote must recompute from the entry midpoint. Re-check the numbers before you answer; an inconsistent plan is worse than no plan.
3. Size the move to the horizon. In one week a large-cap typically travels 2-6%, a mid/small-cap 4-12%. Do not set a target that needs a move the stock has not produced in a week recently, and do not set a stop so tight that ordinary daily noise takes it out.
4. The stop is structural, not arbitrary: just beyond the nearest swing low, support shelf or breakout base — the level that actually proves the setup wrong.
5. Time is a stop too. Give a "time_stop": the session by which the position is closed if the move has not started, so capital is never parked in a dead trade past the week.
6. A binary event inside the window (earnings, a policy decision, an ex-date, a regulatory ruling) is a RISK for a one-week swing, not a reason to buy. Call it out explicitly whenever one is visible, and either size around it or stay out.
7. Check tradeability: thin volume, a wide 52-week range with no structure, or a price sitting mid-range with no level nearby all mean there is no edge this week. Say so.
8. If the instrument is an index, the screen is unreadable, or there is no identifiable setup, return NEUTRAL or AVOID with conviction below 40 and state plainly that the client should do nothing.
9. Never pad the answer with boilerplate, disclaimers or textbook definitions. Every sentence must carry a number, a level, a date or an instruction.

VERDICT (one-week horizon)
- STRONG_BUY — trend, momentum, volume and a catalyst inside the week all align, price sits right at a clean trigger so the stop is tight, reward:risk 1:2.5 or better. Rare; reserve it.
- TACTICAL_BUY — sound setup that still needs its trigger: a pullback into the entry zone or a confirmed breakout close. Reward:risk at least 1:2.
- WAIT_PULLBACK — you like the stock but price is extended into resistance right now and entering here pays badly. Name the exact level at which you would buy.
- NEUTRAL — mixed signals or a range with no edge this week.
- AVOID — momentum breaking down, price below a key support, illiquid, or event risk you cannot size around.

SETUP GRADE
Grade the setup A_PLUS / A / B / C / D on structure quality, clarity of the trigger, reward:risk and catalyst timing. Only A_PLUS and A deserve full size. C and D are not to be traded — if you grade C or D, the verdict cannot be STRONG_BUY.

POSITION SIZING — the part most advice skips, so do it properly
Work from the capital and risk budget stated in the request.
  risk_per_share = entry midpoint − stop_loss
  quantity       = floor(risk budget ÷ risk_per_share), then capped so capital deployed stays inside the stated maximum for one position
Report the quantity, the capital deployed, the rupee amount genuinely at risk, and which of the two limits (risk budget or position cap) is binding. If the stop is so wide that the quantity rounds to zero, say the trade is not sizeable for this account and downgrade the verdict.

EXIT PLAN
Spell out the management: where the first tranche is booked (typically 50-60% at target_1), when the stop moves to cost, how the remainder trails toward target_2, and the hard exit at the time stop. The client should never have to ask "and then what?".

WHEN THERE IS NO TRADE
Say it once and stop. Keep every "trade_plan" and "position_sizing" field to a single short line ("No position this week", "Not sizeable", "—"), put what is missing into "why_now", and put the level or event that would change your mind into "invalidation". Never pad a no-trade answer to look like work — a client reading "stay out" needs one clear reason, not a paragraph.

LENGTH AND FACTS
Every field is at most two sentences; "analyst_takeaway" at most six. Never repeat a sentence, never restate the brief back to the client, never hedge the same point twice.
Fill the factual fields from the screen whether or not you take the trade: "target_name" is the company name as printed (not the ticker), "ticker" is the symbol, and "current_price", "day_change", "day_range", "year_range", "market_cap", "pe_ratio", "dividend_yield" are copied exactly as shown. "time_horizon" always carries the session count and the exit-by date given in the brief — never "N/A".

TONE
Direct, numeric, imperative — an adviser who has to answer for the outcome. "analyst_takeaway" is your note to the client: what to do at the next open, at what price, in what quantity, with what stop, and the date you walk away.`;

/**
 * The client brief. Dates are resolved here (rather than left to the model) so the plan is
 * pinned to real sessions and the "exit by" date is never hallucinated.
 */
export function swingUserPrompt(context = {}) {
  const win = context.window || tradingWindow();
  const cur = context.currency || '₹';
  const money = (n) => `${cur}${Math.round(n).toLocaleString('en-IN')}`;

  const capital = Number(context.capital) > 0 ? Number(context.capital) : null;
  const riskPct = Number(context.riskPct) > 0 ? Number(context.riskPct) : 2;
  const maxAllocPct = Number(context.maxAllocPct) > 0 ? Number(context.maxAllocPct) : 25;

  const brief = [
    `- Today is ${win.today} (IST). Sessions available in this window: ${win.sessions.join(', ')} (calendar-derived — an exchange holiday may remove one).`,
    `- Horizon: enter and fully exit within the week, by ${win.exitBy} at the latest. Nothing longer, no "hold for a few months".`,
    '- Objective: take a defined, realistic profit out of THIS week\'s move while risking a fixed, known amount.',
    '- Instrument: NSE cash equity, delivery, long only. If the only decent setup here is a short, say so in "verdict_summary" and mark the long verdict AVOID.',
  ];

  if (capital) {
    brief.push(
      `- Capital available: ${money(capital)}. Maximum risk on this single trade: ${riskPct}% = ${money((capital * riskPct) / 100)}.`,
      `- Maximum capital in one position: ${maxAllocPct}% = ${money((capital * maxAllocPct) / 100)}. Size with both limits and report which one binds.`,
    );
  } else {
    brief.push(
      `- No account size was given: express sizing per ${money(100000)} of capital at ${riskPct}% risk and say the quantity scales linearly.`,
    );
  }

  if (context.symbol) brief.push(`- The screen was opened for: ${context.symbol}.`);

  return `Advise me on this one instrument as my swing-trading adviser, for a trade that lives and dies inside one week.

CLIENT BRIEF
${brief.join('\n')}

FIELD RULES
- "short_term_verdict" / "trade_grade" / "setup_type": the call, its quality and the pattern you are actually trading. "no_setup" is allowed and is the right answer more often than not.
- "why_now": one sentence on why this week and not next — the trigger, the level or the event that makes the timing specific.
- "time_horizon": the intended holding period in sessions plus the exit-by date, e.g. "3-5 sessions · exit by ${win.exitBy}".
- "conviction_score" (1-100): how strongly you would act. Above 75 only when trend, momentum, volume, catalyst and reward:risk all agree. "data_confidence" (1-100): how well you could actually read the screen.
- "trade_plan.entry_zone": a numeric range, e.g. "${cur}2,940 – ${cur}2,970". "entry_trigger": the condition that fires the order (a close above a level, a tap into support, a volume confirmation) — not "buy now" unless it genuinely is.
- "trade_plan.stop_loss": the structural level with the percentage risk, e.g. "${cur}2,880 (−2.4%)". "target_1" / "target_2": levels with percentage gains, both reachable inside the week.
- "trade_plan.risk_reward_ratio": "1 : 2.6" form, computed from your own numbers. "expected_move_pct": the realistic move you expect over the window.
- "trade_plan.time_stop": the dated hard exit, e.g. "Exit at the close of ${win.sessions[2] || win.exitBy} if target_1 has not been touched". "exit_plan": tranche booking, stop-to-cost, trailing rule.
- "position_sizing": quantity, capital deployed, risk per share, rupee risk, and the binding constraint — all arithmetically consistent with the entry and stop above.
- "technical_momentum": trend structure, the momentum read, volume/liquidity, distance from the 52-week high/low, nearest support and resistance, and how volatile the daily range is.
- "scorecard": integers 0-10 for trend, momentum, volume_liquidity, catalyst, risk_reward and valuation. Score honestly — a weak component is information, not something to smooth over.
- "bull_case" / "bear_case": the strongest case for and against the trade this week, one or two sentences each. "invalidation": what specifically proves the read wrong.
- "google_finance_ai_insights": the substance of the Google Finance AI Research panel — analyst sentiment, earnings takeaways, news — as concrete bullets, never "the panel discusses the stock".
- "near_term_catalysts": only events plausibly landing inside this window, dated where visible. "short_term_risks": what actually threatens the stop this week.
- "data_gaps": every number you wanted and could not read on the screen.
- "verdict_summary": two or three sentences a client can act on immediately. "analyst_takeaway": your one-paragraph adviser note, including quantity, stop and walk-away date.

Respond ONLY with JSON matching the schema.`;
}

/**
 * JSON-Schema (lowercase types) — used directly as Ollama's `format`, and uppercased for
 * Gemini's `responseSchema` by `toGeminiSchema`.
 */
export const SWING_SCHEMA = {
  type: 'object',
  properties: {
    target_name: { type: 'string', description: 'Company or instrument name exactly as shown.' },
    ticker: { type: 'string' },
    exchange: { type: 'string' },
    current_price: { type: 'string', description: 'Last traded price with its currency symbol.' },
    day_change: { type: 'string', description: 'Absolute and percent day change, signed.' },
    day_range: { type: 'string' },
    year_range: { type: 'string', description: '52-week low – high.' },
    market_cap: { type: 'string' },
    pe_ratio: { type: 'string' },
    dividend_yield: { type: 'string' },
    financial_health: { type: 'string', enum: ['strong', 'moderate', 'weak', 'neutral'] },

    // --- the one-week call -------------------------------------------------
    short_term_verdict: {
      type: 'string',
      enum: ['STRONG_BUY', 'TACTICAL_BUY', 'WAIT_PULLBACK', 'NEUTRAL', 'AVOID'],
    },
    trade_grade: { type: 'string', enum: ['A_PLUS', 'A', 'B', 'C', 'D'] },
    setup_type: {
      type: 'string',
      enum: [
        'breakout',
        'pullback_to_support',
        'trend_continuation',
        'reversal',
        'range_fade',
        'momentum_burst',
        'event_driven',
        'no_setup',
      ],
    },
    time_horizon: { type: 'string', description: 'Sessions held plus the exit-by date.' },
    conviction_score: { type: 'integer', description: '1-100, how strongly to act.' },
    data_confidence: { type: 'integer', description: '1-100, how readable the screen was.' },
    why_now: { type: 'string', description: 'One sentence: why this week specifically.' },

    trade_plan: {
      type: 'object',
      properties: {
        entry_zone: { type: 'string' },
        entry_trigger: { type: 'string' },
        stop_loss: { type: 'string' },
        target_1: { type: 'string' },
        target_2: { type: 'string' },
        risk_reward_ratio: { type: 'string' },
        expected_move_pct: { type: 'string' },
        time_stop: { type: 'string' },
        exit_plan: { type: 'string' },
      },
      required: [
        'entry_zone',
        'entry_trigger',
        'stop_loss',
        'target_1',
        'target_2',
        'risk_reward_ratio',
        'expected_move_pct',
        'time_stop',
        'exit_plan',
      ],
    },

    position_sizing: {
      type: 'object',
      properties: {
        quantity: { type: 'string', description: 'Shares to buy, given the stated capital and risk budget.' },
        capital_deployed: { type: 'string' },
        risk_per_share: { type: 'string' },
        risk_amount: { type: 'string', description: 'Money actually at risk if the stop is hit.' },
        binding_constraint: { type: 'string', description: 'Which limit caps the size: risk budget or position cap.' },
      },
      required: ['quantity', 'capital_deployed', 'risk_per_share', 'risk_amount', 'binding_constraint'],
    },

    technical_momentum: {
      type: 'object',
      properties: {
        trend_structure: { type: 'string' },
        momentum_read: { type: 'string' },
        volume_liquidity: { type: 'string' },
        proximity_to_52w: { type: 'string' },
        key_support: { type: 'string' },
        key_resistance: { type: 'string' },
        volatility_note: { type: 'string', description: 'How wide the daily range runs, and what that means for the stop.' },
      },
      required: [
        'trend_structure',
        'momentum_read',
        'volume_liquidity',
        'proximity_to_52w',
        'key_support',
        'key_resistance',
        'volatility_note',
      ],
    },

    scorecard: {
      type: 'object',
      description: 'Integers 0-10 per component.',
      properties: {
        trend: { type: 'integer' },
        momentum: { type: 'integer' },
        volume_liquidity: { type: 'integer' },
        catalyst: { type: 'integer' },
        risk_reward: { type: 'integer' },
        valuation: { type: 'integer' },
      },
      required: ['trend', 'momentum', 'volume_liquidity', 'catalyst', 'risk_reward', 'valuation'],
    },

    bull_case: { type: 'string' },
    bear_case: { type: 'string' },
    invalidation: { type: 'string' },

    google_finance_ai_insights: { type: 'array', items: { type: 'string' } },
    near_term_catalysts: { type: 'array', items: { type: 'string' } },
    short_term_risks: { type: 'array', items: { type: 'string' } },
    data_gaps: { type: 'array', items: { type: 'string' } },

    verdict_summary: { type: 'string' },
    financial_highlights: { type: 'array', items: { type: 'string' } },
    valuation_summary: { type: 'string' },
    catalysts_and_news: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    analyst_takeaway: { type: 'string' },
  },
  required: [
    'target_name',
    'current_price',
    'financial_health',
    'short_term_verdict',
    'trade_grade',
    'setup_type',
    'time_horizon',
    'conviction_score',
    'data_confidence',
    'why_now',
    'trade_plan',
    'position_sizing',
    'technical_momentum',
    'scorecard',
    'bull_case',
    'bear_case',
    'invalidation',
    'google_finance_ai_insights',
    'near_term_catalysts',
    'short_term_risks',
    'verdict_summary',
    'valuation_summary',
    'analyst_takeaway',
  ],
};

/**
 * Position sizing is arithmetic, and a vision model doing arithmetic in prose gets it
 * wrong — the same reason the intraday run cross-checks spot against the live feed.
 * So the model supplies the *levels* and this recomputes the size from them: quantity,
 * capital deployed, money at risk, which limit bound the size, and the reward:risk the
 * quoted levels actually imply.
 *
 * Mutates `parsed` in place and returns what it recomputed (null when the levels could
 * not be read, in which case the model's own wording is left untouched).
 */
export function applySizing(parsed, context = {}) {
  if (!parsed || typeof parsed !== 'object') return null;

  const capital = Number(context.capital) > 0 ? Number(context.capital) : null;
  const riskPct = Number(context.riskPct) > 0 ? Number(context.riskPct) : 2;
  const maxAllocPct = Number(context.maxAllocPct) > 0 ? Number(context.maxAllocPct) : 25;
  const cur = context.currency || '₹';
  if (!capital) return null;

  // Percentages and parenthesised asides ("(−2.4%)", "(of ₹2,50,000)") are commentary,
  // not levels.
  const levels = (text) => {
    if (!text) return [];
    const cleaned = String(text)
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[-+−]?\d[\d,.]*\s*%/g, ' ');
    return (cleaned.match(/\d[\d,]*(?:\.\d+)?/g) || [])
      .map((n) => Number(n.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n) && n > 0);
  };

  const plan = parsed.trade_plan || {};
  const entryLevels = levels(plan.entry_zone);
  const stopLevels = levels(plan.stop_loss);
  if (!entryLevels.length || !stopLevels.length) return null;

  const entry = (Math.min(...entryLevels) + Math.max(...entryLevels)) / 2;
  const stop = stopLevels[0];
  const riskPerShare = entry - stop;
  if (!(riskPerShare > 0) || !(entry > 0)) return null;

  const riskBudget = (capital * riskPct) / 100;
  const positionCap = (capital * maxAllocPct) / 100;
  const qtyByRisk = Math.floor(riskBudget / riskPerShare);
  const qtyByCap = Math.floor(positionCap / entry);
  const quantity = Math.max(0, Math.min(qtyByRisk, qtyByCap));

  const money = (n) => `${cur}${n.toLocaleString('en-IN', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
  const deployed = quantity * entry;
  const atRisk = quantity * riskPerShare;

  parsed.position_sizing = {
    quantity: quantity ? `${quantity.toLocaleString('en-IN')} shares` : 'Not sizeable — 0 shares',
    capital_deployed: quantity ? `${money(deployed)} of ${money(capital)}` : `${cur}0`,
    risk_per_share: money(riskPerShare),
    risk_amount: quantity
      ? `${money(atRisk)} (${((atRisk / capital) * 100).toFixed(2)}% of capital)`
      : `${cur}0`,
    binding_constraint: !quantity
      ? `The ${riskPct}% risk budget (${money(riskBudget)}) cannot absorb a ${money(riskPerShare)} stop — skip it or trade a smaller-priced name.`
      : qtyByRisk <= qtyByCap
        ? `Risk budget binds: ${riskPct}% of capital = ${money(riskBudget)}.`
        : `Position cap binds: ${maxAllocPct}% of capital = ${money(positionCap)}.`,
  };

  // The quoted levels define the reward:risk, so state the one they actually imply.
  const t1 = levels(plan.target_1)[0];
  if (t1 > entry) {
    parsed.trade_plan = { ...plan, risk_reward_ratio: `1 : ${((t1 - entry) / riskPerShare).toFixed(1)}` };
  }

  return { entry, stop, riskPerShare, quantity, deployed, atRisk };
}

/** Gemini wants the same schema with uppercase type names. */
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && typeof value === 'string') out.type = value.toUpperCase();
    else if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'items') out.items = toGeminiSchema(value);
    else out[key] = value;
  }
  return out;
}

export const SWING_SCHEMA_GEMINI = toGeminiSchema(SWING_SCHEMA);

export default { SWING_SYSTEM_PROMPT, swingUserPrompt, SWING_SCHEMA, SWING_SCHEMA_GEMINI, tradingWindow, applySizing };