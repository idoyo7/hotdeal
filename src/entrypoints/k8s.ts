import { unlinkSync, writeFileSync } from 'node:fs';
import { getConfig } from '../config.js';
import { setLogLevel, logger, compact } from '../logger.js';
import { closeSharedBrowser } from '../monitor.js';
import { LeaderElector } from '../leaderElection.js';
import { createStateStore } from '../state/factory.js';
import { pollOnce } from '../app/poll.js';
import {
  validateNotifierConfig,
  NotifierConfigError,
} from '../app/validateNotifierConfig.js';

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
    logger.info({
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

  const store = await createStateStore(config);
  await store.load();

  // Notifier config validation
  try {
    const notifierStatus = validateNotifierConfig(config);

    logger.info({
      event: 'monitor.startup.notifierTargets',
      targets:
        notifierStatus.selectedTargets.length === 0
          ? ['auto']
          : notifierStatus.selectedTargets,
      explicitlySelected: notifierStatus.explicitlySelected,
    });
  } catch (error: unknown) {
    if (error instanceof NotifierConfigError) {
      logger.error('invalid notifier configuration', undefined, {
        event: 'monitor.config.invalid',
        target: error.target,
        missing: error.missing,
        dryRun: config.notifier.dryRun,
      });
      process.exit(1);
    }
    throw error;
  }

  logger.debug('state store selected', {
    event: 'monitor.startup.stateStore',
    mode: store.backendName,
    persistsOnWrite: store.persistsOnWrite,
  });

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
  // 폴링 옵션은 정적이라 매 사이클 로그에 싣지 않고, 값이 바뀔 때만 1줄 남긴다.
  // startup(5p/120i) → steady(1p/30i) 전환이 유일한 변화 지점이다.
  let lastPollOptionsKey: string | undefined;
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

      const pollOptions = {
        intervalMs: config.requestIntervalMs,
        maxPagesPerPoll,
        maxItemsPerPoll,
        pollOnce: config.pollOnce,
      };
      const pollOptionsKey = JSON.stringify(pollOptions);
      if (pollOptionsKey !== lastPollOptionsKey) {
        logger.info({
          event: 'monitor.poll.options',
          phase: lastPollOptionsKey === undefined ? 'startup' : 'steady',
          options: pollOptions,
        });
        lastPollOptionsKey = pollOptionsKey;
      }

      const cycleStartedAt = Date.now();
      const cycleResult = await pollOnce(config, store, {
        maxPagesPerPoll,
        maxItemsPerPoll,
      });
      firstRun = false;

      logger.info({
        event: 'monitor.cycle.completed',
        result: compact({
          candidates: cycleResult.candidateCount,
          fresh: cycleResult.freshCount,
          notified: cycleResult.notifiedPostCount,
          dryRun: cycleResult.dryRunPostCount,
          failed: cycleResult.failedPostCount,
          skippedAlreadyProcessed: cycleResult.skippedAlreadyProcessedCount,
          stateCheckFailed: cycleResult.stateCheckFailedCount,
        }),
        durationMs: Date.now() - cycleStartedAt,
      });

      if (config.pollOnce) {
        break;
      }
      await waitUntilNextPollOrShutdown(
        config.requestIntervalMs,
        () => shutdownRequested
      );
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
