import assert from 'node:assert/strict';
import test from 'node:test';

import { logger, setLogLevel } from '../dist/logger.js';

test('logger prints level and timestamp prefix', () => {
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
  assert.match(captured[0], /^\[INFO\] \[\d{4}-\d{2}-\d{2}T.*Z\] hello world$/);
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
