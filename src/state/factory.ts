import type { AppConfig } from '../config.js';
import type { StateStore } from './types.js';

export const createStateStore = async (
  config: AppConfig
): Promise<StateStore> => {
  switch (config.stateBackend) {
    case 'redis': {
      if (!config.redisUrl) {
        throw new Error('STATE_BACKEND=redis but REDIS_URL is not configured');
      }
      const { RedisStateStore } = await import('./redis.js');
      return new RedisStateStore({
        url: config.redisUrl,
        keyPrefix: config.redisKeyPrefix,
        ttlSeconds: config.redisTtlSeconds,
      });
    }
    case 'dynamodb': {
      const { DynamoStateStore } = await import('./dynamodb.js');
      return new DynamoStateStore({
        tableName: config.dynamoTableName,
        ttlSeconds: config.dynamoTtlSeconds,
        region: config.dynamoRegion,
      });
    }
    case 'file': {
      const { FileStateStore } = await import('./file.js');
      return new FileStateStore(config.seenStateFile);
    }
    default: {
      const { MemoryStateStore } = await import('./memory.js');
      return new MemoryStateStore();
    }
  }
};
