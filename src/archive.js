import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import config from './config.js';

/**
 * Portable archive of finished runs.
 *
 * The capture engine only runs on this machine, so a deployed dashboard (Vercel)
 * can never call it. Instead every run is also written to a plain folder that the
 * browser can read directly from disk:
 *
 *   data/exports/
 *     index.json                       manifest: one entry per trading day
 *     vision-2026-09-15.json           that day's runs (analysis + shot filenames)
 *     vision-2026-09-15.embedded.json  optional self-contained copy (screenshots inlined)
 *     runs/2026-09-15/run-*.json       one immutable file per run, for incremental imports
 *     shots/2026-09-15/*.png           the screenshots those runs point at
 *
 * Each manifest day publishes `runs` (what the bundle holds) alongside `runFiles` (what
 * runs/<date>/ holds). An importer may only skip the day bundle when runFiles >= runs;
 * otherwise the per-run mirror is partial and reading it alone would silently lose runs.
 *
 * The dashboard's "Import analysis data" picker reads that folder client-side, so
 * no server, no localhost call and no upload is involved.
 *
 * `npm run export -- --embed` additionally writes vision-<date>.embedded.json with
 * every screenshot inlined as a data URL: a single self-contained file that can be
 * dropped into the dashboard on any machine.
 */

export const SCHEMA = 'vision-archive/v1';

const pad = (n) => String(n).padStart(2, '0');

