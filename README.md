# Live Market Vision

Captures the **Zerodha Kite NIFTY 50 chart** and the **Sensibull OI vs Strike** chart every
minute *during market hours*, sends both screenshots — plus a rolling memory of what the last
1/5/10/15/30 minutes and the whole session looked like — to a **local Ollama vision model**
(`gemma4`) for one combined intraday read, and streams everything to a live web dashboard.

Nothing leaves your machine — screenshots and analysis stay local.

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally with a vision model:
  ```bash
  ollama pull gemma4
  ollama serve   # usually already running
  ```

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # optional, defaults work
npm start
```

Then open **http://localhost:4321**.

## First run — logging in

A Chromium window opens with tabs for the targets. The sites need a session:

| Tab | Why |
| --- | --- |
| Fyers | Main source for NIFTY 50 chart |
| Kite | Backup source for NIFTY 50 chart |
| Sensibull | Index (NIFTY) option-chain data requires a broker login |
| Google Finance | Financial analysis, key metrics (P/E, Market Cap), quarterly trends & news for any share |

Log in **manually in that window**. The session is stored in `data/browser-profile/` and reused
on every later start, so you only do this once (until the broker expires the session).

If Fyers requires a login or is unavailable, the app automatically falls back to Kite for the NIFTY 50 chart analysis.
While a login screen is detected on active targets, the app captures screenshots but **skips the model call**
(the dashboard shows a `login needed` badge). As soon as you're logged in it re-navigates to the
target views automatically and resumes analysis on the next cycle.

Sensibull tends to restore its own last-used ticker — the app detects this and switches the
symbol back to NIFTY on every cycle. It also recovers automatically from Sensibull's
intermittent "Oops! Something went wrong" page by clicking Retry.

## Dashboard

- All live screenshots side by side (click to zoom), with per-tab **Reload** buttons
- **Google Finance research & financial analysis bar** — steer the Google Finance automation window to any specific share (e.g. `RELIANCE:NSE`, `TCS`, `INFY`, `HDFCBANK`, or custom Google Finance URL) with one-click quick presets.
- **Adviser's note — one-week swing call** (Stocks screen) — see [One-week swing adviser](#one-week-swing-adviser).
- **Batch analysis** — import a screener CSV, preview every row, pick the ones you want, and get a
  ranked shortlist of one-week calls — see [Batch](#batch--screen-a-whole-watchlist).
- **Collapse/expand** screenshot panels by clicking titles or carets. The choice is remembered in `localStorage`.
- **Decision snapshot** — the call (`Go long` / `Go short` / `Wait` / `Exit` / `Stand aside`)
  with a one-line actionable instruction, conviction and chart-confidence meters, spot with the
  day's move, bias, momentum, key level, expected range and day range
- **Trade plan strip** — entry, stop, target and invalidation at a glance
- **Session memory** — a sparkline of today's readings plus a card per lookback window
  (**1, 5, 10, 15, 30 min and the whole day**) showing the spot move, the mix of earlier biases
  and the model's note for that window, and a "now vs trend" line
- Combined view, price action, OI read, supports, resistances, watch-for, risks
- **History** rows showing time, action, bias and the 5-minute move
- Countdown ring to the next capture, **Run now**, **Pause/Resume**
- **Save snapshots** (⋯ menu) captures configured charts and writes them straight to your
  Downloads folder — see [Snapshot button](#snapshot-button)
- **Clear data** (⋯ menu or Settings → Data) wipes every stored run and all captured
  screenshots from disk, after a confirmation — it cannot be undone
- Scrollable history — click any row to pin that run; press <kbd>Esc</kbd> to go back to live
- Raw model JSON in a collapsible panel

### Topbar and settings

The topbar carries only what you act on: the screen tabs, a quiet status strip (scheduler,
provider, market window, live NIFTY), the countdown ring, **Run now**, **Pause**, **Show/hide
browser**, a ⋯ menu for one-off actions, and **Settings**. As the window narrows the status words
drop before the dots do, then the button labels, so the row never wraps onto the brand.

Everything persistent lives in **Settings** (gear icon, <kbd>Esc</kbd> to close):

| Section | Controls |
| --- | --- |
| Capture | Interval (**1, 2, 5, 10, 15 min**, re-aligned to the wall-clock boundary immediately; resets to `INTERVAL_SECONDS` on restart), Kite backup chart, Google Finance on every cycle |
| AI provider | Ollama / Gemini, the model in use, and the Gemini API key (held for the session — put it in `.env` to persist it) |
| Appearance | Dark / light theme, remembered in `localStorage` |
| Data | Clear stored data |

## Configuration (`.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4321` | Dashboard port |
| `INTERVAL_SECONDS` | `60` | Starting capture cadence, aligned to wall-clock boundaries. Change it live from the dashboard's interval dropdown |
| `OLLAMA_HOST` | `http://localhost:11434` | |
| `OLLAMA_MODEL` | `gemma4:latest` | Must have the `vision` capability |
| `OLLAMA_TIMEOUT_SECONDS` | `240` | |
| `OLLAMA_TEMPERATURE` | `0.3` | |
| `OLLAMA_THINK` | `false` | Ask for the model's reasoning trace and stream it to the live panel. Only reasoning models support it; others are retried automatically without it |
| `OLLAMA_KEEP_ALIVE` | `5m` | How long Ollama keeps the model in memory **during market hours** |
| `OLLAMA_IDLE_KEEP_ALIVE` | `0` | Keep-alive used outside market hours — `0` unloads immediately |
| `MARKET_OPEN` / `MARKET_CLOSE` | `09:15` / `15:15` | IST market window — captures run only inside it |
| `MARKET_TZ` | `Asia/Kolkata` | |
| `MARKET_MARGIN_MINUTES` | `5` | Keep the model warm this many minutes either side (does not run captures) |
| `HEADLESS` | `false` | **Keep `false`.** Headless invalidates the Kite session server-side (Zerodha rejects the `HeadlessChrome` UA), so you get logged out. Use `TUCK_WINDOW` instead |
| `TUCK_WINDOW` | `true` | Shrink the capture window and push it into the screen corner so it stays out of your way. Screenshots are unaffected |
| `TUCK_WIDTH` / `TUCK_HEIGHT` | `380` / `260` | Size of the tucked window (macOS enforces a ~500×375 minimum) |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1600` / `950` | |
| `DEVICE_SCALE_FACTOR` | `2` | Pixels captured per CSS pixel. `2` gives retina-sharp price/OI labels for the vision model; drop to `1` to save memory, raise to `3` if numbers still get misread |
| `SETTLE_MS` | `4000` | Wait after navigation before capturing |
| `KITE_INTERVAL` | `1` | Candle interval (TradingView value; `1` = 1 minute). Empty = leave as-is |
| `KITE_RANGE` | `1d` | Bottom date-range tab: `1d`, `5d`, `1m`, `3m`, `6m`, `1yr`, `5yr`, `All`. Empty = leave as-is |
| `KITE_ENABLED` | `true` | Enable or disable backup Kite chart capture |
| `GOOGLE_FINANCE_ENABLED` | `true` | Enable or disable Google Finance capture & financial analysis |
| `GOOGLE_FINANCE_URL` | `https://www.google.com/finance/beta` | Target Google Finance URL or stock quote view |
| `GOOGLE_FINANCE_RESEARCH_WAIT_MS` | `12000` | How long the Google Finance AI Research panel is given to finish streaming its answer before the screenshot is taken |
| `ADVISOR_CAPITAL` | `100000` | Capital the swing adviser sizes positions against (seeds the dashboard's brief fields) |
| `ADVISOR_RISK_PCT` | `2` | Maximum % of capital risked on one trade (entry → stop) |
| `ADVISOR_MAX_ALLOC_PCT` | `25` | Maximum % of capital in a single position |
| `ADVISOR_SESSIONS` | `5` | Trading sessions the swing may live for — `5` is "inside one week" |
| `RELOAD_EVERY_CYCLES` | `0` | Hard-reload both pages every N cycles (`0` = never) |
| `HISTORY_LIMIT` | `200` | Runs kept in memory / served to the UI |
| `RETAIN_SHOTS` | `400` | PNGs kept on disk before pruning |
| `DOWNLOADS_DIR` | `~/Downloads` | Where the **Save snapshots** button writes its PNGs |
| `QUOTE_ENABLED` | `true` | Fetch the live NIFTY 50 spot each cycle and use it as ground truth. `false` puts the model back on chart-reading alone |
| `QUOTE_SOURCE` | `auto` | `auto` = NSE first, Yahoo as fallback. Force one with `nse` or `yahoo` |
| `QUOTE_TIMEOUT_SECONDS` | `8` | Per-provider timeout; a failed quote never fails the run |
| `QUOTE_CACHE_SECONDS` | `5` | Cache window shared by the scheduler and the dashboard pill |
| `QUOTE_MAX_STALE_SECONDS` | `300` | Keep serving the last good quote this long if every provider fails |
| `QUOTE_TOLERANCE_POINTS` / `QUOTE_TOLERANCE_PCT` | `25` / `0.1` | How far the model's chart reading may differ from the live feed (larger of the two) before it is treated as a misread and overwritten |

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | Scheduler, Ollama, Google Finance and per-tab login state |
| `GET /api/latest` | Most recent run |
| `GET /api/quote` | Live NIFTY 50 spot from the exchange quote API (`?force=1` bypasses the cache) |
| `GET /api/trend` | Live session memory: 1/5/10/15/30-min and whole-day windows |
| `GET /api/history?limit=50` | Recent runs, newest first |
| `GET /api/run/:id` | One run |
| `DELETE /api/history` | Delete all stored runs and screenshots |
| `GET /api/archive` | Manifest of the portable export in `data/exports/` |
| `GET /api/archive/day/:date` | One day's export bundle (`?embedded=1` for the self-contained copy) |
| `POST /api/archive/rebuild` | Re-export everything — body `{ "embed": true, "date": "2026-09-15" }` (both optional) |
| `POST /api/archive/embed` | Write `vision-<date>.embedded.json` — body `{ "date": "2026-09-15" }` |
| `DELETE /api/archive` | Delete the export folder (captured history is untouched) |
| `GET /exports/*` | The export folder, served as static files |
| `GET /api/events` | SSE stream (`status`, `run`, `error-event`, `analysis-start`, `analysis-token`, `analysis-end`) |
| `POST /api/run-now` | Trigger a capture + analysis immediately |
| `POST /api/snapshots` | Capture the configured snapshot views and save them to `DOWNLOADS_DIR` |
| `POST /api/pause` / `POST /api/resume` | Control the loop |
| `POST /api/interval` | Set the cadence live — body `{ "minutes": 1 \| 2 \| 5 \| 10 \| 15 }` |
| `POST /api/reload/:id` | Re-navigate target tab (`fyers`, `kite`, `sensibull`, `googlefinance`) |
| `POST /api/kite-toggle` | Turn Kite backup capture on or off |
| `POST /api/google-finance/toggle` | Turn Google Finance capture on or off |
| `POST /api/google-finance/target` | Navigate Google Finance window to a share or URL — body `{ "query": "RELIANCE:NSE" }` |
| `POST /api/google-finance/analyse` | Capture the Google Finance AI Research screen and return a sized one-week swing call — body `{ "query": "TATAMOTORS:NSE", "capital": 250000, "riskPct": 1.5, "maxAllocPct": 30 }` (all optional) |
| `GET /api/stocks/batch` | State of the running (or last) batch |
| `POST /api/stocks/batch` | Start a batch — body `{ "items": [{ "symbol": "QUINT", "name": "Quint Digital" }], "capital": 250000, "riskPct": 1.5 }`. Max 60 symbols, one batch at a time |
| `POST /api/stocks/batch/stop` | Stop after the symbol currently being analysed |
| `POST /api/window/show` / `POST /api/window/hide` | Bring the capture browser window back, or tuck it away |
| `POST /api/ollama/unload` | Drop the model from memory immediately |
| `GET /api/dom/:id?selector=&mode=controls` | Read-only DOM inspector for tuning selectors |

## Portable export (use the analysis without this engine)

This engine can only run on your own machine, so a deployed dashboard (e.g. the Vercel build of
`FyersNifty50Live`) can never call it. To bridge that, **every finished run is also mirrored into a
plain folder** that a browser can read straight off disk:

```
data/exports/
  index.json                             manifest: one entry per day + latestRunId
  vision-2026-09-15.json                 that day's runs (verdicts, quotes, shot filenames)
  runs/2026-09-15/run-2026-09-15T09-16-00.json   one immutable file per run, timestamped
  shots/2026-09-15/*.png                 the screenshots those runs point at
```

The day bundle is rewritten after every capture, while each `runs/<date>/run-*.json` is written
once and never touched again. That is what makes the dashboard's auto-sync cheap: it reads the
tiny `index.json`, compares `latestRunId` with what it already has, and when something *is* new it
only parses the handful of new run files instead of the whole day.

Screenshots are **hardlinked**, so the export costs no extra disk and survives `RETAIN_SHOTS`
pruning of `data/shots/`.

In the dashboard: **Vision → Import data → Choose exports folder**, once. The files are parsed in
the browser and cached in IndexedDB — nothing is uploaded — and from then on the screen re-scans
that folder on a timer, so runs captured later show up on their own.

### Exporting by hand

```bash
npm run export                        # re-export everything in history.jsonl
npm run export -- --date=2026-09-15   # just one day
npm run export -- --embed             # also write one self-contained file per day
```

`--embed` produces `vision-<date>.embedded.json` with every screenshot inlined as a data URL: a
single file you can copy to another machine and drop onto the dashboard's import panel. It is
considerably larger (roughly 1.3x the PNGs), so the folder export is preferred when both are
available — the importer skips the embedded copy automatically in that case.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHIVE_ENABLED` | `true` | Set to `false` to stop mirroring runs into `data/exports/` |
| `ARCHIVE_DIR` | `data/exports` | Where the export folder lives |

## Chart timeframe

The Kite tab captures only the chart pane (`.chart-frame`), and Sensibull captures only its
chart block — so the model sees charts, not surrounding UI clutter.

Every cycle the app also drives the Kite chart controls so the view can't drift:

1. **Candle interval** — opens the toolbar interval menu (the `D` / `1m` button) and selects
   **1 minute** (`KITE_INTERVAL=1`).
2. **Date range** — clicks the bottom **`1d`** tab (`KITE_RANGE=1d`), so you see today's full
   09:15–15:30 session.

The toolbar shows an abbreviated label that doesn't match TradingView's internal value, so the
app learns the label after the first successful switch and then skips redundant clicking.

To use a different timeframe, set `KITE_INTERVAL` to the TradingView value:

| Value | Meaning | | Value | Meaning |
| --- | --- | --- | --- | --- |
| `5S` | 5 seconds | | `30` | 30 minutes |
| `1` | 1 minute | | `60` | 1 hour |
| `5` | 5 minutes | | `1D` | 1 day |
| `15` | 15 minutes | | `1W` | 1 week |

Set either variable to an empty string to leave that control untouched.

## Snapshot button

**Save snapshots** in the topbar grabs a fixed set of four charts in one go and writes them as
PNGs into your Downloads folder (`DOWNLOADS_DIR`), named `<YYYYMMDD-HHMMSS>-<view>.png`:

| File suffix | What it shows |
| --- | --- |
| `nifty-1min-1day` | NIFTY 50, 1-minute candles, today's session |
| `nifty-1day-1year` | NIFTY 50, daily candles, last 12 months |
| `sensibull-open-interest` | Sensibull *OI vs Strike* |
| `sensibull-multistrike-oi` | Sensibull *Multi Strike OI* |

It reuses the already-open, logged-in tabs, so nothing extra has to be signed into. The whole
set takes ~25–30 s; the button and **Run now** are disabled while it works, and captures are
serialised so a scheduled run can never interleave with it. Afterwards both tabs are put back
on the view the scheduler expects.

The year view can't use the bottom **`1yr`** tab, because TradingView forces weekly candles for
that range. Instead the app sets the daily interval and then applies a 12-month window through
the toolbar's **Go to → Custom range** dialog, which leaves the interval alone. The views are
defined in `config.snapshots` in `src/config.js` if you want to add or change any.

## Layout

```
src/config.js      configuration + capture targets
src/capture.js     Playwright persistent browser, per-site login/recovery hooks
src/ollama.js      vision prompt, JSON schema, Ollama call
src/gemini.js      the same two calls against the Gemini API
src/ai.js          picks the provider from AI_PROVIDER
src/swing.js       one-week swing adviser: prompt, trading window, response schema
src/batch.js       runs the swing analysis over a watchlist, one symbol at a time
src/quote.js       live NIFTY 50 spot (NSE → Yahoo) + spot cross-check
src/scheduler.js   the every-minute loop
src/store.js       JSONL run history + screenshot pruning
src/server.js      Express API + SSE
public/            dashboard
data/              browser profile, screenshots, history.jsonl (git-ignored)
```

## Live model stream

The analysis takes tens of seconds, so it isn't hidden behind a spinner. The Ollama call is
streamed, and every token is relayed over SSE to a panel at the top of the decision snapshot
that types the answer out as the model writes it, with the elapsed time, a character count and
the name of the schema field currently being filled in.

Set `OLLAMA_THINK=true` with a reasoning model and the panel shows the actual reasoning trace
instead of the JSON; the trace is also kept with the run and shown under **Raw model output**.
Models without the capability reject the option outright, so the request is retried once without
it automatically — no configuration needed to switch models.

## Live price cross-check

A vision model reading price off a chart image gets digits wrong, and a wrong spot is the
worst failure here: it silently becomes the session memory that every later reading is judged
against. So price is never left to the model alone.

Every cycle, at the same moment the screenshots are taken, the real NIFTY 50 level is fetched
from a public quote API — `nseindia.com/api/allIndices` first (the exchange's own number, so it
matches the Kite chart), falling back to Yahoo Finance's `^NSEI` if NSE is unreachable. That
number is then used three times over:

1. **Before the analysis** — it's given to the model as an authoritative fact turn, with an
   instruction to use it verbatim for `spot_estimate` and to anchor every support, resistance,
   entry, stop and target around it.
2. **After the analysis** — the returned `spot_estimate` is compared against the feed. If it is
   out by more than `QUOTE_TOLERANCE_POINTS` (or `QUOTE_TOLERANCE_PCT`, whichever is larger),
   the live value replaces it, the misread is recorded in `notes`, and `confidence` is capped at
   50 — a model that couldn't read the price tag didn't read the chart well either.
3. **In the session memory** — the trend windows and sparkline plot the live quote, not the
   model's reading, so the day change, high and low are exact.

The dashboard shows the live spot in a header pill, and the Spot tile says whether the model's
reading was *verified* against the feed or *corrected* by it. A failed lookup never fails a run:
the last good quote is reused for `QUOTE_MAX_STALE_SECONDS`, after which the model falls back to
reading the chart and is told it is on its own.

## One-week swing adviser

The **Stocks Analysis** screen answers one question: *should I put money into this share for the
next few days?* It is not a research dump — it is the note an adviser would hand you before the
open, and every part of it is built around a trade that is **opened and closed inside one trading
week**.

Pick a share (quick chip, a ticker like `TATAMOTORS:NSE`, or a Google Finance URL), set **your
brief** — capital, risk per trade, maximum share of capital in one position — and press **Advise
Me**. The app then:

1. drives the Google Finance Beta window to that share and asks its **AI Research** panel a
   one-week swing question (trend, levels with numbers, volume, events landing this week, risks);
2. screenshots the whole screen once the panel has answered, and reads the panel's text out of the
   DOM as well, so the model gets the numbers as text rather than only as pixels;
3. sends both, plus your brief and the real dates of the next five NSE sessions, to the model.

What comes back:

| Block | What it is for |
| --- | --- |
| **The call** | `STRONG_BUY` / `TACTICAL_BUY` / `WAIT_PULLBACK` / `NEUTRAL` / `AVOID`, with a setup **grade** (A+ → D) and the setup type actually being traded |
| **Why now** | One line on why *this* week — the trigger, level or event that makes the timing specific |
| **Order ticket** | Entry zone and the trigger that fires it, a structural stop, T1/T2, risk:reward, **how many shares** your capital and risk budget allow, and the **time stop** — the dated session you exit on if nothing happens |
| **Setup scorecard** | Trend, momentum, volume/liquidity, catalyst, risk:reward and valuation scored 0-10, so a weak leg is visible instead of buried |
| **Execution playbook** | Where the first tranche is booked, when the stop moves to cost, how the rest trails, and what invalidates the whole read |
| **Bull / bear case** | The strongest argument on each side *for this week*, not for the year |
| **Read with care** | Every number the model wanted but could not see on the screen — the reason conviction is where it is |

Position sizing is arithmetic, not vibes: `risk per share = entry − stop`, `quantity = risk budget ÷
risk per share`, capped by the position limit, and the card says which of the two limits bound the
size. Set the brief to your real numbers and the share count is directly usable.

The adviser is told to refuse rather than invent: no identifiable setup, an index, or an unreadable
screen all produce `NEUTRAL`/`AVOID` with low conviction and a plain "do nothing this week".

Calls are kept in **Stock Analysis History** with their verdict, grade, conviction and screenshot;
clicking one replays the full note.

### Batch — screen a whole watchlist

The same call, run over a list instead of one share. It is built for a screener export: the file
you already download at the end of the day goes in, a ranked shortlist comes out.

1. **Import** — drop a CSV on the panel (or browse). Any file with a symbol column works; a
   screener export like `Sr., Stock Name, Symbol, close, %_change, volume` is read as-is, quoted
   commas, BOM and all. The columns are detected by header name, falling back to whichever column
   actually holds tickers. Parsing happens in the browser — the file is never uploaded.
2. **Pick** — every row is previewed with its close, change and volume, and **nothing is ticked
   for you**. Rows that are rarely swing-tradeable are flagged (`Fund / ETF`, `Rights entitlement`,
   `Below ₹5`) so a screener full of liquid ETFs doesn't quietly eat an hour. Quick picks —
   **Tradeable**, **Top 10**, **Top 25**, **All**, **None** — make a sensible selection one click.
   The estimate next to the button is honest: roughly a minute a share, refined by the measured
   average once a batch has run.
3. **Run** — symbols are analysed one at a time (the capture browser is a single shared
   resource, so the on-demand button is held until the batch finishes). Progress, the symbol in
   flight and an ETA stream to the dashboard; **Stop** ends the run after the current symbol
   rather than abandoning a half-finished capture. A symbol that fails is recorded and the batch
   carries on.

The result is a **ranked shortlist** — best call first, by verdict, then setup grade, then
conviction — showing entry, stop, target, reward:risk and the share count for your brief. Click a
row for the full adviser note. **Export CSV** writes the shortlist back out, and every call also
lands in Stock Analysis History on its own.

Batches are capped at 60 symbols, duplicates are collapsed, and only one batch runs at a time. A
batch started during market hours interleaves with the scheduled index captures, so it will take
longer than the estimate.

## Disclaimer

Technical study tool. The model reads pixels off a screenshot and can misread numbers — spot is
cross-checked against a live exchange quote, but every other level it quotes is still a reading
off an image. This is not investment advice.

## Running in the background

The capture browser must stay **headed** — Zerodha invalidates the session as soon as
it sees a headless Chrome user-agent, which logs you out of Kite.

Instead, the window is *tucked*: shrunk to a small size and pushed into the far
screen corner. Playwright renders each page at the configured viewport independently of
the OS window size, so screenshots stay full-resolution for both tabs — including the
one that isn't in the foreground. Nothing ever steals focus, so you can keep working.

- The window tucks itself automatically on startup and after every clean cycle.
- If either site needs a login, the window **pops back out on its own** so you can sign in.
- The **Show browser / Hide browser** control is the eye icon in the dashboard topbar, and
  **`B`** toggles it from anywhere on the page. Choosing "Show" pins it visible until you
  hide it again.
- Set `TUCK_WINDOW=false` to disable and keep a normal window.

Minimising is deliberately not used: macOS stops compositing minimised windows and
screenshots then time out.

## Memory use (Ollama)

`gemma4` occupies roughly **10 GB** while resident. Because a capture runs every minute
and Ollama's default `keep_alive` is 5 minutes, the model would otherwise never unload.

The app therefore sets `keep_alive` per request:

- **Inside market hours** (09:15–15:15 IST, Mon–Fri, ±5 min) → `5m`, so the model stays
  warm and each cycle avoids a ~4 s reload.
- **Outside market hours / weekends** → `0`, so it unloads right after each run.
- **Pause** in the dashboard, or **shutting the app down**, unloads it immediately.

A cold reload costs about 4 s (7.7 s vs 3.4 s warm), well inside the 60 s cycle.
The topbar pill shows the current footprint (`ollama 9.0GB loaded` / `ollama idle · 0GB`),
and `POST /api/ollama/unload` frees it on demand.

Public holidays aren't tracked — the market window logic only knows weekdays and clock times,
so on those days pause the schedule by hand (the model unloads immediately either way).

## Market hours

Automatic captures run **only between `MARKET_OPEN` and `MARKET_CLOSE` (09:15–15:15 IST) on
weekdays**. Outside that window:

- the scheduler sleeps and the ring counts down to the next open (`3h05`, `47m`, …);
- the topbar shows a **market closed** pill with the next open in its tooltip;
- the model is unloaded, so nothing holds ~10 GB overnight.

**Run now** still works outside the window, so you can test the setup or take a post-close
reading on demand.

## Session memory

Every automatic run is judged against its own recent history rather than in isolation.

Before each analysis the app rebuilds a factual log from the readings already stored for
today — spot levels parsed out of each `spot_estimate`, plus the bias each run reported — and
summarises it over the **last 1, 5, 10, 15 and 30 minutes and the whole day so far**: move in
points and percent, high/low, how many readings, and the mix of prior biases.

That log is sent to the model as its own memory (it never sees the *current* reading in the
memory, so the context can't become circular), and the model must fill a `history_read` field
with one concrete line per window plus a `momentum` and `trend_vs_now` verdict. The dashboard
renders the same windows as cards, so the numbers on screen and the numbers the model reasoned
over are identical.
