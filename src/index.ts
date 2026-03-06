import {
  fetchLatestPosts,
  findMatchingPosts,
  findRecentMatchedPosts,
  keywordMatchesTitle,
} from './monitor.js';
import { getConfig, AppConfig } from './config.js';
import { StateStore } from './stateStore.js';
import { sendAlerts, type DeliveryResult } from './notifier.js';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  if (!config.showRecentMatches || config.showRecentHours <= 0) {
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

    console.log(`[${new Date().toISOString()}] ${label}`);
    for (const post of items) {
      console.log(`- [${tag}] [${formatPostDate(post.publishedAt)}] ${post.title} -> ${post.link}`);
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

  console.log(
    `[${new Date().toISOString()}] Daily keyword summary for board (${today}), keyword(s): ${config.keywords.join(', ')} with lookback ${config.showRecentHours}h`
  );

  if (inWindowDedup.length === 0 && outOfWindowDedup.length === 0 && parseFailedDedup.length === 0) {
    console.log(`[${new Date().toISOString()}] No keyword-matched posts found in parsed candidates.`);
    return;
  }

  printPosts(`Matched within lookback (${config.showRecentHours}h):`, 'IN_WINDOW', inWindowDedup);
  printPosts(`Matched but parsed date is outside lookback:`, 'OUT_OF_WINDOW', outOfWindowDedup);

  if (parseFailedDedup.length > 0) {
    printPosts(`Matched but date parse failed or date missing:`, 'UNPARSEABLE', parseFailedDedup);
  }
};

const pollOnce = async (
  config: AppConfig,
  store: StateStore,
  recentHoursOverride?: number
): Promise<void> => {
  const posts = await fetchLatestPosts(config);
  const reportConfig = recentHoursOverride !== undefined
    ? { ...config, showRecentHours: recentHoursOverride }
    : config;
  reportRecentMatches(reportConfig, posts);

  const candidates = config.keywords.length > 0 ? findMatchingPosts(posts, config.keywords) : posts;
  const fresh: typeof candidates = [];
  const isDryRun = config.notifier.dryRun;
  const useRedisState = store.isRedisEnabled();

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
    console.log(`[${new Date().toISOString()}] No new posts matched`);
    return;
  }

  let anySuccessfulDelivery = false;
  for (const post of fresh) {
    const matchedKeywords = config.keywords.length > 0 ? findMatches(post.title, config.keywords) : ['*'];

    if (isDryRun) {
      console.log(
        `[${new Date().toISOString()}] DRY-RUN: ${post.title} (matched ${matchedKeywords.join(', ')}) - no webhook call`
      );
      continue;
    }

    let results: DeliveryResult[];
    try {
      results = await sendAlerts(config, post.title, post.link, matchedKeywords);
    } catch (error: unknown) {
      await store.unclaim(post.id);
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[${new Date().toISOString()}] Delivery error: ${post.title} (${reason}, claim released for retry)`
      );
      continue;
    }

    if (results.length === 0) {
      await store.unclaim(post.id);
      console.warn(
        `[${new Date().toISOString()}] Skipped notify: ${post.title} (no notifier target active, claim released)`
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
      console.warn(
        `[${new Date().toISOString()}] Delivery failed: ${post.title} (0 sent${suffix}, claim released for retry)`
      );
      continue;
    }

    anySuccessfulDelivery = true;
    console.log(
      `[${new Date().toISOString()}] Notified: ${post.title} (${okCount} sent${suffix})`
    );
  }

  if (!useRedisState && anySuccessfulDelivery) {
    await store.save();
  }
};

const main = async (): Promise<void> => {
  const config = getConfig();
  const statePath = config.useFileState && !config.useRedisState ? config.seenStateFile : '';
  const store = new StateStore(statePath, {
    enabled: config.useRedisState,
    url: config.redisUrl,
    keyPrefix: config.redisKeyPrefix,
    ttlSeconds: config.redisTtlSeconds,
  });
  await store.load();

  if (config.notifier.slackWebhookUrl === undefined &&
      (config.notifier.telegramBotToken === undefined || config.notifier.telegramChatId === undefined) &&
      !config.notifier.dryRun) {
    console.error('No notifier configured. Set SLACK_WEBHOOK_URL or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.');
    process.exit(1);
  }

  if (store.isRedisEnabled()) {
    console.log(`[${new Date().toISOString()}] Using Redis-based state. prefix=${store.redisPrefix()}`);
  } else if (config.useFileState) {
    console.log(`[${new Date().toISOString()}] Using file-based state: ${config.seenStateFile}`);
  } else {
    console.log(`[${new Date().toISOString()}] Using in-memory state. State is reset when pod restarts.`);
  }

  if (config.keywords.length === 0) {
    console.warn('No ALERT_KEYWORDS configured. All posts will be notified.');
  }

  let firstRun = true;
  try {
    while (true) {
      const recentHoursOverride = !config.pollOnce && firstRun
        ? Math.max(1, config.startupLookbackHours)
        : config.showRecentHours;
      await pollOnce(config, store, recentHoursOverride);
      firstRun = false;

      if (config.pollOnce) {
        break;
      }
      console.log(`[${new Date().toISOString()}] Waiting ${config.requestIntervalMs}ms`);
      await wait(config.requestIntervalMs);
    }
  } finally {
    await store.close();
  }
};

main().catch((error) => {
  console.error('Monitor failed', error);
  process.exit(1);
});
