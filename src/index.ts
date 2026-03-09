import {
  fetchLatestPosts,
  findMatchingPosts,
  keywordMatchesTitle,
} from './monitor.js';
import { unlinkSync, writeFileSync } from 'node:fs';
import { getConfig, AppConfig, type NotifierTarget } from './config.js';
import { StateStore } from './stateStore.js';
import { sendAlerts, type DeliveryResult } from './notifier.js';
import { LeaderElector } from './leaderElection.js';
import { logger, setLogLevel } from './logger.js';
import { resolveCycleProfile, type CycleProfile } from './runtimeProfile.js';

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

const formatPostDate = (publishedAt?: string): string => {
  if (!publishedAt) {
    return 'date-not-available';
  }

  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) {
    return `invalid-date:${publishedAt}`;
  }

  return parsed.toISOString();
};

const reportMatchedPosts = (
  config: AppConfig,
  cycleProfile: CycleProfile,
  posts: ReturnType<typeof findMatchingPosts>
): void => {
  const debugEnabled = config.logLevel === 'debug';

  const printPosts = (
    tag: 'MATCHED' | 'UNPARSEABLE_DATE',
    items: Array<{ id: string; title: string; link: string; publishedAt?: string }>
  ): void => {
    if (!debugEnabled) {
      return;
    }

    for (const post of items) {
      logger.debug('matched post item', {
        event: 'monitor.matches.item',
        classification: tag,
        post: {
          id: post.id,
          title: post.title,
          link: post.link,
          publishedAt: formatPostDate(post.publishedAt),
        },
      });
    }
  };

  const dedupeById = (items: ReturnType<typeof findMatchingPosts>): ReturnType<typeof findMatchingPosts> => {
    const seen = new Set<string>();
    return items.filter((post) => {
      if (seen.has(post.id)) {
        return false;
      }

      seen.add(post.id);
      return true;
    });
  };

  const matchedDedup = dedupeById(config.keywords.length > 0 ? findMatchingPosts(posts, config.keywords) : posts);
  const parseFailedDedup = dedupeById(
    matchedDedup.filter((post) => {
      if (!post.publishedAt) {
        return true;
      }

      return Number.isNaN(new Date(post.publishedAt).getTime());
    })
  );

  const summaryFields = {
    event: 'monitor.matches.summary',
    cycleMode: cycleProfile.name,
    pageDepth: cycleProfile.maxPagesPerPoll,
    keywords: config.keywords,
    result: {
      matched: matchedDedup.length,
      unparseableDate: parseFailedDedup.length,
    },
  };

  logger.info('matched posts summary', summaryFields);

  if (matchedDedup.length === 0) {
    const emptyFields = {
      event: 'monitor.matches.empty',
      cycleMode: cycleProfile.name,
      pageDepth: cycleProfile.maxPagesPerPoll,
      keywords: config.keywords,
    };
    logger.info('no keyword matches in fetched posts', emptyFields);
    return;
  }

  if (parseFailedDedup.length > 0) {
    logger.info('matched posts with missing or invalid dates', {
      event: 'monitor.matches.metadata',
      cycleMode: cycleProfile.name,
      pageDepth: cycleProfile.maxPagesPerPoll,
      result: {
        unparseableDate: parseFailedDedup.length,
      },
      sample: {
        unparseableDate: parseFailedDedup.slice(0, 3).map((post) => ({
          id: post.id,
          title: post.title,
          link: post.link,
          publishedAt: formatPostDate(post.publishedAt),
        })),
      },
    });
  }

  printPosts('MATCHED', matchedDedup);

  if (parseFailedDedup.length > 0) {
    printPosts('UNPARSEABLE_DATE', parseFailedDedup);
  }
};

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
  cycleProfile: CycleProfile
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

  const fetchConfig = {
    ...config,
    maxPagesPerPoll: cycleProfile.maxPagesPerPoll,
    maxItemsPerPoll: cycleProfile.maxItemsPerPoll,
  };

  const posts = await fetchLatestPosts(fetchConfig);
  reportMatchedPosts(fetchConfig, cycleProfile, posts);

  const keywordMatched = config.keywords.length > 0
    ? findMatchingPosts(posts, config.keywords)
    : posts;
  const candidates = keywordMatched;
  let unparseableCount = 0;
  const unparseableSamples: Array<{ id: string; title: string; link: string; publishedAt?: string }> = [];

  for (const post of keywordMatched) {
    if (!post.publishedAt) {
      unparseableCount += 1;
      if (unparseableSamples.length < 3) {
        unparseableSamples.push({
          id: post.id,
          title: post.title,
          link: post.link,
          publishedAt: post.publishedAt,
        });
      }
    } else if (Number.isNaN(new Date(post.publishedAt).getTime())) {
      unparseableCount += 1;
      if (unparseableSamples.length < 3) {
        unparseableSamples.push({
          id: post.id,
          title: post.title,
          link: post.link,
          publishedAt: post.publishedAt,
        });
      }
    }
  }

  if (candidates.length === 0 || unparseableCount > 0) {
    logger.info('candidate pipeline summary', {
      event: 'monitor.cycle.pipeline',
      options: {
        cycleMode: cycleProfile.name,
        pageDepth: cycleProfile.maxPagesPerPoll,
        itemLimit: cycleProfile.maxItemsPerPoll,
      },
      result: {
        fetched: posts.length,
        keywordMatched: keywordMatched.length,
        candidates: candidates.length,
        unparseableDate: unparseableCount,
      },
      sample: {
        unparseableDate: unparseableSamples,
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
      logger.error('state store claim/has failed; allowing delivery attempt', error, {
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
    logger.info('candidate dedupe/state decision summary', {
      event: 'monitor.cycle.stateDecision',
      options: {
        cycleMode: cycleProfile.name,
        pageDepth: cycleProfile.maxPagesPerPoll,
        itemLimit: cycleProfile.maxItemsPerPoll,
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
      logger.error('delivery skipped no active notifier target', undefined, {
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
    logger.info('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'redis',
      redisPrefix: store.redisPrefix(),
    });
  } else if (config.useFileState) {
    logger.info('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'file',
      path: config.seenStateFile,
    });
  } else {
    logger.info('state store selected', {
      event: 'monitor.startup.stateStore',
      mode: 'memory',
      resetOnRestart: true,
    });
  }

  if (config.keywords.length === 0) {
    logger.info('all posts notification mode enabled', {
      event: 'monitor.startup.noKeywordFilter',
    });
  }

  if (config.leaderElectionEnabled) {
    logger.info('leader election enabled', {
      event: 'leaderElection.enabled',
      lease: `${config.leaderElectionNamespace}/${config.leaderElectionLeaseName}`,
      identity: config.leaderElectionIdentity,
      leaseDurationSeconds: config.leaderElectionLeaseDurationSeconds,
      renewIntervalMs: config.leaderElectionRenewIntervalMs,
    });
  }

  setReadinessMarker(true);
  logger.info('monitor readiness enabled', {
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

      const cycleProfile = resolveCycleProfile(firstRun);

      const cycleStartedAt = new Date();
      const cycleResult = await pollOnce(config, store, cycleProfile);
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
          cycleMode: cycleProfile.name,
          maxPagesPerPoll: cycleProfile.maxPagesPerPoll,
          maxItemsPerPoll: cycleProfile.maxItemsPerPoll,
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
