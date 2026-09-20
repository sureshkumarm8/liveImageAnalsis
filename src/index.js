import config from './config.js';
import Capture from './capture.js';
import Store from './store.js';
import Scheduler from './scheduler.js';
import createServer from './server.js';
import { checkOllama, unloadModel } from './ollama.js';
import { isMarketOpen } from './market.js';

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

async function main() {
  log('Checking Ollama at', config.ollama.host, '...');
  try {
    const o = await checkOllama();
    log(`Ollama OK. Models: ${o.models.join(', ') || '(none)'}`);
    if (!o.hasModel) log(`WARNING: model "${config.ollama.model}" not found. Run: ollama pull ${config.ollama.model}`);
  } catch (err) {
    log(`WARNING: Ollama not reachable (${err.message}). Screenshots will still be captured.`);
  }

  const store = new Store();
  await store.init();
  log(`Loaded ${store.runs.length} previous run(s).`);
  if (store.archive.enabled) {
    log(`Archiving each run to ${store.archive.root} — import it from the dashboard when this engine isn't reachable.`);
  }

  const capture = new Capture();
  log('Launching browser (persistent profile at', config.browser.profileDir, ')...');
  await capture.init();
  if (capture.tucked) {
    log('Browser ready and tucked into the screen corner — it keeps capturing while you work.');
    log('If a login is needed the window reappears automatically; or use "Show browser" in the dashboard.');
  } else {
    log('Browser ready. Log in manually in the opened window if a login page is shown — the session is remembered.');
  }

  const scheduler = new Scheduler(capture, store);
  log(
    `Capture window: ${config.market.open}–${config.market.close} ${config.market.tz} (Mon–Fri).`,
    isMarketOpen() ? 'Market is open.' : 'Market is closed — sleeping until the next open.',
  );
  scheduler.on('run', (run) => {
    const bias = run.analysis?.parsed?.bias ?? (run.analysis?.ok ? 'unparsed' : 'failed');
    log(`Run ${run.id} done in ${(run.durationMs / 1000).toFixed(1)}s — bias: ${bias}`);
  });

  const app = createServer({ store, scheduler, capture });
  const server = app.listen(config.port, () => {
    log(`Dashboard → http://localhost:${config.port}`);
  });

  scheduler.start();

  const shutdown = async () => {
    log('Shutting down...');
    scheduler.stop();
    server.close();
    await unloadModel();
    await capture.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
