import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import config from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const vis = (locator, timeout = 1200) => locator.first().isVisible({ timeout }).catch(() => false);

const INTERVAL_BTN = '#header-toolbar-intervals button';
const INTERVAL_VALUE = '#header-toolbar-intervals .value-gwXludjS';
const RANGE_TABS = '[data-name="date-ranges-tabs"] button';
const GOTO_BTN = '[data-name="go-to-date"]';
const GOTO_DIALOG = '[data-name="go-to-date-dialog"]';

/**
 * Screenshot options shared by every capture. `scale: 'device'` is what actually banks
 * the extra pixels from `deviceScaleFactor` — with 'css' Playwright would downsample
 * straight back to 1×. Animations/caret are frozen so no candle is caught mid-redraw.
 */
const SHOT_OPTS = { type: 'png', scale: 'device', animations: 'disabled', caret: 'hide', timeout: 30000 };

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** The Kite chart is a TradingView app inside a nested blob: iframe. */
async function findChartFrame(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const has = await f
        .locator(INTERVAL_BTN)
        .first()
        .count()
        .catch(() => 0);
      if (has) return f;
    }
    await sleep(1000);
  }
  return null;
}

/**
 * Set the candle interval via the toolbar dropdown (e.g. "1" = 1 minute, "1D" = 1 day).
 * The toolbar shows an abbreviated label ("1", "D", …) that doesn't match the data-value,
 * so we learn the label the first time we set it and use it to skip redundant clicks later.
 */
const intervalLabelCache = new Map();

async function setKiteInterval(frame, value) {
  const shown = (await frame.locator(INTERVAL_VALUE).first().textContent({ timeout: 8000 }).catch(() => '') || '').trim();
  if (shown && intervalLabelCache.get(value) === shown) return;

  await frame.locator(INTERVAL_BTN).first().click({ timeout: 8000 });
  await sleep(1200);

  const item = frame.locator(`[data-value="${value}"]`).first();
  if (!(await item.count().catch(() => 0))) {
    await frame.page().keyboard.press('Escape').catch(() => {});
    throw new Error(`interval "${value}" not offered by the chart`);
  }
  await item.click({ timeout: 8000 });
  await sleep(2500);

  const after = (await frame.locator(INTERVAL_VALUE).first().textContent({ timeout: 8000 }).catch(() => '') || '').trim();
  if (after) intervalLabelCache.set(value, after);
}

/**
 * Zoom the chart to the last `months` months via the toolbar's "Go to → Custom range"
 * dialog. The date-range tabs can't be used for this: they force their own resolution
 * (1yr always switches to weekly candles), whereas a custom range keeps the interval.
 */
async function setKiteDateRange(frame, months) {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - months);

  await frame.locator(GOTO_BTN).first().click({ timeout: 8000 });
  const dialog = frame.locator(GOTO_DIALOG).first();
  await dialog.waitFor({ state: 'visible', timeout: 8000 });

  try {
    await dialog.locator('#CustomRange').click({ timeout: 8000 });
    await sleep(800);

    const dates = dialog.locator('input:not([disabled])');
    await dates.nth(0).fill(isoDate(from), { timeout: 8000 });
    await dates.nth(1).fill(isoDate(to), { timeout: 8000 });
    await dialog.locator('[data-name="submit-button"]').click({ timeout: 8000 });
  } catch (err) {
    await frame.page().keyboard.press('Escape').catch(() => {});
    throw err;
  }
  await sleep(2500);
}

/**
 * Apply a candle interval, a date-range tab and/or a custom look-back window to the
 * Kite TradingView chart. Order matters: a range tab re-picks its own interval, and
 * changing the interval resets the visible window — so range, then interval, then
 * the custom window last.
 */
async function applyKiteView(page, { interval, range, months }) {
  if (!interval && !range && !months) return;

  const frame = await findChartFrame(page);
  if (!frame) throw new Error('chart toolbar not found');

  if (range) {
    const btn = frame
      .locator(RANGE_TABS)
      .filter({ hasText: new RegExp(`^${range}$`) })
      .first();
    if (!(await btn.count().catch(() => 0))) throw new Error(`range tab "${range}" not found`);
    await btn.click({ timeout: 8000 });
    await sleep(2000);
  }
  if (interval) await setKiteInterval(frame, interval);
  if (months) await setKiteDateRange(frame, months);
}

/**
 * Per-site behaviour: how to tell we're logged out, whether the page is showing
 * what we asked for, and how to steer it back if it drifted.
 */
