import assert from 'node:assert/strict';
import test from 'node:test';

import { logger, setLogLevel, compact } from '../dist/logger.js';

const captureLog = (run) => {
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  console.log = (...args) => captured.push(args.join(' '));
  console.warn = (...args) => captured.push(args.join(' '));

  try {
    run();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  return captured;
};

test('logger prints structured JSON payload', () => {
  setLogLevel('debug');
  const captured = [];
  const originalLog = console.log;

  console.log = (...args) => {
    captured.push(args.join(' '));
  };

  try {
    logger.info('hello world');
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.message, 'hello world');
  assert.match(parsed.time, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('logger includes custom fields in JSON payload', () => {
  setLogLevel('debug');
  const captured = [];
  const originalLog = console.log;

  console.log = (...args) => {
    captured.push(args.join(' '));
  };

  try {
    logger.info('monitor cycle run', {
      event: 'monitor.cycle.completed',
      result: { candidates: 10, fresh: 2 },
      options: { maxPagesPerPoll: 1 },
    });
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.event, 'monitor.cycle.completed');
  assert.deepStrictEqual(parsed.result, { candidates: 10, fresh: 2 });
  assert.deepStrictEqual(parsed.options, { maxPagesPerPoll: 1 });
  assert.strictEqual(parsed.message, 'monitor cycle run');
});

test('compact drops empty-valued fields but keeps false and non-zero', () => {
  assert.deepStrictEqual(
    compact({
      candidates: 1,
      fresh: 0,
      notified: 0,
      details: '',
      reason: null,
      missing: undefined,
      pollOnce: false,
      skippedAlreadyProcessed: 1,
    }),
    { candidates: 1, pollOnce: false, skippedAlreadyProcessed: 1 }
  );
});

test('compact leaves an all-empty object empty rather than dropping the key', () => {
  assert.deepStrictEqual(compact({ fresh: 0, notified: 0 }), {});
});

test('logger omits message when only fields are given', () => {
  setLogLevel('debug');

  const captured = captureLog(() => {
    logger.info({ event: 'monitor.shutdown.requested', signal: 'SIGTERM' });
  });

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.event, 'monitor.shutdown.requested');
  assert.strictEqual(parsed.signal, 'SIGTERM');
  assert.ok(!('message' in parsed), 'message 키가 아예 없어야 한다');
  assert.strictEqual(parsed.level, 'info');
  assert.match(parsed.time, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('logger.warn accepts fields-only input', () => {
  setLogLevel('debug');

  const captured = captureLog(() => {
    logger.warn({ event: 'delivery.skipped', retryReleased: true });
  });

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.level, 'warn');
  assert.strictEqual(parsed.event, 'delivery.skipped');
  assert.ok(!('message' in parsed));
});

test('monitor.cycle.completed payload carries no static, derived, or zero fields', () => {
  setLogLevel('debug');

  const captured = captureLog(() => {
    logger.info({
      event: 'monitor.cycle.completed',
      result: compact({
        candidates: 1,
        fresh: 0,
        notified: 0,
        dryRun: 0,
        failed: 0,
        skippedAlreadyProcessed: 1,
        stateCheckFailed: 0,
      }),
      durationMs: 1943,
    });
  });

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);

  assert.deepStrictEqual(parsed.result, {
    candidates: 1,
    skippedAlreadyProcessed: 1,
  });
  assert.strictEqual(parsed.durationMs, 1943);

  // 다이어트로 사라져야 하는 것들
  assert.ok(!('options' in parsed), 'options 는 전환 시점 로그로 분리됐다');
  assert.ok(!('schedule' in parsed), 'schedule 은 durationMs 로 대체됐다');
  assert.ok(!('message' in parsed), 'message 는 event 와 동어반복이었다');

  // 회귀 가드: 다이어트 전 411자에서 절반 이하로 줄어든 상태를 유지한다
  assert.ok(
    captured[0].length < 200,
    `한 줄이 200자 미만이어야 한다 (실측 ${captured[0].length}자)`
  );
});

test('error keeps its human-readable message alongside the event', () => {
  setLogLevel('debug');

  const captured = [];
  const originalError = console.error;
  console.error = (...args) => captured.push(args.join(' '));

  try {
    logger.error('delivery request error', new Error('boom'), {
      event: 'delivery.error',
      retryReleased: true,
    });
  } finally {
    console.error = originalError;
  }

  assert.strictEqual(captured.length, 1);
  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.level, 'error');
  assert.strictEqual(parsed.event, 'delivery.error');
  // 실패 로그는 드물고 진단 가치가 있어 다이어트 대상에서 제외했다.
  assert.strictEqual(parsed.message, 'delivery request error');
  assert.strictEqual(parsed.error.message, 'boom');
});

test('logger respects configured log level', () => {
  setLogLevel('error');
  const captured = [];
  const originalLog = console.log;

  console.log = (...args) => {
    captured.push(args.join(' '));
  };

  try {
    logger.info('should not appear');
    logger.debug('should not appear');
  } finally {
    console.log = originalLog;
    setLogLevel('info');
  }

  assert.strictEqual(captured.length, 0);
});
