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
