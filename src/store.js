import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import config from './config.js';
import Archive from './archive.js';

export class Store {
  constructor({ archive } = {}) {
    this.runs = [];
    // Mirrors every run into data/exports/ for the browser-side "import archive" flow.
    this.archive = archive ?? new Archive();
  }

  async init() {
    await fsp.mkdir(config.paths.shots, { recursive: true });
    await this.archive.init();
    if (!fs.existsSync(config.paths.history)) {
      await fsp.writeFile(config.paths.history, '');
      return;
    }
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

  async add(run) {
    this.runs.push(run);
    if (this.runs.length > config.historyLimit) this.runs = this.runs.slice(-config.historyLimit);
    await fsp.appendFile(config.paths.history, `${JSON.stringify(run)}\n`);
    // Fire-and-forget: a failed export must never break the capture loop.
    this.archive.addRun(run);
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
