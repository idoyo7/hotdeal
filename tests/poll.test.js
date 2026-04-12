import assert from 'node:assert/strict';
import test from 'node:test';

import { pollOnce } from '../dist/app/poll.js';

const makeConfig = (overrides = {}) => ({
  boardUrl: 'https://www.fmkorea.com/hotdeal',
  boardUrls: ['https://www.fmkorea.com/hotdeal'],
  crawlMode: 'http',
  requestIntervalMs: 1000,
  requestTimeoutMs: 5000,
  maxPagesPerPoll: 1,
  maxItemsPerPoll: 30,
  startupMaxPagesPerPoll: 1,
  startupMaxItemsPerPoll: 30,
  seenStateFile: '',
  useFileState: false,
  useRedisState: false,
  redisKeyPrefix: 'hotdeal:seen:',
  redisTtlSeconds: 604800,
  stateBackend: 'memory',
  dynamoTableName: 'hotdeal-seen-posts',
  dynamoTtlSeconds: 604800,
  leaderElectionEnabled: false,
  leaderElectionLeaseName: 'test',
  leaderElectionNamespace: 'default',
  leaderElectionIdentity: 'test',
  leaderElectionLeaseDurationSeconds: 30,
  leaderElectionRenewIntervalMs: 10000,
  logLevel: 'info',
  pollOnce: true,
  userAgent: 'test-agent',
  playwrightHeadless: true,
  playwrightNavigationTimeoutMs: 15000,
  playwrightWaitAfterLoadMs: 900,
  enableLegacyDomFallbackScrape: false,
  keywords: ['삼다수'],
  notifier: {
    dryRun: true,
    targets: [],
  },
  ...overrides,
});

/** Minimal in-memory StateStore mock implementing the interface */
const createMockStore = () => {
  const seen = new Set();
  return {
    persistsOnWrite: false,
    backendName: 'mock',
    load: async () => {},
    save: async () => {},
    has: async (id) => seen.has(id),
    add: async (id) => { seen.add(id); },
    claim: async (id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    unclaim: async (id) => { seen.delete(id); },
    close: async () => {},
    _seen: seen,
  };
};

test('pollOnce returns cycle result with fresh posts in dry-run', async () => {
  const html = `
    <html><body>
      <a href="https://www.fmkorea.com/12345">삼다수 특가 이벤트</a>
    </body></html>
  `;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const config = makeConfig();
    const store = createMockStore();
    const result = await pollOnce(config, store);

    assert.strictEqual(result.candidateCount, 1);
    assert.strictEqual(result.freshCount, 1);
    assert.strictEqual(result.dryRunPostCount, 1);
    assert.strictEqual(result.notifiedPostCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollOnce skips already claimed posts', async () => {
  const html = `
    <html><body>
      <a href="https://www.fmkorea.com/12345">삼다수 특가</a>
    </body></html>
  `;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const config = makeConfig();
    const store = createMockStore();

    // First poll claims the post
    const result1 = await pollOnce(config, store);
    assert.strictEqual(result1.freshCount, 1);

    // Second poll skips the already-claimed post
    const result2 = await pollOnce(config, store);
    assert.strictEqual(result2.freshCount, 0);
    assert.strictEqual(result2.skippedAlreadyProcessedCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pollOnce claims are released on unclaim for retry', async () => {
  const store = createMockStore();
  await store.claim('post-1');
  assert.strictEqual(await store.claim('post-1'), false);
  await store.unclaim('post-1');
  assert.strictEqual(await store.claim('post-1'), true);
});
