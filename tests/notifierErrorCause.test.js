import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAlerts } from '../dist/notifier.js';

// deliveryMaxAttempts: 1 로 재시도 로직을 배제하고 원인 추출 자체만 검증한다.
const baseConfig = (overrides = {}) => ({
  requestTimeoutMs: 5000,
  deliveryMaxAttempts: 1,
  deliveryRetryBaseMs: 500,
  notifier: {
    dryRun: false,
    targets: ['telegram'],
    telegramBotToken: 'test-token',
    telegramChatId: 'test-chat',
  },
  ...overrides,
});

test('preserves error.cause.code in the failure message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('fetch failed');
    error.cause = { code: 'ETIMEDOUT', address: '149.154.166.110' };
    throw error;
  };

  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw']);
    assert.strictEqual(results[0].ok, false);
    assert.match(results[0].message, /ETIMEDOUT/);
    assert.match(results[0].message, /149\.154\.166\.110/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preserves every code in an AggregateError-like cause.errors array', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error('fetch failed');
    error.cause = {
      errors: [
        { code: 'ETIMEDOUT', address: '149.154.166.110' },
        { code: 'ENETUNREACH', address: '2001:67c:4e8:f004::9' },
      ],
    };
    throw error;
  };

  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw']);
    assert.strictEqual(results[0].ok, false);
    assert.match(results[0].message, /ETIMEDOUT/);
    assert.match(results[0].message, /ENETUNREACH/);
    assert.match(results[0].message, /149\.154\.166\.110/);
    assert.match(results[0].message, /2001:67c:4e8:f004::9/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
