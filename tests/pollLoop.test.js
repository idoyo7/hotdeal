import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CONSECUTIVE_POLL_FAILURES,
  nextPollLoopStateOnFailure,
  nextPollLoopStateOnSuccess,
  runPollAttempt,
  loadStateStoreSafely,
  runOnceFailed,
} from '../dist/entrypoints/pollLoop.js';

const captureLog = async (run) => {
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => captured.push(args.join(' '));
  console.warn = (...args) => captured.push(args.join(' '));
  console.error = (...args) => captured.push(args.join(' '));

  try {
    const result = await run();
    return { captured, result };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
};

// --- 순수 상태 전이 함수 ---

test('nextPollLoopStateOnFailure increments the consecutive failure counter', () => {
  const result = nextPollLoopStateOnFailure({ consecutiveFailures: 0 });
  assert.strictEqual(result.state.consecutiveFailures, 1);
  assert.strictEqual(result.shouldMarkNotReady, false);
});

test('nextPollLoopStateOnFailure signals not-ready once the threshold is reached', () => {
  let state = { consecutiveFailures: 0 };
  let shouldMarkNotReady = false;

  for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
    const result = nextPollLoopStateOnFailure(state);
    state = result.state;
    shouldMarkNotReady = result.shouldMarkNotReady;
  }

  assert.strictEqual(state.consecutiveFailures, MAX_CONSECUTIVE_POLL_FAILURES);
  assert.strictEqual(shouldMarkNotReady, true);
});

test('nextPollLoopStateOnSuccess resets the counter and reports a readiness change after failures', () => {
  const afterFailures = nextPollLoopStateOnFailure({ consecutiveFailures: 2 });
  const recovered = nextPollLoopStateOnSuccess(afterFailures.state);
  assert.strictEqual(recovered.state.consecutiveFailures, 0);
  assert.strictEqual(recovered.readinessChanged, true);
});

test('nextPollLoopStateOnSuccess is a no-op when already healthy', () => {
  const result = nextPollLoopStateOnSuccess({ consecutiveFailures: 0 });
  assert.strictEqual(result.state.consecutiveFailures, 0);
  assert.strictEqual(result.readinessChanged, false);
});

// --- runPollAttempt: 루프가 예외로 죽지 않고 살아있는지 ---

test('runPollAttempt keeps the loop alive across repeated failures and resets on recovery', async () => {
  let state = { consecutiveFailures: 0 };
  const readyCalls = [];
  const markReady = (ready) => readyCalls.push(ready);

  let callCount = 0;
  const attempt = async () => {
    callCount += 1;
    if (callCount <= 3) {
      throw new Error(`boom ${callCount}`);
    }
  };

  const { captured } = await captureLog(async () => {
    for (let i = 0; i < 4; i += 1) {
      state = await runPollAttempt(attempt, state, markReady);
    }
  });

  assert.strictEqual(callCount, 4, '4번째 시도까지 루프가 계속 돌아야 한다');
  assert.strictEqual(state.consecutiveFailures, 0, '성공 후 카운터가 리셋돼야 한다');
  assert.deepStrictEqual(readyCalls, [true], '실패 3회는 임계치(5) 미만이라 not-ready 마킹은 없어야 한다');

  const failLogs = captured
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'monitor.poll.failed');
  assert.strictEqual(failLogs.length, 3);
  assert.ok(failLogs.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
});

test('runPollAttempt marks not-ready once consecutive failures reach the threshold', async () => {
  let state = { consecutiveFailures: 0 };
  const readyCalls = [];
  const markReady = (ready) => readyCalls.push(ready);
  const attempt = async () => {
    throw new Error('persistent failure');
  };

  await captureLog(async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
      state = await runPollAttempt(attempt, state, markReady);
    }
  });

  assert.strictEqual(state.consecutiveFailures, MAX_CONSECUTIVE_POLL_FAILURES);
  assert.deepStrictEqual(readyCalls, [false]);
});

test('runPollAttempt does not call markReady on an uninterrupted string of successes', async () => {
  let state = { consecutiveFailures: 0 };
  const readyCalls = [];
  const markReady = (ready) => readyCalls.push(ready);
  const attempt = async () => {};

  for (let i = 0; i < 3; i += 1) {
    state = await runPollAttempt(attempt, state, markReady);
  }

  assert.strictEqual(state.consecutiveFailures, 0);
  assert.deepStrictEqual(readyCalls, []);
});

// --- loadStateStoreSafely: 기동 시점 store.load() 실패해도 예외를 밖으로 내보내지 않는다 ---

test('loadStateStoreSafely does not throw when store.load() rejects', async () => {
  const stubStore = {
    load: async () => {
      throw new Error('redis unreachable');
    },
  };

  await assert.doesNotReject(() => loadStateStoreSafely(stubStore));
});

test('loadStateStoreSafely logs stateStore.load.failed with the reason when load() rejects', async () => {
  const stubStore = {
    load: async () => {
      throw new Error('redis unreachable');
    },
  };

  const { captured } = await captureLog(() => loadStateStoreSafely(stubStore));
  const warnings = captured
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === 'stateStore.load.failed');

  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].reason, 'redis unreachable');
});

test('loadStateStoreSafely calls through to store.load() when it succeeds', async () => {
  let loaded = false;
  const stubStore = {
    load: async () => {
      loaded = true;
    },
  };

  await loadStateStoreSafely(stubStore);
  assert.strictEqual(loaded, true);
});

test('runOnceFailed는 폴이 한 번이라도 실패했을 때만 true', () => {
  assert.equal(runOnceFailed({ consecutiveFailures: 0 }), false);
  assert.equal(runOnceFailed({ consecutiveFailures: 1 }), true);
  assert.equal(runOnceFailed({ consecutiveFailures: 3 }), true);
});
