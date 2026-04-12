import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { logger } from '../logger.js';
import type { StateStore } from './types.js';

export type DynamoStateOptions = {
  tableName: string;
  ttlSeconds: number;
  region?: string;
};

export class DynamoStateStore implements StateStore {
  private client: DynamoDBClient;
  readonly persistsOnWrite = true;
  readonly backendName: string;

  constructor(private readonly options: DynamoStateOptions) {
    this.backendName = `dynamodb(${options.tableName})`;
    this.client = new DynamoDBClient(
      options.region ? { region: options.region } : {}
    );
  }

  async load(): Promise<void> {
    try {
      await this.client.send(
        new DescribeTableCommand({ TableName: this.options.tableName })
      );
      logger.debug('dynamodb state store connected', {
        event: 'stateStore.dynamodb.connected',
        tableName: this.options.tableName,
        ttlSeconds: this.options.ttlSeconds,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error('dynamodb state store connection failed', error, {
        event: 'stateStore.dynamodb.connectionFailed',
        tableName: this.options.tableName,
        reason,
      });
      throw error;
    }
  }

  async save(): Promise<void> {}

  async has(id: string): Promise<boolean> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.options.tableName,
        Key: { postId: { S: id } },
      })
    );
    if (!result.Item) return false;

    // DynamoDB TTL sweep may be delayed — check logical expiry in app logic
    const expiresAt = Number(result.Item.expiresAt?.N ?? '0');
    if (this.options.ttlSeconds > 0 && expiresAt > 0) {
      return expiresAt > Math.floor(Date.now() / 1000);
    }
    return true;
  }

  async add(id: string): Promise<void> {
    const item: Record<string, AttributeValue> = {
      postId: { S: id },
      v: { S: '1' },
    };
    if (this.options.ttlSeconds > 0) {
      item.expiresAt = {
        N: String(Math.floor(Date.now() / 1000) + this.options.ttlSeconds),
      };
    }
    await this.client.send(
      new PutItemCommand({
        TableName: this.options.tableName,
        Item: item,
      })
    );
  }

  /**
   * Atomic claim: succeeds only if item does not exist or is logically expired.
   * ConditionExpression handles DynamoDB TTL sweep delay — expired items
   * (expiresAt <= now) are treated as absent and can be overwritten.
   */
  async claim(id: string): Promise<boolean> {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const item: Record<string, AttributeValue> = {
      postId: { S: id },
      v: { S: '1' },
    };
    if (this.options.ttlSeconds > 0) {
      item.expiresAt = {
        N: String(nowEpoch + this.options.ttlSeconds),
      };
    }

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.options.tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(postId) OR expiresAt < :now',
          ExpressionAttributeValues: {
            ':now': { N: String(nowEpoch) },
          },
        })
      );
      return true;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.name === 'ConditionalCheckFailedException'
      ) {
        return false;
      }
      throw error;
    }
  }

  async unclaim(id: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.options.tableName,
        Key: { postId: { S: id } },
      })
    );
  }

  async close(): Promise<void> {
    this.client.destroy();
  }
}
