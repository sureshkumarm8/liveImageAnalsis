import express from 'express';
import config from './config.js';
import { checkProvider, loadedModels, unloadModel, analyseFinancialReport } from './ai.js';
import { buildTrend } from './trend.js';
import { getQuote } from './quote.js';
import { tradingWindow, applySizing } from './swing.js';
import { BatchRunner, MAX_BATCH } from './batch.js';

export function createServer({ store, scheduler, capture }) {
  const app = express();
  app.use(express.json());

  app.use('/shots', express.static(config.paths.shots, { maxAge: '1h' }));
  // The portable archive (JSON bundles + copied PNGs) is served as-is, so the dashboard
  // can pull an export over HTTP when it *can* reach this machine, and read the very same
  // folder off disk when it can't (deployed build).
  app.use('/exports', express.static(config.paths.exports, { maxAge: '1h' }));
  app.use(express.static(config.paths.publicDir));

  app.get('/api/status', async (req, res) => {
    let ai = { ok: false };
    try {
      ai = await checkProvider();
    } catch (err) {
      ai = { ok: false, error: err.message };
    }
    if (ai.ok) ai.loaded = await loadedModels();
    res.json({
      ...scheduler.status(),
      provider: config.provider,
      ai,
      quote: await getQuote().catch((err) => ({ ok: false, error: err.message })),
      windowVisible: capture.windowVisible,
      kiteEnabled: capture.kiteEnabled,
      googleFinance: {
        enabled: capture.googleFinanceEnabled,
        url: capture.googleFinanceUrl || config.browser.googleFinanceUrl,
        symbol: capture.googleFinanceSymbol || 'Overview',
      },
      archive: { enabled: store.archive.enabled, dir: store.archive.root },
      advisor: { ...config.advisor, window: tradingWindow(new Date(), config.advisor.sessions) },
      windowControl: Boolean(capture.cdp) && config.browser.tuckWindow,
      targets: await Promise.all(
        config.targets.map(async (t) => {
          const page = capture.page(t.id);
          return {
            id: t.id,
            label: t.label,
            url: t.url,
            currentUrl: page && !page.isClosed() ? page.url() : null,
            awaitingLogin: await capture.loginState(t.id),
          };
        }),
      ),
    });
  });

  app.get('/api/latest', (req, res) => res.json(store.latest()));

  // Live NIFTY 50 spot from the exchange quote API — the same number the model is given
  // as ground truth. `?force=1` bypasses the short cache.
  app.get('/api/quote', async (req, res) => {
    try {
      return res.json(await getQuote({ force: req.query.force === '1' }));
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  });

  // Rolling 1/5/10/15/30-minute and whole-day view of today's readings, recomputed live so
  // the dashboard's session-memory strip stays accurate between runs.
  app.get('/api/trend', (req, res) => res.json(buildTrend(store.runs)));

  app.get('/api/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, config.historyLimit);
    res.json(store.list(limit));
  });

  app.get('/api/run/:id', (req, res) => {
    const run = store.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    return res.json(run);
  });

  app.post('/api/run-now', async (req, res) => {
    const result = await scheduler.runOnce({ manual: true });
    res.json(result);
  });

  app.post('/api/snapshots', async (req, res) => {
    if (capture.busy) return res.status(409).json({ error: 'a capture is already in progress' });
    try {
      const out = await capture.captureSnapshotSet();
      const failed = out.results.filter((r) => !r.ok);
      return res.json({ ok: failed.length === 0, ...out });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/history', async (req, res) => {
    const result = await store.clear();
    res.json({ ok: true, ...result });
  });

  // --- PORTABLE ARCHIVE ---------------------------------------------------
  // data/exports/ is written after every run. These endpoints let the dashboard
  // inspect it, backfill it from history.jsonl and produce single-file exports.

  app.get('/api/archive', async (req, res) => {
    try {
      const manifest = await store.archive.manifest();
      return res.json({ ...manifest, dir: store.archive.root, enabled: store.archive.enabled });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/archive/day/:date', async (req, res) => {
    const file = store.archive.bundlePath(req.params.date, req.query.embedded === '1');
    return res.sendFile(file, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: `no archive for ${req.params.date}` });
    });
  });

  app.post('/api/archive/rebuild', async (req, res) => {
    try {
      const out = await store.archive.rebuild({
        runs: store.runs,
        embed: req.body?.embed === true,
        date: req.body?.date,
      });
      return res.json({ ok: true, dir: store.archive.root, ...out });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/archive/embed', async (req, res) => {
    try {
      const date = req.body?.date;
      if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
      return res.json({ ok: true, ...(await store.archive.embedDate(date)) });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/archive', async (req, res) => {
    try {
      return res.json(await store.archive.clear());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/interval', (req, res) => {
    const minutes = Number(req.body?.minutes);
    try {
      return res.json(scheduler.setInterval(minutes));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/provider', (req, res) => {
    const provider = req.body?.provider;
    if (provider === 'gemini' || provider === 'ollama') {
      config.provider = provider;
      // status() now carries `provider` and the model of whichever one is live, so the
      // settings dialog can render the new state straight from this response.
      return res.json(scheduler.status());
    }
    return res.status(400).json({ error: 'Invalid provider' });
  });

  app.post('/api/gemini/key', (req, res) => {
    const apiKey = req.body?.apiKey;
    if (typeof apiKey === 'string') {
      config.gemini.apiKey = apiKey;
      return res.json({ ok: true, message: 'API key updated' });
    }
    return res.status(400).json({ error: 'Invalid API key' });
  });

  app.post('/api/pause', (req, res) => {
    scheduler.pause();
    res.json(scheduler.status());
  });

  app.post('/api/resume', (req, res) => {
    scheduler.resume();
    res.json(scheduler.status());
  });

  app.post('/api/ai/unload', async (req, res) => {
    const result = await unloadModel();
    res.json(result);
  });

  app.post('/api/window/:action', async (req, res) => {
    const { action } = req.params;
    if (!['show', 'hide'].includes(action)) return res.status(400).json({ error: 'use show or hide' });
    const ok = action === 'show' ? await capture.showWindow() : await capture.hideWindow();
    return res.json({ ok, windowVisible: capture.windowVisible });
  });

  app.post('/api/reload/:id', async (req, res) => {
    const result = await capture.navigate(req.params.id);
    res.json(result);
  });

  app.post('/api/kite-toggle', (req, res) => {
    if (req.body && typeof req.body.enabled === 'boolean') {
      capture.kiteEnabled = req.body.enabled;
    } else {
      capture.kiteEnabled = !capture.kiteEnabled;
    }
    return res.json({ ok: true, kiteEnabled: capture.kiteEnabled });
  });

  app.post('/api/google-finance/toggle', (req, res) => {
    if (req.body && typeof req.body.enabled === 'boolean') {
      capture.googleFinanceEnabled = req.body.enabled;
    } else {
      capture.googleFinanceEnabled = !capture.googleFinanceEnabled;
    }
    if (capture.googleFinanceEnabled) {
      capture.pageFor('googlefinance').catch(() => {});
    }
    return res.json({ ok: true, googleFinanceEnabled: capture.googleFinanceEnabled });
  });

  app.post('/api/google-finance/target', async (req, res) => {
    const query = req.body?.query || req.body?.url || req.body?.ticker;
    try {
      const result = await capture.setGoogleFinanceTarget(query);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // The client brief the adviser sizes against. Clamped so a stray value from the
  // dashboard can never produce a nonsensical position.
  const briefFrom = (body = {}) => {
    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, lo), hi) : dflt;
    };
    return {
      capital: clamp(body.capital, 1000, 1e9, config.advisor.capital),
      riskPct: clamp(body.riskPct, 0.25, 10, config.advisor.riskPct),
      maxAllocPct: clamp(body.maxAllocPct, 5, 100, config.advisor.maxAllocPct),
      currency: config.advisor.currency,
      window: tradingWindow(new Date(), config.advisor.sessions),
    };
  };

  /**
   * One share, end to end: point the Google Finance window at it, screenshot the AI
   * Research answer, get the swing call, size it, and file it in history.
   * Shared by the on-demand button and the batch runner so both behave identically.
   */
  const analyseStock = async ({ query, context }) => {
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    let stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(
      d.getMinutes(),
    )}${pad2(d.getSeconds())}`;
    // Stamps are second-resolution; two runs inside the same second would otherwise
    // share an id and collide in history.
    for (let n = 2; store.getStockRun(`stock-${stamp}`); n += 1) stamp = `${stamp.split('_')[0]}_${n}`;

    const shot = await capture.captureGoogleFinanceResearch({ symbol: query, stamp });
    if (!shot.ok) {
      return { ok: false, error: shot.error || 'Failed to capture the Google Finance AI Research screen.' };
    }

    const report = await analyseFinancialReport(shot, { context });
    if (!report.ok) return { ok: false, shot, report, error: report.error };
    if (!report.parsed) {
      return { ok: false, shot, report, error: 'The model did not return a usable report for this symbol.' };
    }

    // Sizing and reward:risk are recomputed from the levels the model quoted, so the
    // share count on screen is arithmetic rather than the model's mental maths.
    applySizing(report.parsed, context);

    // Capture the candlestick chart (YTD) after the research screenshot.
    let chart = null;
    try {
      chart = await capture.captureGoogleFinanceChart({ symbol: query, stamp });
      if (chart && !chart.ok) {
        console.warn('Chart capture failed:', chart.error);
      }
    } catch (err) {
      console.warn('Chart capture error:', err.message);
    }

    const p = report.parsed;
    const item = {
      id: `stock-${stamp}`,
      ticker: p.ticker || query || 'Stock',
      target_name: p.target_name || p.ticker || query || 'Stock',
      at: new Date().toISOString(),
      verdict: p.short_term_verdict || 'NEUTRAL',
      grade: p.trade_grade || '',
      setup: p.setup_type || '',
      conviction: p.conviction_score || 0,
      price: p.current_price || '—',
      day_change: p.day_change || '',
      health: p.financial_health || 'neutral',
      horizon: p.time_horizon || `Exit by ${context.window.exitBy}`,
      summary: p.verdict_summary || p.analyst_takeaway || '',
      shot: shot?.url ? { file: shot.file, url: shot.url, label: shot.label } : null,
      chart: chart?.ok ? { file: chart.file, url: chart.url, label: chart.label, chartUrl: chart.chartUrl } : null,
      brief: { capital: context.capital, riskPct: context.riskPct, maxAllocPct: context.maxAllocPct },
      report,
    };
    await store.addStockRun(item);
    return { ok: true, shot, chart, report, item };
  };

  app.post('/api/google-finance/analyse', async (req, res) => {
    try {
      const query = req.body?.query || req.body?.ticker || req.body?.symbol;
      const context = briefFrom(req.body);
      const out = await analyseStock({ query, context });
      if (!out.ok && !out.report) {
        return res.status(502).json({ ok: false, error: out.error });
      }
      return res.json({ ok: out.ok, shot: out.shot, chart: out.chart || null, report: out.report, item: out.item || null, context, error: out.error });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- BATCH ANALYSIS ------------------------------------------------
  const batch = new BatchRunner({
    runOne: ({ symbol, context }) => analyseStock({ query: symbol, context }),
  });
  batch.on('batch', (state) => scheduler.emit('batch', state));

  app.get('/api/stocks/batch', (req, res) => res.json(batch.snapshot()));

  app.post('/api/stocks/batch', (req, res) => {
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    const seen = new Set();
    const items = [];
    for (const entry of raw) {
      const symbol = String(entry?.symbol || entry || '').trim().toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      items.push({ symbol, name: String(entry?.name || '').trim() });
    }
    if (!items.length) return res.status(400).json({ ok: false, error: 'No valid symbols in the request.' });

    try {
      const state = batch.start({ items, context: briefFrom(req.body) });
      return res.json({ ok: true, max: MAX_BATCH, skipped: raw.length - items.length, state });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err.message, state: batch.snapshot() });
    }
  });

  app.post('/api/stocks/batch/stop', (req, res) => res.json({ ok: true, state: batch.stop() }));

  // --- STOCKS ANALYSIS HISTORY ENDPOINTS -----------------------------
  app.get('/api/stocks/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    res.json(store.listStockRuns(limit));
  });

  app.get('/api/stocks/run/:id', (req, res) => {
    const run = store.getStockRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    return res.json(run);
  });

  app.delete('/api/stocks/history/:id', async (req, res) => {
    const ok = await store.deleteStockRun(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, id: req.params.id });
  });

  app.delete('/api/stocks/history', async (req, res) => {
    const result = await store.clearStockRuns();
    return res.json({ ok: true, ...result });
  });

  // Debug helper for tuning the per-site capture selectors.
  app.get('/api/dom/:id', async (req, res) => {
    const page = capture.page(req.params.id);
    if (!page || page.isClosed()) return res.status(404).json({ error: 'no page' });
    const sel = req.query.selector;
    const controls = req.query.mode === 'controls';

    const scan = (frameLike) =>
      frameLike.evaluate(
        ({ selector, wantControls }) => {
          const nodes = selector
            ? [...document.querySelectorAll(selector)]
            : [...document.querySelectorAll(wantControls ? 'button,[role="button"],div,span,a' : 'div,main,section')];
          return nodes
            .map((el) => {
              const r = el.getBoundingClientRect();
              return {
                tag: el.tagName,
                id: el.id,
                cls: (el.className || '').toString().slice(0, 70),
                text: (el.textContent || '').trim().slice(0, 30),
                w: Math.round(r.width),
                h: Math.round(r.height),
                x: Math.round(r.x),
                y: Math.round(r.y),
              };
            })
            .filter((n) =>
              wantControls ? n.w > 8 && n.w < 90 && n.h > 8 && n.h < 50 && n.text : n.w > 500 && n.h > 350,
            )
            .slice(0, 60);
        },
        { selector: sel, wantControls: controls },
      );

    const out = { url: page.url(), main: await scan(page), frames: [] };
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      out.frames.push({ url: f.url().slice(0, 90), nodes: await scan(f).catch(() => []) });
    }
    return res.json(out);
  });

  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('status', scheduler.status());
    const latest = store.latest();
    if (latest) send('run', latest);

    const onStatus = (s) => send('status', s);
    const onRun = (r) => send('run', r);
    const onErr = (e) => send('error-event', e);
    // Live model output — one batch every ~100ms while the analysis is running.
    const onTokenStart = (e) => send('analysis-start', e);
    const onToken = (e) => send('analysis-token', e);
    const onTokenEnd = (e) => send('analysis-end', e);
    const onBatch = (e) => send('batch', e);

    scheduler.on('status', onStatus);
    scheduler.on('run', onRun);
    scheduler.on('error-event', onErr);
    scheduler.on('analysis-start', onTokenStart);
    scheduler.on('analysis-token', onToken);
    scheduler.on('analysis-end', onTokenEnd);
    scheduler.on('batch', onBatch);

    const ping = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
      clearInterval(ping);
      scheduler.off('status', onStatus);
      scheduler.off('run', onRun);
      scheduler.off('error-event', onErr);
      scheduler.off('analysis-start', onTokenStart);
      scheduler.off('analysis-token', onToken);
      scheduler.off('analysis-end', onTokenEnd);
      scheduler.off('batch', onBatch);
    });
  });

  return app;
}

export default createServer;
