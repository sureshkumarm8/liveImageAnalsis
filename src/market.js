import config from './config.js';

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

const WEEKEND = ['Sat', 'Sun'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock pieces of `now` as seen in the market timezone (IST has no DST). */
function parts(now) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.market.tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return {
    weekday: get('weekday'),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Calendar date in the market timezone, e.g. "2026-09-05". Used to bound "today". */
export const marketDate = (now = new Date()) => parts(now).date;

/**
 * The trading window as minutes-from-midnight, plus an optional tolerance either side.
 * `marginMin` is only used for keeping the model warm, never for deciding whether to capture.
 */
export function window_(margin = 0) {
  return { openMin: toMin(config.market.open) - margin, closeMin: toMin(config.market.close) + margin };
}

/**
 * Is the exchange trading right now? Strictly MARKET_OPEN..MARKET_CLOSE on a weekday.
 * Public holidays are not tracked — pause the schedule by hand on those days.
 */
export function isMarketOpen(now = new Date()) {
  const { weekday, hour, minute } = parts(now);
  if (WEEKEND.includes(weekday)) return false;
  const mins = hour * 60 + minute;
  const { openMin, closeMin } = window_();
  return mins >= openMin && mins <= closeMin;
}

/** Wider window used only to decide whether the model is worth keeping resident. */
export function isMarketWarm(now = new Date()) {
  const { weekday, hour, minute } = parts(now);
  if (WEEKEND.includes(weekday)) return false;
  const mins = hour * 60 + minute;
  const { openMin, closeMin } = window_(config.market.marginMin);
  return mins >= openMin && mins <= closeMin;
}

/** Epoch ms of the next moment the market opens (today if it hasn't opened yet). */
export function nextOpenAt(now = new Date()) {
  const { weekday, hour, minute, second } = parts(now);
  const { openMin } = window_();
  const nowMin = hour * 60 + minute;
  const dayIdx = DAYS.indexOf(weekday);

  // Today still counts if it's a weekday and the open hasn't passed yet.
  let daysAhead = 0;
  if (WEEKEND.includes(weekday) || nowMin >= openMin) {
    daysAhead = 1;
    while (WEEKEND.includes(DAYS[(dayIdx + daysAhead) % 7])) daysAhead += 1;
  }

  const deltaMs = daysAhead * 86400000 + (openMin - nowMin) * 60000 - second * 1000;
  return now.getTime() + deltaMs;
}

/** Epoch ms of today's open, used as the left edge of the "whole day" trend window. */
export function todayOpenAt(now = new Date()) {
  const { hour, minute, second } = parts(now);
  const { openMin } = window_();
  return now.getTime() + ((openMin - (hour * 60 + minute)) * 60000 - second * 1000);
}

/** Everything the dashboard needs to explain why the scheduler is or isn't running. */
export function marketStatus(now = new Date()) {
  const open = isMarketOpen(now);
  return {
    open,
    warm: isMarketWarm(now),
    tz: config.market.tz,
    opensAt: config.market.open,
    closesAt: config.market.close,
    nextOpenAt: open ? null : nextOpenAt(now),
  };
}

export default { isMarketOpen, isMarketWarm, nextOpenAt, todayOpenAt, marketStatus, marketDate };
