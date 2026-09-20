import { EventEmitter } from 'node:events';

/** A batch can never be larger than this, however long the pasted CSV is. */
export const MAX_BATCH = 60;

/**
 * Runs the one-week swing analysis over a list of symbols, one at a time.
 *
 * Each item drives the real browser (navigate Google Finance → let the AI Research panel
 * answer → screenshot → model), so a batch is minutes of work, not seconds: it runs in the
 * background, reports progress as it goes, survives a failed symbol, and can be stopped.
 * Only one batch exists at a time — the capture browser is a single shared resource.
 */
export class BatchRunner extends EventEmitter {
  /** @param runOne async ({ symbol, name, context }) => { ok, item?, error? } */
  constructor({ runOne }) {
    super();
    this.runOne = runOne;
    this.job = null;
    this.cancelled = false;
  }

  get running() {
    return Boolean(this.job && this.job.status === 'running');
  }

  /** The snapshot the dashboard renders — no screenshots or raw model output in it. */
  snapshot() {
    if (!this.job) return { active: false };
    const j = this.job;
    const elapsedMs = (j.finishedAt || Date.now()) - j.startedAt;
    const completed = j.results.length;
    const avgMs = completed ? Math.round(elapsedMs / completed) : null;
    return {
      active: j.status === 'running',
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      total: j.total,
      completed,
      succeeded: j.results.filter((r) => r.ok).length,
      failed: j.results.filter((r) => !r.ok).length,
      current: j.current,
      context: j.context,
      elapsedMs,
      avgMs,
      etaMs: avgMs && j.status === 'running' ? avgMs * (j.total - completed) : null,
      results: j.results,
      error: j.error || null,
    };
  }

  emitState() {
    this.emit('batch', this.snapshot());
  }

  start({ items, context }) {
    if (this.running) throw new Error('A batch is already running.');

    const list = items.slice(0, MAX_BATCH);
    if (!list.length) throw new Error('No symbols to analyse.');

    this.cancelled = false;
    this.job = {
      id: `batch-${Date.now()}`,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      total: list.length,
      current: null,
      context,
      results: [],
      error: null,
    };

    // Deliberately not awaited: the POST returns immediately and progress arrives over SSE.
    this.#run(list, context);
    return this.snapshot();
  }

  stop() {
    if (!this.running) return this.snapshot();
    this.cancelled = true;
    // The in-flight symbol still finishes — killing a half-done capture would leave the
    // browser on an arbitrary page. The loop exits before the next one starts.
    this.emitState();
    return this.snapshot();
  }

  async #run(list, context) {
    this.emitState();

    for (let i = 0; i < list.length; i += 1) {
      if (this.cancelled) break;

      const entry = list[i];
      this.job.current = { index: i, symbol: entry.symbol, name: entry.name || '' };
      this.emitState();

      const startedAt = Date.now();
      let result;
      try {
        const res = await this.runOne({ symbol: entry.symbol, name: entry.name, context });
        result = res.ok && res.item
          ? { ...summarise(res.item), ok: true, durationMs: Date.now() - startedAt }
          : {
              ok: false,
              symbol: entry.symbol,
              name: entry.name || entry.symbol,
              error: res.error || 'The model returned nothing usable for this symbol.',
              at: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
            };
      } catch (err) {
        result = {
          ok: false,
          symbol: entry.symbol,
          name: entry.name || entry.symbol,
          error: err.message,
          at: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
        };
      }

      this.job.results.push(result);
      this.job.current = null;
      this.emitState();
    }

    this.job.status = this.cancelled ? 'stopped' : 'done';
    this.job.finishedAt = Date.now();
    this.job.current = null;
    this.emitState();
  }
}

/** One row of the results table: the decision, not the whole report. */
function summarise(item) {
  const p = item.report?.parsed || {};
  const plan = p.trade_plan || {};
  return {
    id: item.id,
    symbol: item.ticker || p.ticker || '',
    name: item.target_name || p.target_name || '',
    at: item.at,
    verdict: item.verdict || 'NEUTRAL',
    grade: item.grade || p.trade_grade || '',
    setup: item.setup || p.setup_type || '',
    conviction: item.conviction || 0,
    price: item.price || '',
    day_change: item.day_change || '',
    entry: plan.entry_zone || '',
    stop: plan.stop_loss || '',
    target: plan.target_1 || '',
    rr: plan.risk_reward_ratio || '',
    quantity: p.position_sizing?.quantity || '',
    summary: item.summary || '',
  };
}

export default BatchRunner;
