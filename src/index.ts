import {
  fetchLatestPosts,
  findMatchingPosts,
  keywordMatchesTitle,
  closeSharedBrowser,
} from './monitor.js';
import { unlinkSync, writeFileSync } from 'node:fs';
import { getConfig, AppConfig, type NotifierTarget } from './config.js';
import { StateStore } from './stateStore.js';
import { sendAlerts, type DeliveryResult } from './notifier.js';
import { LeaderElector } from './leaderElection.js';
import { logger, setLogLevel } from './logger.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const readinessPath = '/tmp/monitor-ready';

const setReadinessMarker = (ready: boolean): void => {
  try {
    if (ready) {
      writeFileSync(readinessPath, 'ready\n', 'utf8');
      return;
    }
    unlinkSync(readinessPath);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.debug('readiness marker update failed', {
      event: 'monitor.readiness.markerFailed',
      ready,
      path: readinessPath,
      reason,
    });
  }
};

const waitUntilNextPollOrShutdown = async (
  totalMs: number,
  shouldStop: () => boolean
): Promise<void> => {
  let remaining = Math.max(0, totalMs);
  while (remaining > 0) {
    if (shouldStop()) {
      return;
    }

    const chunk = Math.min(1_000, remaining);
    await wait(chunk);
    remaining -= chunk;
  }
};

const findMatches = (postTitle: string, keywords: string[]): string[] =>
  keywords.filter((keyword) => keywordMatchesTitle(postTitle, keyword));

type PollCycleResult = {
  candidateCount: number;
  freshCount: number;
  notifiedPostCount: number;
  dryRunPostCount: number;
  failedPostCount: number;
  skippedAlreadyProcessedCount: number;
  stateCheckFailedCount: number;
};

const pollOnce = async (
  config: AppConfig,
  store: StateStore,
  fetchOverrides?: {
    maxPagesPerPoll: number;
    maxItemsPerPoll: number;
  }
): Promise<PollCycleResult> => {
  const safeUnclaim = async (postId: string): Promise<void> => {
    try {
      await store.unclaim(postId);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error('state release failed after delivery error', error, {
        event: 'stateStore.claim.releaseFailed',
        reason,
        post: { id: postId },
      });
    }
  };

  const fetchConfig = fetchOverrides
    ? {
        ...config,
        maxPagesPerPoll: fetchOverrides.maxPagesPerPoll,
        maxItemsPerPoll: fetchOverrides.maxItemsPerPoll,
      }
    : config;

  const posts = await fetchLatestPosts(fetchConfig);
  const candidates = config.keywords.length > 0
    ? findMatchingPosts(posts, config.keywords)
    : posts;

  if (candidates.length === 0) {
    logger.debug('candidate pipeline summary', {
      event: 'monitor.cycle.pipeline',
      result: {
        fetched: posts.length,
        candidates: 0,
      },
    });
  }

  const fresh: typeof candidates = [];
  const isDryRun = config.notifier.dryRun;
  const useRedisState = store.isRedisEnabled();
  let notifiedPostCount = 0;
  let dryRunPostCount = 0;
  let failedPostCount = 0;
  let skippedAlreadyProcessedCount = 0;
  let stateCheckFailedCount = 0;
  const skippedAlreadyProcessedSamples: Array<{ id: string; title: string; link: string }> = [];

  for (const post of candidates) {
    try {
      if (isDryRun && useRedisState) {
        if (!(await store.has(post.id))) {
          fresh.push(post);
        } else {
          skippedAlreadyProcessedCount += 1;
          if (skippedAlreadyProcessedSamples.length < 3) {
            skippedAlreadyProcessedSamples.push({
              id: post.id,
              title: post.title,
              link: post.link,
            });
          }
        }
        continue;
      }

      if (await store.claim(post.id)) {
        fresh.push(post);
      } else {
        skippedAlreadyProcessedCount += 1;
        if (skippedAlreadyProcessedSamples.length < 3) {
          skippedAlreadyProcessedSamples.push({
            id: post.id,
            title: post.title,
            link: post.link,
          });
        }
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      stateCheckFailedCount += 1;
      logger.warn('state store claim/has failed; allowing delivery attempt', {
        event: 'stateStore.claim.failed',
        reason,
        failOpen: true,
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
        },
      });
      fresh.push(post);
    }
  }

  if (skippedAlreadyProcessedCount > 0 || stateCheckFailedCount > 0) {
    logger.debug('candidate dedupe/state decision summary', {
      event: 'monitor.cycle.stateDecision',
      options: {
        dryRun: isDryRun,
        useRedisState,
      },
      result: {
        candidates: candidates.length,
        fresh: fresh.length,
        skippedAlreadyProcessed: skippedAlreadyProcessedCount,
        stateCheckFailed: stateCheckFailedCount,
      },
      sample: {
        alreadyProcessed: skippedAlreadyProcessedSamples,
      },
    });
  }

  if (fresh.length === 0) {
    return {
      candidateCount: candidates.length,
      freshCount: 0,
      notifiedPostCount,
      dryRunPostCount,
      failedPostCount,
      skippedAlreadyProcessedCount,
      stateCheckFailedCount,
    };
  }

  let anySuccessfulDelivery = false;
  for (const post of fresh) {
    const matchedKeywords = config.keywords.length > 0 ? findMatches(post.title, config.keywords) : ['*'];

    if (isDryRun) {
      logger.debug('delivery dry-run skipped webhook', {
        event: 'delivery.dryRun.skippedSend',
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
        },
        matchedKeywords,
      });
      dryRunPostCount += 1;
      continue;
    }

    let results: DeliveryResult[];
    try {
      results = await sendAlerts(config, post.title, post.link, matchedKeywords);
    } catch (error: unknown) {
      await safeUnclaim(post.id);
      const reason = error instanceof Error ? error.message : String(error);
      failedPostCount += 1;
      logger.error('delivery request error', error, {
        event: 'delivery.error',
        retryReleased: true,
        reason,
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
        },
        matchedKeywords,
      });
      continue;
    }

    if (results.length === 0) {
      await safeUnclaim(post.id);
      failedPostCount += 1;
      logger.warn('delivery skipped no active notifier target', {
        event: 'delivery.skipped',
        reason: 'no_notifier_target_active',
        retryReleased: true,
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
        },
      });
      continue;
    }

    const okCount = results.filter((result) => result.ok).length;
    const failCount = results.length - okCount;
    const suffix =
      failCount > 0
        ? `, ${failCount} delivery failed (${results.filter((r) => !r.ok).map((r) => `${r.target}: ${r.message ?? 'unknown'}`).join(', ')})`
        : '';

    if (okCount === 0) {
      await safeUnclaim(post.id);
      failedPostCount += 1;
      logger.error('delivery failed all notifier targets', undefined, {
        event: 'delivery.failed',
        retryReleased: true,
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
        },
        delivery: {
          okCount,
          failCount,
          details: suffix,
        },
      });
      continue;
    }

    anySuccessfulDelivery = true;
    notifiedPostCount += 1;
    logger.info('delivery sent', {
      event: 'delivery.sent',
      post: {
        id: post.id,
        title: post.title,
        link: post.link,
      },
      delivery: {
        okCount,
        failCount,
        details: suffix,
      },
      matchedKeywords,
    });
  }

  if (!useRedisState && anySuccessfulDelivery) {
    await store.save();
  }

  return {
    candidateCount: candidates.length,
    freshCount: fresh.length,
    notifiedPostCount,
    dryRunPostCount,
    failedPostCount,
    skippedAlreadyProcessedCount,
    stateCheckFailedCount,
  };
};

