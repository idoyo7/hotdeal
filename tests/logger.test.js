import assert from 'node:assert/strict';
import test from 'node:test';

import { logger, setLogLevel } from '../dist/logger.js';

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
