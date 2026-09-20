import { EventEmitter } from 'node:events';
import config from './config.js';
import { analyse, unloadModel } from './ai.js';
import { getQuote } from './quote.js';
import { isMarketOpen, marketStatus, nextOpenAt } from './market.js';
import { buildTrend } from './trend.js';

const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(
    d.getHours(),
  ).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

export class Scheduler extends EventEmitter {
  // Cadences offered in the dashboard dropdown, in minutes.
  static INTERVAL_OPTIONS = [1, 2, 5, 10, 15];
  // How often the closed-market sleep re-checks the clock.
  static CLOSED_POLL_MS = 60000;
  // How often buffered model tokens are pushed to the dashboard.
  static TOKEN_FLUSH_MS = 100;

  constructor(capture, store) {
    super();
    this.capture = capture;
    this.store = store;
    this.timer = null;
    this.running = false;
    this.paused = false;
    this.phase = 'idle';
    this.nextRunAt = null;
    this.lastError = null;
    // The in-flight model token sink, so a finished run can flush what's left.
    this.activeTokenStream = null;
    // Tracks whether we've already announced that the market closed.
    this.marketAwake = true;
    // Live-adjustable from the dashboard; config.intervalMs is only the starting value.
    this.intervalMs = config.intervalMs;
  }

  status() {
    const market = marketStatus();
    return {
      paused: this.paused,
      phase: this.phase,
      running: this.running,
      nextRunAt: this.nextRunAt,
      intervalMs: this.intervalMs,
      intervalOptions: Scheduler.INTERVAL_OPTIONS,
      provider: config.provider,
      model: config[config.provider].model,
      lastError: this.lastError,
      cycle: this.capture.cycle,
      marketOpen: market.open,
      market,
      // True while the schedule is alive but sleeping until the next session opens.
      waitingForMarket: !this.paused && !market.open,
    };
  }

  // Change the capture cadence on the fly and re-align the next run to the new interval.
  setInterval(minutes) {
    const mins = Number(minutes);
    if (!Scheduler.INTERVAL_OPTIONS.includes(mins)) {
      throw new Error(`interval must be one of ${Scheduler.INTERVAL_OPTIONS.join(', ')} minutes`);
    }
    this.intervalMs = mins * 60000;
    // A run in flight will reschedule itself with the new interval when it finishes.
    if (!this.running) this.scheduleNext();
    else this.emitStatus();
    return this.status();
  }

  emitStatus() {
    this.emit('status', this.status());
  }

  setPhase(phase) {
    this.phase = phase;
    this.emitStatus();
  }

  start() {
    this.scheduleNext(0);
  }

  scheduleNext(delayOverride) {
    clearTimeout(this.timer);
    if (this.paused) {
      this.nextRunAt = null;
      this.emitStatus();
      return;
    }

    // Outside 09:15–15:15 IST nothing is captured: sleep until the next open, re-checking
    // periodically so a laptop suspend or clock change can't leave us sleeping past the bell.
    if (!isMarketOpen()) {
      const opensAt = nextOpenAt();
      this.nextRunAt = opensAt;
      if (this.marketAwake) {
        this.marketAwake = false;
        // Nothing will be analysed until the market reopens, so hand the memory back.
        unloadModel();
        this.emit('error-event', {
          at: new Date().toISOString(),
          message: `Market closed — capturing pauses until ${config.market.open} IST.`,
          info: true,
        });
      }
      this.emitStatus();
      const wait = Math.min(Math.max(opensAt - Date.now(), 1000), Scheduler.CLOSED_POLL_MS);
      this.timer = setTimeout(() => this.scheduleNext(), wait);
      return;
    }
    this.marketAwake = true;

    let delay = delayOverride;
    if (delay === undefined) {
      // Align to wall-clock interval boundaries (e.g. every :00 second).
      const now = Date.now();
      delay = this.intervalMs - (now % this.intervalMs);
      // Don't fire again almost immediately after a run that finished near the boundary.
      const minGap = Math.min(15000, this.intervalMs / 2);
      if (delay < minGap) delay += this.intervalMs;
    }
    this.nextRunAt = Date.now() + delay;
    this.emitStatus();
    this.timer = setTimeout(() => this.runOnce().catch(() => {}), delay);
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.nextRunAt = null;
    this.emitStatus();
    // Nothing will be analysed while paused, so hand the ~10GB back to the OS.
    unloadModel();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.scheduleNext();
  }

