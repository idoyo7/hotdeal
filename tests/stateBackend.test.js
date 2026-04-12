import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { MemoryStateStore } from '../dist/state/memory.js';
import { FileStateStore } from '../dist/state/file.js';

// --- shared contract tests for any StateStore ---

const runContractTests = (name, createStore) => {
  test(`${name}: claim returns true for fresh id`, async () => {
    const store = await createStore();
    try {
      assert.strictEqual(await store.claim('post-1'), true);
    } finally {
      await store.close();
    }
  });

  test(`${name}: claim returns false for duplicate id`, async () => {
    const store = await createStore();
    try {
      await store.claim('post-1');
      assert.strictEqual(await store.claim('post-1'), false);
    } finally {
      await store.close();
    }
  });

  test(`${name}: has returns false for unseen id`, async () => {
    const store = await createStore();
    try {
      assert.strictEqual(await store.has('post-1'), false);
    } finally {
      await store.close();
    }
  });

  test(`${name}: has returns true after claim`, async () => {
    const store = await createStore();
    try {
      await store.claim('post-1');
      assert.strictEqual(await store.has('post-1'), true);
    } finally {
      await store.close();
    }
  });

  test(`${name}: unclaim allows re-claim`, async () => {
    const store = await createStore();
    try {
      await store.claim('post-1');
      assert.strictEqual(await store.claim('post-1'), false);
      await store.unclaim('post-1');
      assert.strictEqual(await store.claim('post-1'), true);
    } finally {
      await store.close();
    }
  });

  test(`${name}: add marks id as seen`, async () => {
    const store = await createStore();
    try {
      await store.add('post-1');
      assert.strictEqual(await store.has('post-1'), true);
      assert.strictEqual(await store.claim('post-1'), false);
    } finally {
      await store.close();
    }
  });

  test(`${name}: persistsOnWrite and backendName are defined`, async () => {
    const store = await createStore();
    try {
      assert.strictEqual(typeof store.persistsOnWrite, 'boolean');
      assert.strictEqual(typeof store.backendName, 'string');
      assert.ok(store.backendName.length > 0);
    } finally {
      await store.close();
    }
  });
};

// --- Memory backend ---

runContractTests('MemoryStateStore', async () => {
  const store = new MemoryStateStore();
  await store.load();
  return store;
});

test('MemoryStateStore: persistsOnWrite is false', async () => {
  const store = new MemoryStateStore();
  assert.strictEqual(store.persistsOnWrite, false);
  assert.strictEqual(store.backendName, 'memory');
});

// --- File backend ---

const makeTempPath = () =>
  path.join(os.tmpdir(), `hotdeal-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

runContractTests('FileStateStore', async () => {
  const store = new FileStateStore(makeTempPath());
  await store.load();
  return store;
});

test('FileStateStore: save and reload preserves state', async () => {
  const filePath = makeTempPath();
  const store1 = new FileStateStore(filePath);
  await store1.load();
  await store1.claim('post-a');
  await store1.claim('post-b');
  await store1.save();
  await store1.close();

  const store2 = new FileStateStore(filePath);
  await store2.load();
  assert.strictEqual(await store2.has('post-a'), true);
  assert.strictEqual(await store2.has('post-b'), true);
  assert.strictEqual(await store2.has('post-c'), false);
  await store2.close();

  await fs.unlink(filePath).catch(() => {});
});

test('FileStateStore: persistsOnWrite is false', () => {
  const store = new FileStateStore('/tmp/test.json');
  assert.strictEqual(store.persistsOnWrite, false);
  assert.strictEqual(store.backendName, 'file');
});