/** Run ids look like 20260915-091600 — the local calendar day they belong to. */
export function dayOfRun(run) {
  const id = String(run?.id || '');
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(id);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = run?.startedAt ? new Date(run.startedAt) : new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const bundleName = (date, embedded = false) => `vision-${date}${embedded ? '.embedded' : ''}.json`;

/**
 * One immutable file per run, named after the run's wall-clock timestamp:
 *   runs/2026-09-15/run-2026-09-15T11-45-00.json
 *
 * The day bundle is rewritten on every cycle, so a dashboard polling the folder would have
 * to re-read the whole day each minute. These never change once written, which lets the
 * importer skip everything it has already seen by filename alone.
 */
export function runFileName(run, date = dayOfRun(run)) {
  const m = /^\d{8}-(\d{2})(\d{2})(\d{2})$/.exec(String(run?.id || ''));
  const time = m ? `${m[1]}-${m[2]}-${m[3]}` : new Date(run?.startedAt || Date.now())
    .toTimeString()
    .slice(0, 8)
    .replace(/:/g, '-');
  return `run-${date}T${time}.json`;
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

/**
 * Per-run files actually present for a day.
 *
 * An importer may use runs/<date>/ instead of re-reading the whole day bundle, but only
 * when that folder really holds the entire day. It doesn't when the engine was started
 * mid-session or predates this layout, so the count is published in the manifest and the
 * folder is never assumed to be complete just because it exists.
 */
async function countRunFiles(dir) {
  const names = await fsp.readdir(dir).catch(() => []);
  return names.filter((f) => /^run-.*\.json$/i.test(f)).length;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Hardlink when possible (same volume, zero extra disk) and fall back to a copy. */
async function linkOrCopy(src, dest) {
  try {
    await fsp.link(src, dest);
  } catch (err) {
    if (err.code === 'EEXIST') return;
    await fsp.copyFile(src, dest);
  }
}

export class Archive {
  constructor(opts = {}) {
    this.root = opts.root || config.paths.exports;
    this.shotsRoot = path.join(this.root, 'shots');
    this.enabled = opts.enabled ?? config.archive.enabled;
    // Cached bundle for the day being written, so a 1-minute cadence doesn't
    // re-read a growing JSON file every cycle.
    this.cache = null;
    // Day whose runs/<date>/ mirror has already been reconciled this process.
    this.syncedDay = null;
    // Serialises writers: runs finish while a rebuild may be in flight.
    this.queue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) return;
    await fsp.mkdir(this.shotsRoot, { recursive: true });
  }

  bundlePath(date, embedded = false) {
    return path.join(this.root, bundleName(date, embedded));
  }

  /** Re-points a run's shots at the archive layout so bundles survive being moved. */
  static runForArchive(run, date) {
    return {
      ...run,
      shots: (run.shots || []).map((shot) => ({
        ...shot,
        shotUrl: shot.file ? `shots/${date}/${shot.file}` : undefined,
      })),
    };
  }

  emptyBundle(date) {
    return {
      schema: SCHEMA,
      date,
      images: 'external',
      exportedAt: new Date().toISOString(),
      source: {
        app: 'liveImageAnalsis',
        model: config.ollama.model,
        intervalSeconds: config.intervalMs / 1000,
        market: `${config.market.open}-${config.market.close} ${config.market.tz}`,
      },
      runs: [],
    };
  }

  async loadBundle(date) {
    if (this.cache?.date === date) return this.cache.bundle;
    const existing = await readJson(this.bundlePath(date));
    const bundle =
      existing && Array.isArray(existing.runs) ? { ...this.emptyBundle(date), ...existing } : this.emptyBundle(date);
    this.cache = { date, bundle };
    return bundle;
  }

  /** Appends one finished run: copies its screenshots, updates the day bundle + manifest. */
  async addRun(run) {
    if (!this.enabled || !run?.id) return null;
    this.queue = this.queue
      .then(() => this._addRun(run))
      .catch((err) => {
        console.error('[archive] failed to write run', run.id, err.message);
        return null;
      });
    return this.queue;
  }

  async _addRun(run) {
    const date = dayOfRun(run);
    await this.copyShots([run], date);

    const bundle = await this.loadBundle(date);
    const entry = Archive.runForArchive(run, date);
    const idx = bundle.runs.findIndex((r) => r.id === entry.id);
    if (idx >= 0) bundle.runs[idx] = entry;
    else bundle.runs.push(entry);
    bundle.exportedAt = new Date().toISOString();

    await this.writeRunFile(entry, date);
    // The engine may have been started mid-session, leaving runs/<date>/ missing every run
    // captured before it came up. Healing once per day keeps that folder a complete mirror.
    if (this.syncedDay !== date) {
      await this.syncRunFiles(bundle, date);
      this.syncedDay = date;
    }
    await writeJsonAtomic(this.bundlePath(date), bundle);
    await this.writeManifest();
    return { date, runs: bundle.runs.length };
  }

  /** Writes a per-run file for every run in the bundle that doesn't have one yet. */
  async syncRunFiles(bundle, date) {
    const dir = path.join(this.root, 'runs', date);
    await fsp.mkdir(dir, { recursive: true });
    const present = new Set(await fsp.readdir(dir).catch(() => []));
    for (const entry of bundle.runs) {
      if (!present.has(runFileName(entry, date))) await this.writeRunFile(entry, date);
    }
  }

  /** Writes the immutable per-run file used by the dashboard's folder auto-sync. */
  async writeRunFile(entry, date = dayOfRun(entry)) {
    const dir = path.join(this.root, 'runs', date);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, runFileName(entry, date));
    await writeJsonAtomic(file, {
      schema: SCHEMA,
      date,
      images: 'external',
      exportedAt: new Date().toISOString(),
      runs: [entry],
    });
    return file;
  }

  async copyShots(runs, date) {
    const shotDir = path.join(this.shotsRoot, date);
    await fsp.mkdir(shotDir, { recursive: true });
    for (const run of runs) {
      for (const shot of run.shots || []) {
        if (!shot.file) continue;
        const src = path.join(config.paths.shots, shot.file);
        if (!fs.existsSync(src)) continue;
        await linkOrCopy(src, path.join(shotDir, shot.file)).catch(() => {});
      }
    }
  }

  /**
   * Rebuilds index.json from the bundles actually present on disk.
   *
   * `latestRunId` / `latestRunAt` let a polling dashboard fetch this one small file and
   * stop immediately when nothing new has been captured since its last sync.
   */
  async writeManifest() {
    const files = (await fsp.readdir(this.root).catch(() => [])).filter((f) =>
      /^vision-\d{4}-\d{2}-\d{2}\.json$/.test(f),
    );
    const days = [];
    for (const file of files.sort()) {
      const bundle = await readJson(path.join(this.root, file));
      if (!bundle?.runs) continue;
      const runs = bundle.runs;
      const stat = await fsp.stat(path.join(this.root, file)).catch(() => null);
      const embeddedPath = this.bundlePath(bundle.date, true);
      const embeddedStat = fs.existsSync(embeddedPath) ? await fsp.stat(embeddedPath).catch(() => null) : null;
      days.push({
        date: bundle.date,
        bundle: file,
        embeddedBundle: embeddedStat ? bundleName(bundle.date, true) : undefined,
        // An embedded copy is only a faithful snapshot of the day while it is at least as
        // new as the bundle it was built from. Re-exporting without --embed leaves the old
        // one behind, so it is flagged rather than silently advertised as current.
        embeddedStale: embeddedStat ? embeddedStat.mtimeMs < (stat?.mtimeMs ?? 0) : undefined,
        runsDir: `runs/${bundle.date}`,
        runFiles: await countRunFiles(path.join(this.root, 'runs', bundle.date)),
        runs: runs.length,
        shots: runs.reduce((n, r) => n + (r.shots?.filter((s) => s.file).length || 0), 0),
        firstRunAt: runs[0]?.startedAt || null,
        lastRunAt: runs[runs.length - 1]?.startedAt || null,
        latestRunId: runs[runs.length - 1]?.id || null,
        bytes: stat?.size || 0,
      });
    }

    const sorted = days.sort((a, b) => b.date.localeCompare(a.date));
    const newest = sorted[0];
    const manifest = {
      schema: SCHEMA,
      generatedAt: new Date().toISOString(),
      model: config.ollama.model,
      latestRunId: newest?.latestRunId || null,
      latestRunAt: newest?.lastRunAt || null,
      days: sorted,
      totals: {
        days: days.length,
        runs: days.reduce((n, d) => n + d.runs, 0),
        shots: days.reduce((n, d) => n + d.shots, 0),
      },
    };
    await writeJsonAtomic(path.join(this.root, 'index.json'), manifest);
    return manifest;
  }

  async manifest() {
    return (await readJson(path.join(this.root, 'index.json'))) || (await this.writeManifest());
  }

  /**
   * Re-exports every run in history.jsonl. Used by the CLI and /api/archive/rebuild so
   * an archive can be produced for runs captured before this feature existed.
   */
  async rebuild({ runs, embed = false, date: onlyDate } = {}) {
    await fsp.mkdir(this.shotsRoot, { recursive: true });
    const all = runs || (await readHistory());
    const byDay = new Map();
    for (const run of all) {
      const date = dayOfRun(run);
      if (onlyDate && date !== onlyDate) continue;
      if (!byDay.has(date)) byDay.set(date, []);
      byDay.get(date).push(run);
    }

    const written = [];
    for (const [date, dayRuns] of byDay) {
      await this.copyShots(dayRuns, date);
      const bundle = this.emptyBundle(date);
      bundle.runs = dayRuns
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map((r) => Archive.runForArchive(r, date));
      await writeJsonAtomic(this.bundlePath(date), bundle);
      for (const r of bundle.runs) await this.writeRunFile(r, date);
      const entry = { date, runs: bundle.runs.length, file: bundleName(date) };
      // Refresh an embedded copy that already exists even when --embed wasn't asked for:
      // leaving a half-day snapshot next to a full bundle is how a stale import happens.
      if (embed || fs.existsSync(this.bundlePath(date, true))) entry.embedded = await this.embed(bundle, date);
      written.push(entry);
    }

    this.cache = null;
    this.syncedDay = null;
    const manifest = await this.writeManifest();
    return { days: written.sort((a, b) => b.date.localeCompare(a.date)), manifest };
  }

  /** Inlines every screenshot as a data URL, producing one self-contained file. */
  async embed(bundle, date) {
    const shotDir = path.join(this.shotsRoot, date);
    let imageBytes = 0;
    const runs = [];
    for (const run of bundle.runs) {
      const shots = [];
      for (const shot of run.shots || []) {
        if (!shot.file) {
          shots.push(shot);
          continue;
        }
        try {
          const buf = await fsp.readFile(path.join(shotDir, shot.file));
          imageBytes += buf.length;
          shots.push({ ...shot, image: `data:image/png;base64,${buf.toString('base64')}` });
        } catch {
          shots.push({ ...shot, error: shot.error || 'screenshot missing from archive' });
        }
      }
      runs.push({ ...run, shots });
    }
    const out = { ...bundle, images: 'embedded', exportedAt: new Date().toISOString(), runs };
    const file = this.bundlePath(date, true);
    await writeJsonAtomic(file, out);
    const stat = await fsp.stat(file).catch(() => null);
    return { file: bundleName(date, true), imageBytes, bytes: stat?.size || 0 };
  }

  /** Embeds an already-exported day, reading it back off disk. */
  async embedDate(date) {
    const bundle = await readJson(this.bundlePath(date));
    if (!bundle) throw new Error(`no archive bundle for ${date}`);
    const result = await this.embed(bundle, date);
    await this.writeManifest();
    return result;
  }

  async clear() {
    await fsp.rm(this.root, { recursive: true, force: true });
    this.cache = null;
    this.syncedDay = null;
    await fsp.mkdir(this.shotsRoot, { recursive: true });
    await this.writeManifest();
    return { ok: true };
  }
}

/** Streams history.jsonl without needing a live Store instance. */
export async function readHistory(file = config.paths.history) {
  if (!fs.existsSync(file)) return [];
  const runs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return runs;
}

export default Archive;
