import {
  fetchLatestPosts,
  findMatchingPosts,
  findRecentMatchedPosts,
  keywordMatchesTitle,
} from './monitor.js';
import { getConfig, AppConfig, type NotifierTarget } from './config.js';
import { StateStore } from './stateStore.js';
import { sendAlerts, type DeliveryResult } from './notifier.js';
import { LeaderElector } from './leaderElection.js';
import { logger, setLogLevel } from './logger.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

const reportRecentMatches = (config: AppConfig, posts: ReturnType<typeof findMatchingPosts>): void => {
  if (!config.showRecentMatches || config.showRecentHours <= 0 || config.logLevel !== 'debug') {
    return;
  }

  const recent = findRecentMatchedPosts(posts, config.keywords, config.showRecentHours, true);
  const now = new Date();
  const dateLabel = now;
  const cutoff = new Date(now.getTime() - config.showRecentHours * 60 * 60_000);
  const today = dateLabel.toISOString().slice(0, 10);

  const matchesKeyword = (title: string): boolean => {
    if (config.keywords.length === 0) {
      return true;
    }

    return config.keywords.some((keyword) => keywordMatchesTitle(title, keyword));
  };

  const parseDate = (post: { publishedAt?: string }): Date | null => {
    if (!post.publishedAt) {
      return null;
    }

    const parsed = new Date(post.publishedAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const inWindow = recent.filter((post) => {
    if (!post.publishedAt) {
      return false;
    }
    const publishedTime = parseDate(post);
    if (!publishedTime) {
      return false;
    }

    return publishedTime >= cutoff && publishedTime <= now;
  });

  const outOfWindow = posts
    .filter((post) => matchesKeyword(post.title))
    .map((post) => ({ post, publishedTime: parseDate(post) }))
    .filter(({ publishedTime }) => publishedTime !== null)
    .filter(({ publishedTime }) => {
      if (!publishedTime) {
        return false;
      }

      return publishedTime < cutoff;
    })
    .map(({ post }) => post)
    .filter((post, index, all) => all.findIndex((item) => item.id === post.id) === index);

  const parseFailed = posts
    .filter((post) => matchesKeyword(post.title))
    .filter((post) => {
      if (!post.publishedAt) {
        return true;
      }

      return parseDate(post) === null;
    });

  const printPosts = (
    label: string,
    tag: string,
    items: Array<{ id: string; title: string; link: string; publishedAt?: string }>
  ): void => {
    if (items.length === 0) {
      return;
    }

    logger.debug(label);
    for (const post of items) {
      logger.debug(`- [${tag}] [${formatPostDate(post.publishedAt)}] ${post.title} -> ${post.link}`);
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

  const inWindowDedup = dedupeById(inWindow);
  const outOfWindowDedup = dedupeById(outOfWindow);
  const parseFailedDedup = dedupeById(parseFailed);

  logger.debug(
    `Daily keyword summary for board (${today}), keyword(s): ${config.keywords.join(', ')} with lookback ${config.showRecentHours}h`
  );

  if (inWindowDedup.length === 0 && outOfWindowDedup.length === 0 && parseFailedDedup.length === 0) {
    logger.debug('No keyword-matched posts found in parsed candidates.');
    return;
  }

  printPosts(`Matched within lookback (${config.showRecentHours}h):`, 'IN_WINDOW', inWindowDedup);
  printPosts(`Matched but parsed date is outside lookback:`, 'OUT_OF_WINDOW', outOfWindowDedup);

  if (parseFailedDedup.length > 0) {
    printPosts(`Matched but date parse failed or date missing:`, 'UNPARSEABLE', parseFailedDedup);
  }
};

type PollCycleResult = {
  candidateCount: number;
  freshCount: number;
  notifiedPostCount: number;
  dryRunPostCount: number;
  failedPostCount: number;
};

const pollOnce = async (
  config: AppConfig,
  store: StateStore,
  recentHoursOverride?: number,
  fetchOverrides?: {
    maxPagesPerPoll: number;
    maxItemsPerPoll: number;
  }
): Promise<PollCycleResult> => {
  const fetchConfig = fetchOverrides
    ? {
        ...config,
        maxPagesPerPoll: fetchOverrides.maxPagesPerPoll,
        maxItemsPerPoll: fetchOverrides.maxItemsPerPoll,
      }
    : config;

  const posts = await fetchLatestPosts(fetchConfig);
  const reportConfig = recentHoursOverride !== undefined
    ? { ...fetchConfig, showRecentHours: recentHoursOverride }
    : fetchConfig;
  reportRecentMatches(reportConfig, posts);

  const effectiveLookbackHours = Math.max(1, recentHoursOverride ?? config.lookbackHours);
  const candidates = config.keywords.length > 0
    ? findRecentMatchedPosts(posts, config.keywords, effectiveLookbackHours, false)
    : findRecentMatchedPosts(posts, [''], effectiveLookbackHours, false);
  const fresh: typeof candidates = [];
  const isDryRun = config.notifier.dryRun;
  const useRedisState = store.isRedisEnabled();
  let notifiedPostCount = 0;
  let dryRunPostCount = 0;
  let failedPostCount = 0;

  for (const post of candidates) {
    if (isDryRun && useRedisState) {
      if (!(await store.has(post.id))) {
        fresh.push(post);
      }
      continue;
    }

    if (await store.claim(post.id)) {
      fresh.push(post);
    }
  }

  if (fresh.length === 0) {
    return {
      candidateCount: candidates.length,
      freshCount: 0,
      notifiedPostCount,
      dryRunPostCount,
      failedPostCount,
    };
  }

  let anySuccessfulDelivery = false;
  for (const post of fresh) {
    const matchedKeywords = config.keywords.length > 0 ? findMatches(post.title, config.keywords) : ['*'];

    if (isDryRun) {
      logger.debug(
        `DRY-RUN: ${post.title} (matched ${matchedKeywords.join(', ')}) - no webhook call`
      );
      dryRunPostCount += 1;
      continue;
    }

    let results: DeliveryResult[];
    try {
      results = await sendAlerts(config, post.title, post.link, matchedKeywords);
    } catch (error: unknown) {
      await store.unclaim(post.id);
      const reason = error instanceof Error ? error.message : String(error);
      failedPostCount += 1;
      logger.error(
        `Delivery error: ${post.title} (${reason}, claim released for retry)`,
        error
      );
      continue;
    }

    if (results.length === 0) {
      await store.unclaim(post.id);
      failedPostCount += 1;
      logger.error(
        `Skipped notify: ${post.title} (no notifier target active, claim released)`
      );
      continue;
    }

    const okCount = results.filter((result) => result.ok).length;
    const failCount = results.length - okCount;
    const suffix =
      failCount > 0
        ? `, ${failCount} delivery failed (${results.filter((r) => !r.ok).map((r) => `${r.target}: ${r.message ?? 'unknown'}`).join(', ')})`
        : '';

    if (okCount === 0) {
      await store.unclaim(post.id);
      failedPostCount += 1;
      logger.error(
        `Delivery failed: ${post.title} (0 sent${suffix}, claim released for retry)`
      );
      continue;
    }

    anySuccessfulDelivery = true;
    notifiedPostCount += 1;
    logger.info(
      `Notified: ${post.title} (${okCount} sent${suffix})`
    );
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
  };
};

const main = async (): Promise<void> => {
  const config = getConfig();
  setLogLevel(config.logLevel);
  let shutdownRequested = false;

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    logger.info(`Received ${signal}; graceful shutdown requested`);
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
      logger.error('SLACK_WEBHOOK_URL is required when slack is selected in NOTIFIER_TARGETS.');
      process.exit(1);
    }

    if (
      explicitlySelected &&
      selectedTargets.includes('telegram') &&
      (!config.notifier.telegramBotToken || !config.notifier.telegramChatId)
    ) {
      logger.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when telegram is selected in NOTIFIER_TARGETS.');
      process.exit(1);
    }

    if (explicitlySelected && selectedTargets.includes('discord') && !config.notifier.discordWebhookUrl) {
      logger.error('DISCORD_WEBHOOK_URL is required when discord is selected in NOTIFIER_TARGETS.');
      process.exit(1);
    }
  }

  if (!slackConfigured && !telegramConfigured && !discordConfigured && !config.notifier.dryRun) {
    logger.error('No notifier configured. Set selected notifier credentials or adjust NOTIFIER_TARGETS.');
    process.exit(1);
  }

  logger.info(
    `Notifier targets: ${selectedTargets.length === 0 ? 'auto' : selectedTargets.join(',')}`
  );

  if (store.isRedisEnabled()) {
    logger.info(`Using Redis-based state. prefix=${store.redisPrefix()}`);
  } else if (config.useFileState) {
    logger.info(`Using file-based state: ${config.seenStateFile}`);
  } else {
    logger.info('Using in-memory state. State is reset when pod restarts.');
  }

  if (config.keywords.length === 0) {
    logger.info('No ALERT_KEYWORDS configured. All posts will be notified.');
  }

  if (config.leaderElectionEnabled) {
    logger.info(
      `Leader election enabled. lease=${config.leaderElectionNamespace}/${config.leaderElectionLeaseName}, identity=${config.leaderElectionIdentity}`
    );
  }

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

      const recentHoursOverride = firstRun
        ? Math.max(1, config.startupLookbackHours)
        : Math.max(1, config.lookbackHours);

      const maxPagesPerPoll = firstRun
        ? Math.max(1, config.startupMaxPagesPerPoll)
        : Math.max(1, config.maxPagesPerPoll);
      const maxItemsPerPoll = firstRun
        ? Math.max(1, config.startupMaxItemsPerPoll)
        : Math.max(1, config.maxItemsPerPoll);

      const cycleStartedAt = new Date();
      const cycleResult = await pollOnce(config, store, recentHoursOverride, {
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
        },
        options: {
          intervalMs: config.requestIntervalMs,
          lookbackHours: recentHoursOverride,
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
    await leaderElector.close({ releaseLease: shutdownRequested });
    await store.close();
  }
};

main().catch((error) => {
  logger.error('Monitor failed', error);
  process.exit(1);
});
