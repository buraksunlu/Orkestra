'use strict';
// Account-wide rate limits (5h and 7d) arrive in every session's status line, but each claude process only
// knows what its own last API response said. An idle session keeps sending an old, lower number for the
// same window, so "the newest status line wins" makes the bar jump between values.
//
// Each window is identified by its reset time. Within one window usage only grows, so the highest value is
// the freshest. A later reset time means a new window has started; an earlier one is a stale session.

const SAME_WINDOW_S = 600; // reset times this close are treated as the same window

function mergeWindow(cur, inc) {
  if (!inc || typeof inc.used_percentage !== 'number') return cur || null;
  if (!cur || !cur.resets_at || !inc.resets_at) return { ...inc };
  if (inc.resets_at > cur.resets_at + SAME_WINDOW_S) return { ...inc };
  if (inc.resets_at < cur.resets_at - SAME_WINDOW_S) return cur;
  return {
    ...cur,
    ...inc,
    used_percentage: Math.max(cur.used_percentage ?? 0, inc.used_percentage),
    resets_at: Math.max(cur.resets_at, inc.resets_at),
  };
}

function mergeLimits(cur, inc, now = Date.now()) {
  if (!inc) return cur || null;
  const c = cur || {};
  return {
    ...c,
    five_hour: mergeWindow(c.five_hour, inc.five_hour),
    seven_day: mergeWindow(c.seven_day, inc.seven_day),
    at: now,
  };
}

module.exports = { mergeLimits };