const HOOKS = {
  kite: {
    async awaitingLogin(page) {
      const url = page.url();
      if (/#loggedout/i.test(url) || /\/connect\/login/i.test(url) || /\/logout/i.test(url)) return true;
      return vis(page.getByText('Login to Kite', { exact: false }));
    },
    onTarget(page) {
      return /markets\/ext\/chart\/web\/tvc\/INDICES\/NIFTY/i.test(decodeURIComponent(page.url()));
    },
    /**
     * The TradingView chart lives in a nested blob: iframe. Each cycle we make sure
     * the candle interval and the visible date range are what we asked for, since
     * Kite persists whatever was last left on screen.
     */
    async ensure(page) {
      const { kiteInterval, kiteRange } = config.browser;
      await applyKiteView(page, { interval: kiteInterval, range: kiteRange });
    },
    captureSelector: '.chart-frame',
  },

  sensibull: {
    async awaitingLogin(page) {
      return vis(page.getByText('Login to Continue', { exact: false }));
    },
    onTarget(page) {
      return /oi-vs-strike/i.test(page.url());
    },
    /** Sensibull restores its own last-used ticker, so force it back to NIFTY. */
    async ensure(page) {
      // The app intermittently drops into an "Oops! Something went wrong" state.
      const oops = page.getByText('Something went wrong', { exact: false });
      if (await vis(oops, 1500)) {
        const retry = page.getByRole('button', { name: /retry/i });
        if (await vis(retry, 1500)) await retry.first().click().catch(() => {});
        else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(7000);
        if (await vis(oops, 1500)) throw new Error('Sensibull still showing an error page after retry');
      }

      const symbol =
        (await page.locator('.instrument-symbol').first().textContent({ timeout: 8000 }).catch(() => null)) || '';
      if (symbol.trim().toUpperCase() === 'NIFTY') return;

      await page.click('.searchable-ticker-wrapper', { timeout: 8000 });
      await page.fill('input[placeholder*="Type stock name"]', 'NIFTY', { timeout: 8000 });
      await sleep(1500);
      await page
        .locator('li')
        .filter({ hasText: /^NIFTY$/ })
        .first()
        .click({ timeout: 8000 });
      await sleep(4000);
    },
    captureSelector: '.chart-and-chart-inputs',
  },
};

const noop = {
  awaitingLogin: async () => false,
  onTarget: () => true,
  ensure: async () => {},
  captureSelector: null,
};
const hooksFor = (id) => HOOKS[id] || noop;

export class Capture {
  constructor() {
    this.context = null;
    this.pages = new Map();
    this.cycle = 0;
    this.cdp = null;
    this.windowId = null;
    this.normalBounds = null;
    this.tucked = false;
    // Set when the user explicitly asks for the window via the dashboard, which
    // suppresses the automatic re-tuck on the next cycle.
    this.pinnedVisible = false;
    // Serialises everything that drives the shared pages, so a scheduled run and a
    // manual snapshot set can never fight over the chart's interval/range.
    this.queue = Promise.resolve();
    this.busy = false;
  }

  /** Run `fn` after any capture already in flight has finished. */
  serialise(fn) {
    const next = this.queue.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async init() {
    await fs.mkdir(config.paths.shots, { recursive: true });
    await fs.mkdir(config.browser.profileDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(config.browser.profileDir, {
      headless: config.browser.headless,
      viewport: { width: config.browser.width, height: config.browser.height },
      deviceScaleFactor: config.browser.deviceScaleFactor,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.context.setDefaultNavigationTimeout(config.browser.navTimeoutMs);

    const existing = this.context.pages();
    for (let i = 0; i < config.targets.length; i += 1) {
      const target = config.targets[i];
      const blank = existing[i] && existing[i].url() === 'about:blank' ? existing[i] : await this.context.newPage();
      this.pages.set(target.id, blank);
      await this.navigate(target.id);
    }

    for (const p of this.context.pages()) {
      if (![...this.pages.values()].includes(p)) await p.close().catch(() => {});
    }

    await this.initWindowControl();
    // Get out of the way immediately unless a manual login is already required.
    const needsLogin = (await Promise.all(config.targets.map((t) => this.loginState(t.id)))).some(Boolean);
    if (!needsLogin) await this.setTucked(true);
  }

  /** Grab a browser-level CDP session so we can move/resize the OS window. */
  async initWindowControl() {
    if (config.browser.headless) return;
    try {
      this.cdp = await this.context.browser().newBrowserCDPSession();
      const page = [...this.pages.values()][0];
      const session = await this.context.newCDPSession(page);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const { windowId, bounds } = await this.cdp.send('Browser.getWindowForTarget', {
        targetId: targetInfo.targetId,
      });
      this.windowId = windowId;
      this.normalBounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    } catch {
      this.cdp = null;
      this.windowId = null;
    }
  }

  get windowVisible() {
    return !this.tucked;
  }

  /**
   * Shrink the window and push it into the far corner (macOS clamps it back on-screen,
   * leaving only a sliver), or restore it to where it started.
   *
   * Note: minimising is deliberately not used — macOS stops compositing minimised windows
   * and screenshots then time out. A tiny corner window keeps rendering perfectly.
   */
  async setTucked(tucked) {
    if (!config.browser.tuckWindow || !this.cdp || this.windowId == null) return false;
    if (this.tucked === tucked) return true;
    const bounds = { windowId: this.windowId };
    try {
      await this.cdp.send('Browser.setWindowBounds', { ...bounds, bounds: { windowState: 'normal' } });
      if (tucked) {
        await this.cdp.send('Browser.setWindowBounds', {
          ...bounds,
          bounds: { width: config.browser.tuckWidth, height: config.browser.tuckHeight },
        });
        await this.cdp.send('Browser.setWindowBounds', { ...bounds, bounds: { left: 99999, top: 99999 } });
      } else if (this.normalBounds) {
        await this.cdp.send('Browser.setWindowBounds', { ...bounds, bounds: this.normalBounds });
      }
      this.tucked = tucked;
      return true;
    } catch {
      return false;
    }
  }

  async showWindow() {
    this.pinnedVisible = true;
    return this.setTucked(false);
  }

  async hideWindow() {
    this.pinnedVisible = false;
    return this.setTucked(true);
  }

  page(id) {
    return this.pages.get(id);
  }

  target(id) {
    return config.targets.find((t) => t.id === id);
  }

  /** Relaunch the persistent context if the browser window was closed or crashed. */
  async ensureContext() {
    const alive = this.context && this.context.browser() && this.context.browser().isConnected();
    if (alive) return;
    console.warn('Browser context is gone — relaunching...');
    this.pages.clear();
    this.cdp = null;
    this.windowId = null;
    this.tucked = false;
    await this.init();
  }

  async pageFor(id) {
    await this.ensureContext();
    const page = this.pages.get(id);
    if (!page || page.isClosed()) {
      const fresh = await this.context.newPage();
      this.pages.set(id, fresh);
      await this.navigate(id);
    }
    return this.pages.get(id);
  }

  async navigate(id) {
    const target = this.target(id);
    let page = this.pages.get(id);
    if (!page || page.isClosed()) {
      page = await this.context.newPage();
      this.pages.set(id, page);
    }
    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.browser.navTimeoutMs });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(config.browser.settleMs);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, url: page.url() };
  }

  /** Used by /api/status for the login badges in the UI. */
  async loginState(id) {
    const page = this.pages.get(id);
    if (!page || page.isClosed()) return null;
    return hooksFor(id).awaitingLogin(page);
  }

  async captureOne(id, stamp) {
    const target = this.target(id);
    const hooks = hooksFor(id);
    const page = await this.pageFor(id);
    const notes = [];

    let awaitingLogin = await hooks.awaitingLogin(page);

    if (!awaitingLogin) {
      // Recover from redirects (e.g. Kite lands on /dashboard right after a fresh login).
      if (!hooks.onTarget(page)) {
        notes.push('page had drifted off-target — re-navigated');
        await this.navigate(id);
        awaitingLogin = await hooks.awaitingLogin(page);
      }

      const periodicReload =
        config.browser.reloadEveryCycles > 0 && this.cycle > 0 && this.cycle % config.browser.reloadEveryCycles === 0;
      if (!awaitingLogin && periodicReload) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(config.browser.settleMs);
      }

      if (!awaitingLogin) {
        try {
          await hooks.ensure(page);
        } catch (err) {
          notes.push(`could not enforce view state: ${err.message.split('\n')[0]}`);
        }
      }
    }

    const file = `${stamp}-${id}.png`;
    const filePath = path.join(config.paths.shots, file);

    // Park the pointer off the plot so the crosshair and its price tag aren't baked
    // into the image on top of the real last-price label.
    await page.mouse.move(2, 2).catch(() => {});
    await sleep(300);

    try {
      let buffer = null;
      if (hooks.captureSelector && !awaitingLogin) {
        const el = page.locator(hooks.captureSelector).first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
          buffer = await el.screenshot(SHOT_OPTS).catch(() => null);
        }
      }
      if (!buffer) buffer = await page.screenshot(SHOT_OPTS);

      await fs.writeFile(filePath, buffer);
      return {
        id,
        label: target.label,
        url: page.url(),
        ok: true,
        awaitingLogin,
        notes,
        file,
        shotUrl: `/shots/${file}`,
        base64: buffer.toString('base64'),
        bytes: buffer.length,
      };
    } catch (err) {
      return { id, label: target.label, url: page.url(), ok: false, awaitingLogin, notes, error: err.message };
    }
  }

  async captureAll(stamp) {
    return this.serialise(async () => {
      const results = [];
      for (const target of config.targets) {
        results.push(await this.captureOne(target.id, stamp));
      }
      this.cycle += 1;

      // Pop the window back out when you need to log in, and tuck it away again once
      // the session is healthy (unless you asked to keep it visible).
      const needsLogin = results.some((r) => r.awaitingLogin);
      if (needsLogin) await this.setTucked(false);
      else if (!this.pinnedVisible) await this.setTucked(true);

      return results;
    });
  }

  /**
   * Screenshot one configured snapshot view, writing the PNG into `outDir`.
   * Reuses the already-open (and logged-in) page for the view's target site.
   */
  async captureSnapshotView(view, outDir, stamp) {
    const notes = [];
    const base = { id: view.id, label: view.label, target: view.target };

    try {
      const hooks = hooksFor(view.target);
      const page = await this.pageFor(view.target);
      if (await hooks.awaitingLogin(page)) {
        await this.setTucked(false);
        throw new Error(`login required for ${view.target}`);
      }

      if (view.url && page.url() !== view.url) {
        await page.goto(view.url, { waitUntil: 'domcontentloaded', timeout: config.browser.navTimeoutMs });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await sleep(config.browser.settleMs);
      }

      if (view.kite) {
        await applyKiteView(page, view.kite);
        await sleep(1500);
      } else {
        try {
          await hooks.ensure(page);
        } catch (err) {
          notes.push(`could not enforce view state: ${err.message.split('\n')[0]}`);
        }
      }

      const selectors = view.selectors || (hooks.captureSelector ? [hooks.captureSelector] : []);
      // Park the pointer off the plot so the crosshair isn't baked into the image.
      await page.mouse.move(2, 2).catch(() => {});
      await sleep(400);
      let buffer = null;
      for (const selector of selectors) {
        const el = page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
          buffer = await el.screenshot(SHOT_OPTS).catch(() => null);
          if (buffer) break;
        }
      }
      if (!buffer) {
        notes.push('fell back to a full-page screenshot');
        buffer = await page.screenshot(SHOT_OPTS);
      }

      const file = `${stamp}-${view.id}.png`;
      const filePath = path.join(outDir, file);
      await fs.writeFile(filePath, buffer);
      return { ...base, ok: true, file, path: filePath, bytes: buffer.length, notes };
    } catch (err) {
      return { ...base, ok: false, error: err.message.split('\n')[0], notes };
    }
  }

  /**
   * Capture the full set of configured snapshot views into the Downloads folder,
   * then put both sites back on the view the scheduler expects.
   */
  async captureSnapshotSet({ dir } = {}) {
    return this.serialise(async () => {
      const outDir = dir || config.paths.downloads;
      await fs.mkdir(outDir, { recursive: true });

      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
        d.getMinutes(),
      )}${p(d.getSeconds())}`;

      const results = [];
      try {
        for (const view of config.snapshots) {
          results.push(await this.captureSnapshotView(view, outDir, stamp));
        }
      } finally {
        await this.restoreDefaultViews().catch(() => {});
      }

      return { dir: outDir, stamp, results };
    });
  }

  /** Undo whatever the snapshot set changed, so scheduled captures stay consistent. */
  async restoreDefaultViews() {
    for (const target of config.targets) {
      const page = this.pages.get(target.id);
      if (!page || page.isClosed()) continue;
      try {
        if (page.url() !== target.url && !hooksFor(target.id).onTarget(page)) {
          await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: config.browser.navTimeoutMs });
          await sleep(config.browser.settleMs);
        }
        if (target.id === 'kite') {
          await applyKiteView(page, { interval: config.browser.kiteInterval, range: config.browser.kiteRange });
        }
      } catch {
        // Best effort — the next scheduled cycle re-applies the view anyway.
      }
    }
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.pages.clear();
  }
}

export default Capture;
