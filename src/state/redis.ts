import { createClient, type RedisClientType } from 'redis';
import { logger } from '../logger.js';
import type { StateStore } from './types.js';

export type RedisStateOptions = {
  url: string;
  keyPrefix: string;
  ttlSeconds: number;
};

export class RedisStateStore implements StateStore {
  private redis: RedisClientType;
  private errorCount = 0;
  private lastLoggedAtMs = 0;
  readonly persistsOnWrite = true;
  readonly backendName: string;

  constructor(private readonly options: RedisStateOptions) {
    this.backendName = `redis(${options.keyPrefix})`;
    this.redis = createClient({ url: options.url });
    this.redis.on('error', (error: unknown) => {
      this.errorCount += 1;
      const nowMs = Date.now();
      const shouldLog =
        this.errorCount <= 3 || nowMs - this.lastLoggedAtMs >= 30_000;
      if (shouldLog) {
        this.lastLoggedAtMs = nowMs;
        logger.error('redis client error', error, {
          event: 'stateStore.redis.clientError',
          attempt: this.errorCount,
          retrying: true,
        });
      }
    });
  }

  async load(): Promise<void> {
    if (!this.redis.isOpen) {
      logger.debug('connecting to redis state store', {
        event: 'stateStore.redis.connecting',
        keyPrefix: this.options.keyPrefix,
        ttlSeconds: this.options.ttlSeconds,
      });
      await this.redis.connect();
      if (this.errorCount > 0) {
        logger.debug('redis connection recovered', {
          event: 'stateStore.redis.connected',
          transientErrorCount: this.errorCount,
        });
        this.errorCount = 0;
        this.lastLoggedAtMs = 0;
      }
    }
  }

  async save(): Promise<void> {}

  async has(id: string): Promise<boolean> {
    const exists = await this.redis.exists(this.key(id));
    return exists === 1;
  }

  async add(id: string): Promise<void> {
    if (this.options.ttlSeconds > 0) {
      await this.redis.set(this.key(id), '1', { EX: this.options.ttlSeconds });
    } else {
      await this.redis.set(this.key(id), '1');
    }
  }

  async claim(id: string): Promise<boolean> {
    const key = this.key(id);
    const result = this.options.ttlSeconds > 0
      ? await this.redis.set(key, '1', { NX: true, EX: this.options.ttlSeconds })
      : await this.redis.set(key, '1', { NX: true });
    return result === 'OK';
  }

  async unclaim(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }

  async close(): Promise<void> {
    if (this.redis.isOpen) {
      await this.redis.quit();
    }
  }

  private key(id: string): string {
    return `${this.options.keyPrefix}${id}`;
  }
}
