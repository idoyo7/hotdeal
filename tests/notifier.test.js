import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAlerts } from '../dist/notifier.js';

test('sendAlerts returns dry-run result when webhook targets are not configured', async () => {
  const result = await sendAlerts(
    {
      notifier: {
        dryRun: true,
        slackWebhookUrl: undefined,
        telegramBotToken: undefined,
        telegramChatId: undefined,
      },
    },
    'title',
    'https://www.fmkorea.com/sample',
    ['삼다수']
  );

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].target, 'dry-run');
  assert.ok(result[0].ok);
  assert.ok(result[0].message?.includes('title'));
});

const withMockFetch = async (handler, run) => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };

  try {
    await run(calls);
  } finally {
    global.fetch = previousFetch;
  }
};

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

test('sendAlerts appends telegram mention for a matched mention-rule keyword', async () => {
  await withMockFetch(
    (url) => {
      assert.ok(url.includes('api.telegram.org'));
      return okResponse();
    },
    async (calls) => {
      const results = await sendAlerts(
        {
          requestTimeoutMs: 5000,
          deliveryMaxAttempts: 1,
          deliveryRetryBaseMs: 10,
          notifier: {
            dryRun: false,
            telegramBotToken: 'bot-token',
            telegramChatId: 'chat-id',
            telegramMentionRules: [{ keyword: '보먹돼', targets: ['@mont'] }],
          },
        },
        'title',
        'https://www.fmkorea.com/sample',
        ['보먹돼']
      );

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].ok, true);
      const body = JSON.parse(calls[0].init.body);
      assert.ok(body.text.includes('CC: @mont'));
    }
  );
});

test('sendAlerts omits telegram mention when matched keyword has no mention rule', async () => {
  await withMockFetch(
    () => okResponse(),
    async (calls) => {
      await sendAlerts(
        {
          requestTimeoutMs: 5000,
          deliveryMaxAttempts: 1,
          deliveryRetryBaseMs: 10,
          notifier: {
            dryRun: false,
            telegramBotToken: 'bot-token',
            telegramChatId: 'chat-id',
            telegramMentionRules: [{ keyword: '보먹돼', targets: ['@mont'] }],
          },
        },
        'title',
        'https://www.fmkorea.com/sample',
        ['다른키워드']
      );

      const body = JSON.parse(calls[0].init.body);
      assert.ok(!body.text.includes('CC:'));
    }
  );
});

test('sendAlerts renders a numeric mention target as an unescaped tg:// link', async () => {
  await withMockFetch(
    () => okResponse(),
    async (calls) => {
      await sendAlerts(
        {
          requestTimeoutMs: 5000,
          deliveryMaxAttempts: 1,
          deliveryRetryBaseMs: 10,
          notifier: {
            dryRun: false,
            telegramBotToken: 'bot-token',
            telegramChatId: 'chat-id',
            telegramMentionRules: [{ keyword: '보먹돼', targets: ['123456789'] }],
          },
        },
        'title',
        'https://www.fmkorea.com/sample',
        ['보먹돼']
      );

      const body = JSON.parse(calls[0].init.body);
      assert.ok(body.text.includes('CC: <a href="tg://user?id=123456789">123456789</a>'));
    }
  );
});

test('sendAlerts does not add telegram mentions to the slack message body', async () => {
  await withMockFetch(
    () => okResponse(),
    async (calls) => {
      await sendAlerts(
        {
          requestTimeoutMs: 5000,
          deliveryMaxAttempts: 1,
          deliveryRetryBaseMs: 10,
          notifier: {
            dryRun: false,
            slackWebhookUrl: 'https://hooks.slack.example/webhook',
            telegramBotToken: 'bot-token',
            telegramChatId: 'chat-id',
            telegramMentionRules: [{ keyword: '보먹돼', targets: ['@mont'] }],
          },
        },
        'title',
        'https://www.fmkorea.com/sample',
        ['보먹돼']
      );

      const slackCall = calls.find((call) => call.url.includes('hooks.slack.example'));
      const slackBody = JSON.parse(slackCall.init.body);
      assert.ok(!slackBody.text.includes('CC:'));
      assert.ok(!slackBody.text.includes('@mont'));
    }
  );
});
