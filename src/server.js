import express from 'express';
import config from './config.js';
import { checkOllama, loadedModels, unloadModel } from './ollama.js';
import { buildTrend } from './trend.js';
import { getQuote } from './quote.js';

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
    let ollama = { ok: false };
    try {
      ollama = await checkOllama();
    } catch (err) {
      ollama = { ok: false, error: err.message };
    }
    if (ollama.ok) ollama.loaded = await loadedModels();
    res.json({
      ...scheduler.status(),
      ollama,
      quote: await getQuote().catch((err) => ({ ok: false, error: err.message })),
      windowVisible: capture.windowVisible,
      archive: { enabled: store.archive.enabled, dir: store.archive.root },
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

  app.post('/api/pause', (req, res) => {
    scheduler.pause();
    res.json(scheduler.status());
  });

  app.post('/api/resume', (req, res) => {
    scheduler.resume();
    res.json(scheduler.status());
  });

  app.post('/api/ollama/unload', async (req, res) => {
    res.json(await unloadModel());
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

    scheduler.on('status', onStatus);
    scheduler.on('run', onRun);
    scheduler.on('error-event', onErr);
    scheduler.on('analysis-start', onTokenStart);
    scheduler.on('analysis-token', onToken);
    scheduler.on('analysis-end', onTokenEnd);

    const ping = setInterval(() => res.write(': ping\n\n'), 20000);

    req.on('close', () => {
      clearInterval(ping);
      scheduler.off('status', onStatus);
      scheduler.off('run', onRun);
      scheduler.off('error-event', onErr);
      scheduler.off('analysis-start', onTokenStart);
      scheduler.off('analysis-token', onToken);
      scheduler.off('analysis-end', onTokenEnd);
    });
  });

  return app;
}

export default createServer;
