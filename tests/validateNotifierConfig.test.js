import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateNotifierConfig,
  NotifierConfigError,
} from '../dist/app/validateNotifierConfig.js';

const baseConfig = {
  boardUrl: 'https://m.fmkorea.com/hotdeal',
  boardUrls: ['https://m.fmkorea.com/hotdeal'],
  crawlMode: 'http',
  requestIntervalMs: 180000,
  requestTimeoutMs: 20000,
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
  pollOnce: false,
  userAgent: 'test',
  playwrightHeadless: true,
  playwrightNavigationTimeoutMs: 20000,
  playwrightWaitAfterLoadMs: 900,
  enableLegacyDomFallbackScrape: false,
  keywords: [],
};

const makeConfig = (overrides = {}) => ({
  ...baseConfig,
  notifier: {
    slackWebhookUrl: undefined,
    telegramBotToken: undefined,
    telegramChatId: undefined,
    discordWebhookUrl: undefined,
    targets: [],
    dryRun: false,
    ...overrides,
  },
});

test('validateNotifierConfig throws when no notifier configured and not dry-run', () => {
  const config = makeConfig();
  assert.throws(
    () => validateNotifierConfig(config),
    (err) => err instanceof NotifierConfigError && err.target === 'all'
  );
});

test('validateNotifierConfig passes in dry-run mode with no notifiers', () => {
  const config = makeConfig({ dryRun: true });
  const result = validateNotifierConfig(config);
  assert.strictEqual(result.slackConfigured, false);
  assert.strictEqual(result.telegramConfigured, false);
  assert.strictEqual(result.discordConfigured, false);
});

test('validateNotifierConfig throws when slack selected but webhook missing', () => {
  const config = makeConfig({ targets: ['slack'] });
  assert.throws(
    () => validateNotifierConfig(config),
    (err) =>
      err instanceof NotifierConfigError &&
      err.target === 'slack' &&
      err.missing.includes('SLACK_WEBHOOK_URL')
  );
});

test('validateNotifierConfig throws when telegram selected but credentials missing', () => {
  const config = makeConfig({ targets: ['telegram'] });
  assert.throws(
    () => validateNotifierConfig(config),
    (err) =>
      err instanceof NotifierConfigError && err.target === 'telegram'
  );
});

test('validateNotifierConfig throws when discord selected but webhook missing', () => {
  const config = makeConfig({ targets: ['discord'] });
  assert.throws(
    () => validateNotifierConfig(config),
    (err) =>
      err instanceof NotifierConfigError && err.target === 'discord'
  );
});

test('validateNotifierConfig passes with slack webhook configured', () => {
  const config = makeConfig({ slackWebhookUrl: 'https://hooks.slack.com/test' });
  const result = validateNotifierConfig(config);
  assert.strictEqual(result.slackConfigured, true);
  assert.strictEqual(result.telegramConfigured, false);
  assert.strictEqual(result.discordConfigured, false);
});

test('validateNotifierConfig passes with telegram configured', () => {
  const config = makeConfig({
    telegramBotToken: 'bot123',
    telegramChatId: '-100123',
  });
  const result = validateNotifierConfig(config);
  assert.strictEqual(result.telegramConfigured, true);
});

test('validateNotifierConfig passes with discord webhook configured', () => {
  const config = makeConfig({
    discordWebhookUrl: 'https://discord.com/api/webhooks/test',
  });
  const result = validateNotifierConfig(config);
  assert.strictEqual(result.discordConfigured, true);
});
