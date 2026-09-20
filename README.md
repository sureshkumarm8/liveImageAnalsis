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

A Chromium window opens with two tabs. Both sites need a session:

| Tab | Why |
| --- | --- |
| Kite | The chart URL requires a logged-in Kite session |
| Sensibull | Index (NIFTY) option-chain data requires a broker login |

Log in **manually in that window**. The session is stored in `data/browser-profile/` and reused
on every later start, so you only do this once (until the broker expires the session).

While a login screen is detected the app still captures screenshots but **skips the model call**
(the dashboard shows a `login needed` badge). As soon as you're logged in it re-navigates to the
target views automatically and resumes analysis on the next cycle.

Sensibull tends to restore its own last-used ticker — the app detects this and switches the
symbol back to NIFTY on every cycle. It also recovers automatically from Sensibull's
intermittent "Oops! Something went wrong" page by clicking Retry.

## Dashboard

- Both live screenshots side by side (click to zoom), with per-tab **Reload** buttons
- **Collapse/expand** either screenshot panel by clicking its title or caret. A collapsed panel
  shrinks to a slim header bar and gives its space to the other chart, which expands to full
  width. The choice is remembered in `localStorage`, so it survives the per-minute refresh and
  page reloads.
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
- **Interval dropdown** — switch the capture cadence between **1, 2, 5, 10 and 15 minutes**
  without restarting. The next run is immediately re-aligned to the new wall-clock boundary
  (e.g. 15 min fires at :00, :15, :30, :45). Resets to `INTERVAL_SECONDS` on restart.
- **Clear data** wipes every stored run and all captured screenshots from disk (asks for
  confirmation first, since it cannot be undone)
- **Save snapshots** captures a fixed set of four charts and writes them straight to your
  Downloads folder — see [Snapshot button](#snapshot-button)
- **Theme toggle** switches between the dark and light palettes; the choice is remembered in
  `localStorage`
- Scrollable history — click any row to pin that run; press <kbd>Esc</kbd> to go back to live
- Raw model JSON in a collapsible panel

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
| `GET /api/status` | Scheduler, Ollama and per-tab login state |
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
| `POST /api/snapshots` | Capture the four snapshot views and save them to `DOWNLOADS_DIR` |
| `POST /api/pause` / `POST /api/resume` | Control the loop |
| `POST /api/interval` | Set the cadence live — body `{ "minutes": 1 \| 2 \| 5 \| 10 \| 15 }` |
| `POST /api/reload/:id` | Re-navigate `kite` or `sensibull` |
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
- The **Show browser / Hide browser** button sits directly in the dashboard topbar (no menu),
  and **`B`** toggles it from anywhere on the page. Choosing "Show" pins it visible until you
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
