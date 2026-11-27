'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mergeLimits } = require('../src/main/limits');

const W = 1795778400; // a 5h window's reset time (unix seconds)
const rl = (five, fiveAt = W, seven = 22, sevenAt = W + 4 * 86400) => ({
  five_hour: { used_percentage: five, resets_at: fiveAt },
  seven_day: { used_percentage: seven, resets_at: sevenAt },
});

test('an idle session reporting an older, lower value for the same window does not pull the number down', () => {
  let L = mergeLimits(null, rl(89));
  L = mergeLimits(L, rl(51));
  assert.equal(L.five_hour.used_percentage, 89);
  L = mergeLimits(L, rl(81));
  assert.equal(L.five_hour.used_percentage, 89);
  L = mergeLimits(L, rl(90));
  assert.equal(L.five_hour.used_percentage, 90);
});

test('a later reset time is a new window and replaces the old one, even with a lower value', () => {
  let L = mergeLimits(null, rl(97));
  L = mergeLimits(L, rl(3, W + 5 * 3600));
  assert.deepEqual(L.five_hour, { used_percentage: 3, resets_at: W + 5 * 3600 });
  // a stale session still reporting the previous window is ignored
  L = mergeLimits(L, rl(97, W));
  assert.equal(L.five_hour.used_percentage, 3);
});

test('each window is merged on its own; missing parts keep what was known', () => {
  let L = mergeLimits(null, rl(40, W, 20));
  L = mergeLimits(L, { five_hour: { used_percentage: 30, resets_at: W } });
  assert.equal(L.five_hour.used_percentage, 40);
  assert.equal(L.seven_day.used_percentage, 20);
  L = mergeLimits(L, rl(41, W, 25));
  assert.equal(L.seven_day.used_percentage, 25);
});

test('values without a reset time are taken as they come', () => {
  const L = mergeLimits(rl(50), { five_hour: { used_percentage: 10 } });
  assert.equal(L.five_hour.used_percentage, 10);
});
