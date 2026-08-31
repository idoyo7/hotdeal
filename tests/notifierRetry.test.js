import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAlerts } from '../dist/notifier.js';

const baseConfig = (overrides = {}) => ({
  requestTimeoutMs: 5000,
  deliveryMaxAttempts: 3,
  deliveryRetryBaseMs: 500,
  notifier: {
    dryRun: false,
    targets: ['telegram'],
    telegramBotToken: 'test-token',
    telegramChatId: 'test-chat',
  },
  ...overrides,
});

test('retries a network exception and succeeds on the 3rd attempt', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error('fetch failed');
    }
    return new Response('{"ok":true}', { status: 200 });
  };

  const sleeps = [];
  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw'], {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    assert.strictEqual(calls, 3);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, true);
    assert.deepStrictEqual(sleeps, [500, 1000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gives up immediately on a non-retryable HTTP 401', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  };

  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw'], {
      sleep: async () => {},
    });

    assert.strictEqual(calls, 1);
    assert.strictEqual(results[0].ok, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('honors the Retry-After header on 429, capped at 10s', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '2' },
      });
    }
    return new Response('{"ok":true}', { status: 200 });
  };

  const sleeps = [];
  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw'], {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    assert.deepStrictEqual(sleeps, [2000]);
    assert.strictEqual(results[0].ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gives up after all attempts fail and carries the last failure reason', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('server error', { status: 500 });
  };

  try {
    const results = await sendAlerts(baseConfig(), 'title', 'https://example.com/1', ['kw'], {
      sleep: async () => {},
    });

    assert.strictEqual(calls, 3);
    assert.strictEqual(results[0].ok, false);
    assert.match(results[0].message, /500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
