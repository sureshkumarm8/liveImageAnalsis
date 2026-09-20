#!/usr/bin/env node
import config from './config.js';
import Archive, { readHistory } from './archive.js';

/**
 * Exports the captured history to data/exports/ so the (possibly deployed) dashboard
 * can import it straight off disk.
 *
 *   npm run export                    re-export every day found in history.jsonl
 *   npm run export -- --embed         also write one self-contained file per day
 *   npm run export -- --date=2026-09-15
 *   npm run export -- --embed --date=2026-09-15
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const date = value('date');
  const embed = flag('embed');

  const runs = await readHistory();
  if (!runs.length) {
    console.log('No runs in', config.paths.history, '— nothing to export.');
    return;
  }

  const archive = new Archive({ enabled: true });
  const { days, manifest } = await archive.rebuild({ runs, embed, date });

  if (!days.length) {
    console.log(date ? `No runs found for ${date}.` : 'No runs to export.');
    return;
  }

  console.log(`Exported to ${archive.root}`);
  for (const day of days) {
    const extra = day.embedded ? `  + ${day.embedded.file} (${mb(day.embedded.bytes)})` : '';
    console.log(`  ${day.date}  ${String(day.runs).padStart(4)} runs  →  ${day.file}${extra}`);
  }
  console.log(`  index.json  ${manifest.totals.days} day(s), ${manifest.totals.runs} runs, ${manifest.totals.shots} shots`);
  console.log('\nIn the dashboard: Vision → Import data → pick the data/exports folder.');
}

main().catch((err) => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