const main = async (): Promise<void> => {
  setReadinessMarker(false);
  const config = getConfig();
  setLogLevel(config.logLevel);
  let shutdownRequested = false;

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    setReadinessMarker(false);
    logger.info('graceful shutdown requested', {
      event: 'monitor.shutdown.requested',
      signal,
    });
  };

  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGINT', () => requestShutdown('SIGINT'));

  const leaderElector = new LeaderElector({
    enabled: config.leaderElectionEnabled,
    leaseName: config.leaderElectionLeaseName,
    namespace: config.leaderElectionNamespace,
    identity: config.leaderElectionIdentity,
    leaseDurationSeconds: config.leaderElectionLeaseDurationSeconds,
    renewIntervalMs: config.leaderElectionRenewIntervalMs,
  });

  await leaderElector.start();

  const statePath = config.useFileState && !config.useRedisState ? config.seenStateFile : '';
  const store = new StateStore(statePath, {
    enabled: config.useRedisState,
    url: config.redisUrl,
    keyPrefix: config.redisKeyPrefix,
    ttlSeconds: config.redisTtlSeconds,
  });
  await store.load();

  const selectedTargets = config.notifier.targets ?? [];
  const explicitlySelected = selectedTargets.length > 0;
  const isTargetEnabled = (target: NotifierTarget): boolean =>
    explicitlySelected ? selectedTargets.includes(target) : true;
  const slackConfigured = isTargetEnabled('slack') && Boolean(config.notifier.slackWebhookUrl);
  const telegramConfigured =
    isTargetEnabled('telegram') &&
    Boolean(config.notifier.telegramBotToken) &&
    Boolean(config.notifier.telegramChatId);
  const discordConfigured = isTargetEnabled('discord') && Boolean(config.notifier.discordWebhookUrl);

  if (!config.notifier.dryRun) {
    if (explicitlySelected && selectedTargets.includes('slack') && !config.notifier.slackWebhookUrl) {
      logger.error('invalid notifier configuration', undefined, {
        event: 'monitor.config.invalid',
        target: 'slack',
        missing: ['SLACK_WEBHOOK_URL'],
      });
      process.exit(1);
    }

    if (
      explicitlySelected &&
      selectedTargets.includes('telegram') &&
      (!config.notifier.telegramBotToken || !config.notifier.telegramChatId)
    ) {
      logger.error('invalid notifier configuration', undefined, {
        event: 'monitor.config.invalid',
        target: 'telegram',
        missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
      });
      process.exit(1);
    }

    if (explicitlySelected && selectedTargets.includes('discord') && !config.notifier.discordWebhookUrl) {
      logger.error('invalid notifier configuration', undefined, {
        event: 'monitor.config.invalid',
        target: 'discord',
        missing: ['DISCORD_WEBHOOK_URL'],
      });
      process.exit(1);
    }
  }

  if (!slackConfigured && !telegramConfigured && !discordConfigured && !config.notifier.dryRun) {
    logger.error('no notifier configured', undefined, {
      event: 'monitor.config.invalid',
      target: 'all',
      missing: ['slack/telegram/discord credentials'],
      dryRun: config.notifier.dryRun,
    });
    process.exit(1);
  }

  logger.info('notifier targets configured', {
    event: 'monitor.startup.notifierTargets',
    targets: selectedTargets.length === 0 ? ['auto'] : selectedTargets,
    explicitlySelected,
  });

  if (store.isRedisEnabled()) {
    logger.debug('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'redis',
      redisPrefix: store.redisPrefix(),
    });
  } else if (config.useFileState) {
    logger.debug('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'file',
      path: config.seenStateFile,
    });
  } else {
    logger.debug('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'memory',
      resetOnRestart: true,
    });
  }

  if (config.keywords.length === 0) {
    logger.debug('all posts notification mode enabled', {
      event: 'monitor.startup.noKeywordFilter',
    });
  }

  if (config.leaderElectionEnabled) {
    logger.debug('leader election enabled', {
      event: 'leaderElection.enabled',
      lease: `${config.leaderElectionNamespace}/${config.leaderElectionLeaseName}`,
      identity: config.leaderElectionIdentity,
      leaseDurationSeconds: config.leaderElectionLeaseDurationSeconds,
      renewIntervalMs: config.leaderElectionRenewIntervalMs,
    });
  }

  setReadinessMarker(true);
  logger.debug('monitor readiness enabled', {
    event: 'monitor.readiness.enabled',
    path: readinessPath,
  });

  let firstRun = true;
  try {
    while (true) {
      if (shutdownRequested) {
        break;
      }

      if (config.leaderElectionEnabled) {
        await leaderElector.waitForLeadership(() => shutdownRequested);
        if (shutdownRequested) {
          break;
        }
      }

      const maxPagesPerPoll = firstRun
        ? Math.max(1, config.startupMaxPagesPerPoll)
        : Math.max(1, config.maxPagesPerPoll);
      const maxItemsPerPoll = firstRun
        ? Math.max(1, config.startupMaxItemsPerPoll)
        : Math.max(1, config.maxItemsPerPoll);

      const cycleStartedAt = new Date();
      const cycleResult = await pollOnce(config, store, {
        maxPagesPerPoll,
        maxItemsPerPoll,
      });
      firstRun = false;

      const nextRunAt = config.pollOnce
        ? 'none'
        : new Date(cycleStartedAt.getTime() + config.requestIntervalMs).toISOString();

      logger.info('monitor cycle run', {
        event: 'monitor.cycle.completed',
        result: {
          candidates: cycleResult.candidateCount,
          fresh: cycleResult.freshCount,
          notified: cycleResult.notifiedPostCount,
          dryRun: cycleResult.dryRunPostCount,
          failed: cycleResult.failedPostCount,
          skippedAlreadyProcessed: cycleResult.skippedAlreadyProcessedCount,
          stateCheckFailed: cycleResult.stateCheckFailedCount,
        },
        options: {
          intervalMs: config.requestIntervalMs,
          maxPagesPerPoll,
          maxItemsPerPoll,
          pollOnce: config.pollOnce,
        },
        schedule: {
          runAt: cycleStartedAt.toISOString(),
          nextRunAt,
        },
      });

      if (config.pollOnce) {
        break;
      }
      await waitUntilNextPollOrShutdown(config.requestIntervalMs, () => shutdownRequested);
    }
  } finally {
    setReadinessMarker(false);
    await closeSharedBrowser();
    await leaderElector.close({ releaseLease: shutdownRequested });
    await store.close();
  }
};

main().catch((error) => {
  logger.error('monitor process failed', error, {
    event: 'monitor.process.failed',
  });
  process.exit(1);
});
