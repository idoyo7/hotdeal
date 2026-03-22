import { promises as fs } from 'node:fs';
import { createClient, type RedisClientType } from 'redis';
import { logger } from './logger.js';

type RedisStateOptions = {
  enabled: boolean;
  url?: string;
  keyPrefix: string;
  ttlSeconds: number;
};

const MAX_MEMORY_STATE_SIZE = 10_000;

export class StateStore {
  private seen: Set<string> = new Set();
  private redis?: RedisClientType;
  private useRedis: boolean;
  private redisKeyPrefix: string;
  private redisTtlSeconds: number;
  private redisErrorCount = 0;
  private redisLastLoggedAtMs = 0;

  constructor(
    private statePath: string,
    redisOptions: RedisStateOptions = {
      enabled: false,
      keyPrefix: 'hotdeal:seen:',
      ttlSeconds: 0,
    }
  ) {
    this.useRedis = redisOptions.enabled;
    this.redisKeyPrefix = redisOptions.keyPrefix;
    this.redisTtlSeconds = redisOptions.ttlSeconds;

    if (this.useRedis) {
      if (!redisOptions.url) {
        throw new Error('USE_REDIS_STATE=true but REDIS_URL is not configured');
      }

      this.redis = createClient({ url: redisOptions.url });
      this.redis.on('error', (error: unknown) => {
        this.redisErrorCount += 1;
        const nowMs = Date.now();
        const shouldLog =
          this.redisErrorCount <= 3 || nowMs - this.redisLastLoggedAtMs >= 30_000;

        if (shouldLog) {
          this.redisLastLoggedAtMs = nowMs;
          logger.error('redis client error', error, {
            event: 'stateStore.redis.clientError',
            attempt: this.redisErrorCount,
            retrying: true,
          });
        }
      });
    }
  }

  async load(): Promise<void> {
    if (this.useRedis) {
      if (this.redis && !this.redis.isOpen) {
        logger.info('connecting to redis state store', {
          event: 'stateStore.redis.connecting',
          keyPrefix: this.redisKeyPrefix,
          ttlSeconds: this.redisTtlSeconds,
        });
        await this.redis.connect();

        if (this.redisErrorCount > 0) {
          logger.info('redis connection recovered', {
            event: 'stateStore.redis.connected',
            transientErrorCount: this.redisErrorCount,
          });
          this.redisErrorCount = 0;
          this.redisLastLoggedAtMs = 0;
        }
      }
      return;
    }

    if (!this.statePath) {
      this.seen = new Set();
      return;
    }

    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) {
        this.seen = new Set(parsed);
      }
    } catch {
      this.seen = new Set();
    }
  }

  async save(): Promise<void> {
    if (this.useRedis) {
      return;
    }

    if (!this.statePath) {
      return;
    }

    await fs.mkdir(this.parentDir(), { recursive: true });
    await fs.writeFile(
      this.statePath,
      JSON.stringify(Array.from(this.seen), null, 2),
      'utf8'
    );
  }

  async has(id: string): Promise<boolean> {
    if (this.useRedis) {
      if (!this.redis) {
        return false;
      }

      const exists = await this.redis.exists(this.redisKey(id));
      return exists === 1;
    }

    return this.seen.has(id);
  }

  async add(id: string): Promise<void> {
    if (this.useRedis) {
      if (!this.redis) {
        return;
      }

      if (this.redisTtlSeconds > 0) {
        await this.redis.set(this.redisKey(id), '1', { EX: this.redisTtlSeconds });
        return;
      }

      await this.redis.set(this.redisKey(id), '1');
      return;
    }

    this.seen.add(id);
  }

  async claim(id: string): Promise<boolean> {
    if (this.useRedis) {
      if (!this.redis) {
        return false;
      }

      const key = this.redisKey(id);
      const result = this.redisTtlSeconds > 0
        ? await this.redis.set(key, '1', { NX: true, EX: this.redisTtlSeconds })
        : await this.redis.set(key, '1', { NX: true });
      return result === 'OK';
    }

    if (this.seen.has(id)) {
      return false;
    }

    this.seen.add(id);
    this.evictIfNeeded();
    return true;
  }

  private evictIfNeeded(): void {
    if (this.useRedis || this.seen.size <= MAX_MEMORY_STATE_SIZE) {
      return;
    }

    const excess = this.seen.size - MAX_MEMORY_STATE_SIZE;
    let removed = 0;
    for (const key of this.seen) {
      if (removed >= excess) {
        break;
      }
      this.seen.delete(key);
      removed += 1;
    }
  }

  async unclaim(id: string): Promise<void> {
    if (this.useRedis) {
      if (!this.redis) {
        return;
      }

      await this.redis.del(this.redisKey(id));
      return;
    }

    this.seen.delete(id);
  }

  async close(): Promise<void> {
    if (!this.redis || !this.redis.isOpen) {
      return;
    }

    await this.redis.quit();
  }

  isRedisEnabled(): boolean {
    return this.useRedis;
  }

  redisPrefix(): string {
    return this.redisKeyPrefix;
  }

  private parentDir(): string {
    const idx = this.statePath.lastIndexOf('/');
    if (idx <= 0) {
      return '.';
    }
    return this.statePath.slice(0, idx);
  }

  private redisKey(id: string): string {
    return `${this.redisKeyPrefix}${id}`;
  }
}
