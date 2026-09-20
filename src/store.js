import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import config from './config.js';
import Archive from './archive.js';

export class Store {
  constructor({ archive } = {}) {
    this.runs = [];
    this.stockRuns = [];
    // Mirrors every run into data/exports/ for the browser-side "import archive" flow.
    this.archive = archive ?? new Archive();
  }

  async init() {
    await fsp.mkdir(config.paths.shots, { recursive: true });
    await this.archive.init();
    if (!fs.existsSync(config.paths.history)) {
      await fsp.writeFile(config.paths.history, '');
    } else {
      const rl = readline.createInterface({
        input: fs.createReadStream(config.paths.history),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          this.runs.push(JSON.parse(line));
        } catch {
          /* skip corrupt line */
        }
      }
      this.runs = this.runs.slice(-config.historyLimit);
    }

    const stocksPath = config.paths.stocksHistory;
    if (fs.existsSync(stocksPath)) {
      const rlStocks = readline.createInterface({
        input: fs.createReadStream(stocksPath),
        crlfDelay: Infinity,
      });
      for await (const line of rlStocks) {
        if (!line.trim()) continue;
        try {
          this.stockRuns.push(JSON.parse(line));
        } catch {}
      }
    }

    // Backfill any stock analyses found in market runs if not already in stockRuns
    for (const run of this.runs) {
      const fa = run.analysis?.parsed?.financial_analysis;
      if (fa && (fa.target_name || fa.ticker) && fa.target_name !== '—' && fa.target_name !== 'N/A') {
        const id = `run-${run.id}`;
        if (!this.stockRuns.some((s) => s.id === id || s.id === run.id)) {
          const gfShot = (run.shots || []).find((s) => s.id === 'googlefinance' || s.target === 'googlefinance');
          this.stockRuns.push({
            id,
            ticker: fa.ticker || fa.target_name,
            target_name: fa.target_name || fa.ticker,
            at: run.startedAt || new Date().toISOString(),
            verdict: fa.short_term_verdict || 'NEUTRAL',
            conviction: fa.conviction_score || run.analysis?.parsed?.conviction || 0,
            price: fa.current_price || '—',
            day_change: fa.day_change || '',
            health: fa.financial_health || 'neutral',
            horizon: fa.time_horizon || 'One-week swing',
            summary: fa.verdict_summary || fa.analyst_takeaway || '',
            shot: gfShot ? { file: gfShot.file, url: gfShot.shotUrl || `/shots/${gfShot.file}`, label: gfShot.label } : null,
            report: { parsed: fa },
          });
        }
      }
    }
  }

  async add(run) {
    this.runs.push(run);
    if (this.runs.length > config.historyLimit) this.runs = this.runs.slice(-config.historyLimit);
    await fsp.appendFile(config.paths.history, `${JSON.stringify(run)}\n`);
    // Fire-and-forget: a failed export must never break the capture loop.
    this.archive.addRun(run);
  }

  async addStockRun(stockRun) {
    this.stockRuns.unshift(stockRun);
    if (this.stockRuns.length > config.historyLimit) {
      this.stockRuns = this.stockRuns.slice(0, config.historyLimit);
    }
    await fsp.writeFile(config.paths.stocksHistory, this.stockRuns.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  listStockRuns(limit = 100) {
    return this.stockRuns.slice(0, limit);
  }

  getStockRun(id) {
    return this.stockRuns.find((r) => r.id === id) || null;
  }

  async deleteStockRun(id) {
    const idx = this.stockRuns.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    const [removed] = this.stockRuns.splice(idx, 1);
    await fsp.writeFile(config.paths.stocksHistory, this.stockRuns.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (removed?.shot?.file && removed.shot.file.includes('-googlefinance-research.png')) {
      fsp.unlink(path.join(config.paths.shots, removed.shot.file)).catch(() => {});
    }
    return true;
  }

  async clearStockRuns() {
    const count = this.stockRuns.length;
    this.stockRuns = [];
    await fsp.writeFile(config.paths.stocksHistory, '');
    return { count };
  }

  latest() {
    return this.runs[this.runs.length - 1] || null;
  }

  list(limit = 50) {
    return this.runs.slice(-limit).reverse();
  }

  get(id) {
    return this.runs.find((r) => r.id === id) || null;
  }

  // Wipes every stored run plus the screenshots on disk. Used by the "Clear data" control.
  async clear() {
    const runs = this.runs.length;
    this.runs = [];
    await fsp.writeFile(config.paths.history, '');
    let shots = 0;
    try {
      const files = (await fsp.readdir(config.paths.shots)).filter((f) => f.endsWith('.png'));
      await Promise.all(files.map((f) => fsp.unlink(path.join(config.paths.shots, f)).catch(() => {})));
      shots = files.length;
    } catch {
      /* shots dir may not exist yet */
    }
    return { runs, shots };
  }

  async pruneShots() {
    const files = (await fsp.readdir(config.paths.shots)).filter((f) => f.endsWith('.png')).sort();
    const excess = files.length - config.retainShots;
    if (excess <= 0) return 0;
    await Promise.all(files.slice(0, excess).map((f) => fsp.unlink(path.join(config.paths.shots, f)).catch(() => {})));
    return excess;
  }
}

export default Store;
