import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { applyNetworkFamilyPolicy, logStartupTimezone } from '../dist/net.js';
import { setLogLevel } from '../dist/logger.js';

const captureLog = (run) => {
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return captured;
};

test('applyNetworkFamilyPolicy disables autoSelectFamily', () => {
  const original = net.getDefaultAutoSelectFamily();
  try {
    applyNetworkFamilyPolicy(false);
    assert.strictEqual(net.getDefaultAutoSelectFamily(), false);
  } finally {
    net.setDefaultAutoSelectFamily(original);
  }
});

test('applyNetworkFamilyPolicy enables autoSelectFamily', () => {
  const original = net.getDefaultAutoSelectFamily();
  try {
    applyNetworkFamilyPolicy(true);
    assert.strictEqual(net.getDefaultAutoSelectFamily(), true);
  } finally {
    net.setDefaultAutoSelectFamily(original);
  }
});

test('logStartupTimezone logs the resolved timezone and its UTC offset in minutes', () => {
  setLogLevel('info');

  const captured = captureLog(() => {
    logStartupTimezone();
  });

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.event, 'monitor.startup.timezone');
  assert.strictEqual(parsed.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.strictEqual(parsed.offsetMinutes, -new Date().getTimezoneOffset());
});
