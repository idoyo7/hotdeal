import { getConfig } from '../config.js';
import { setLogLevel, logger } from '../logger.js';
import { closeSharedBrowser } from '../monitor.js';
import { createStateStore } from '../state/factory.js';
import { pollOnce, type PollCycleResult } from '../app/poll.js';
import { validateNotifierConfig } from '../app/validateNotifierConfig.js';

type LambdaResponse = {
  statusCode: number;
  body: string;
};

export const handler = async (_event: unknown): Promise<LambdaResponse> => {
  const config = getConfig();
  setLogLevel(config.logLevel);

  logger.info('lambda invocation started', {
    event: 'lambda.invocation.started',
    stateBackend: config.stateBackend,
    crawlMode: config.crawlMode,
    keywords: config.keywords,
  });

  validateNotifierConfig(config);

  const store = await createStateStore(config);
  await store.load();

  let result: PollCycleResult;
  try {
    result = await pollOnce(config, store);
  } finally {
    await closeSharedBrowser();
    await store.close();
  }

  logger.info('lambda invocation completed', {
    event: 'lambda.invocation.completed',
    result: {
      candidates: result.candidateCount,
      fresh: result.freshCount,
      notified: result.notifiedPostCount,
      dryRun: result.dryRunPostCount,
      failed: result.failedPostCount,
      skippedAlreadyProcessed: result.skippedAlreadyProcessedCount,
      stateCheckFailed: result.stateCheckFailedCount,
    },
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      candidates: result.candidateCount,
      fresh: result.freshCount,
      notified: result.notifiedPostCount,
      failed: result.failedPostCount,
    }),
  };
};
