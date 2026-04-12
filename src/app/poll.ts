import {
  fetchLatestPosts,
  findMatchingPosts,
  keywordMatchesTitle,
} from '../monitor.js';
import type { AppConfig } from '../config.js';
import type { StateStore } from '../state/types.js';
import { sendAlerts, type DeliveryResult } from '../notifier.js';
import { logger } from '../logger.js';

export type PollCycleResult = {
  candidateCount: number;
  freshCount: number;
  notifiedPostCount: number;
  dryRunPostCount: number;
  failedPostCount: number;
  skippedAlreadyProcessedCount: number;
  stateCheckFailedCount: number;
};

const findMatches = (postTitle: string, keywords: string[]): string[] =>
  keywords.filter((keyword) => keywordMatchesTitle(postTitle, keyword));

export const pollOnce = async (
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
  const candidates =
    config.keywords.length > 0
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
  const persistentBackend = store.persistsOnWrite;
  let notifiedPostCount = 0;
  let dryRunPostCount = 0;
  let failedPostCount = 0;
  let skippedAlreadyProcessedCount = 0;
  let stateCheckFailedCount = 0;
  const skippedAlreadyProcessedSamples: Array<{
    id: string;
    title: string;
    link: string;
  }> = [];

  for (const post of candidates) {
    try {
      if (isDryRun && persistentBackend) {
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
        persistentBackend,
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
    const matchedKeywords =
      config.keywords.length > 0
        ? findMatches(post.title, config.keywords)
        : ['*'];

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
      results = await sendAlerts(
        config,
        post.title,
        post.link,
        matchedKeywords
      );
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
        ? `, ${failCount} delivery failed (${results
            .filter((r) => !r.ok)
            .map((r) => `${r.target}: ${r.message ?? 'unknown'}`)
            .join(', ')})`
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

  if (!store.persistsOnWrite && anySuccessfulDelivery) {
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
