import assert from 'node:assert/strict';
import test from 'node:test';

test('lambda handler module exports handler function', async () => {
  const mod = await import('../dist/entrypoints/lambda.js');
  assert.strictEqual(typeof mod.handler, 'function');
});

test('lambda handler runs a poll cycle with mock fetch', async () => {
  const html = `
    <html><body>
      <a href="https://www.fmkorea.com/99999">삼다수 테스트</a>
    </body></html>
  `;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  // Set minimal env for lambda
  const envBackup = { ...process.env };
  process.env.STATE_BACKEND = 'memory';
  process.env.DRY_RUN = 'true';
  process.env.CRAWL_MODE = 'http';
  process.env.ALERT_KEYWORDS = '삼다수';
  process.env.FMKOREA_BOARD_URL = 'https://www.fmkorea.com/hotdeal';
  process.env.RUN_ONCE = 'true';

  try {
    const { handler } = await import('../dist/entrypoints/lambda.js');
    const result = await handler({});
    assert.strictEqual(result.statusCode, 200);

    const body = JSON.parse(result.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.candidates, 'number');
  } finally {
    globalThis.fetch = originalFetch;
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, envBackup);
  }
});