  /**
   * Build the token sink handed to the model call. Deltas arrive one or two characters at
   * a time, which is far too chatty for SSE, so they're coalesced into ~10/s batches.
   * `flush` is called once at the end to release whatever is still buffered.
   */
  tokenStream(runId) {
    let pending = { thinking: '', content: '' };
    let timer = null;

    const flush = () => {
      timer = null;
      if (!pending.thinking && !pending.content) return;
      this.emit('analysis-token', { runId, ...pending });
      pending = { thinking: '', content: '' };
    };

    const onToken = ({ kind, delta }) => {
      pending[kind] += delta;
      if (!timer) timer = setTimeout(flush, Scheduler.TOKEN_FLUSH_MS);
    };
    onToken.flush = () => {
      clearTimeout(timer);
      flush();
    };
    this.activeTokenStream = onToken;
    this.emit('analysis-start', { runId, at: new Date().toISOString(), model: config[config.provider].model });
    return onToken;
  }

  async runOnce({ manual = false } = {}) {
    if (this.running) return { skipped: true, reason: 'a run is already in progress' };
    // Automatic runs never fire outside the trading window; a manual "Run now" still works
    // so you can check the setup or replay the close.
    if (!manual && !isMarketOpen()) {
      this.scheduleNext();
      return { skipped: true, reason: 'market closed' };
    }
    this.running = true;
    this.lastError = null;
    const startedAt = new Date();
    const id = stamp(startedAt);

    try {
      this.setPhase('capturing');
      // The quote is fetched alongside the screenshots so it describes the same moment
      // the charts were rendered, and a slow/broken feed never fails the run.
      const [shots, quote] = await Promise.all([
        this.capture.captureAll(id),
        getQuote({ force: true }).catch((err) => ({ ok: false, error: err.message })),
      ]);

      this.setPhase('analysing');
      // Rolling 1/5/10/15/30-minute and whole-day memory of earlier readings. The model
      // sees the memory as it stood *before* this reading, so it can't be circular.
      const priorTrend = buildTrend(this.store.runs, startedAt);
      const analysis = await analyse(shots, priorTrend, quote, { onToken: this.tokenStream(id) });

      const run = {
        id,
        manual,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        shots: shots.map(({ base64, ...rest }) => rest),
        quote,
        analysis,
      };
      // The dashboard shows the memory *including* this reading, so the day move and the
      // sparkline agree with the spot on screen.
      run.trend = buildTrend([...this.store.runs, run], startedAt);

      await this.store.add(run);
      await this.store.pruneShots();
      this.emit('run', run);
      if (!analysis.ok) this.lastError = analysis.error;
      return run;
    } catch (err) {
      this.lastError = err.message;
      this.emit('error-event', { at: new Date().toISOString(), message: err.message });
      return { error: err.message };
    } finally {
      // Release any tokens still buffered, then tell the dashboard the stream is over.
      this.activeTokenStream?.flush?.();
      this.activeTokenStream = null;
      this.emit('analysis-end', { runId: id, at: new Date().toISOString() });
      this.running = false;
      this.setPhase('idle');
      // If you paused mid-run, the in-flight analysis will have re-loaded the model
      // after pause() unloaded it — so drop it again now that the run is over.
      if (this.paused) unloadModel();
      if (!manual) this.scheduleNext();
      else if (!this.paused && !this.timer) this.scheduleNext();
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export default Scheduler;
