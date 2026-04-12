import assert from 'node:assert/strict';
import test from 'node:test';

import { getConfig } from '../dist/config.js';

const withEnv = (entries, run) => {
  const previous = new Map();
  for (const key of Object.keys(entries)) {
    previous.set(key, process.env[key]);
    const value = entries[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test('getConfig defaults stateBackend to memory', () => {
  withEnv(
    { STATE_BACKEND: undefined, USE_REDIS_STATE: undefined, USE_FILE_STATE: undefined, STATE_FILE_PATH: undefined },
    () => {
      const config = getConfig();
      assert.strictEqual(config.stateBackend, 'memory');
    }
  );
});

test('getConfig derives stateBackend=redis from USE_REDIS_STATE=true', () => {
  withEnv({ STATE_BACKEND: undefined, USE_REDIS_STATE: 'true' }, () => {
    const config = getConfig();
    assert.strictEqual(config.stateBackend, 'redis');
  });
});

test('getConfig derives stateBackend=file from USE_FILE_STATE=true', () => {
  withEnv(
    { STATE_BACKEND: undefined, USE_REDIS_STATE: undefined, USE_FILE_STATE: 'true', STATE_FILE_PATH: '/tmp/test.json' },
    () => {
      const config = getConfig();
      assert.strictEqual(config.stateBackend, 'file');
    }
  );
});

test('getConfig explicit STATE_BACKEND=dynamodb overrides legacy flags', () => {
  withEnv({ STATE_BACKEND: 'dynamodb', USE_REDIS_STATE: 'true' }, () => {
    const config = getConfig();
    assert.strictEqual(config.stateBackend, 'dynamodb');
  });
});

test('getConfig parses DYNAMODB_TABLE_NAME', () => {
  withEnv({ DYNAMODB_TABLE_NAME: 'my-custom-table' }, () => {
    const config = getConfig();
    assert.strictEqual(config.dynamoTableName, 'my-custom-table');
  });
});

test('getConfig defaults DYNAMODB_TABLE_NAME to hotdeal-seen-posts', () => {
  withEnv({ DYNAMODB_TABLE_NAME: undefined }, () => {
    const config = getConfig();
    assert.strictEqual(config.dynamoTableName, 'hotdeal-seen-posts');
  });
});

test('getConfig defaults DYNAMODB_TTL_SECONDS to 604800', () => {
  withEnv({ DYNAMODB_TTL_SECONDS: undefined }, () => {
    const config = getConfig();
    assert.strictEqual(config.dynamoTtlSeconds, 604800);
  });
});

test('getConfig ignores unknown STATE_BACKEND and falls back to memory', () => {
  withEnv(
    { STATE_BACKEND: 'unknown', USE_REDIS_STATE: undefined, USE_FILE_STATE: undefined, STATE_FILE_PATH: undefined },
    () => {
      const config = getConfig();
      assert.strictEqual(config.stateBackend, 'memory');
    }
  );
});

test('getConfig does not crash with Lambda-only settings on K8s path', () => {
  withEnv(
    {
      STATE_BACKEND: 'redis',
      USE_REDIS_STATE: 'true',
      REDIS_URL: 'redis://localhost:6379',
      DYNAMODB_TABLE_NAME: 'should-be-ignored',
      DYNAMODB_TTL_SECONDS: '86400',
    },
    () => {
      const config = getConfig();
      assert.strictEqual(config.stateBackend, 'redis');
      // Lambda-specific settings parsed but not harmful
      assert.strictEqual(config.dynamoTableName, 'should-be-ignored');
    }
  );
});

test('getConfig does not crash with K8s-only settings on Lambda path', () => {
  withEnv(
    {
      STATE_BACKEND: 'dynamodb',
      LEADER_ELECTION_ENABLED: 'true',
      POD_NAME: 'some-pod',
      POD_NAMESPACE: 'some-ns',
    },
    () => {
      const config = getConfig();
      assert.strictEqual(config.stateBackend, 'dynamodb');
      // K8s-specific settings parsed but not harmful
      assert.strictEqual(config.leaderElectionEnabled, true);
    }
  );
});
