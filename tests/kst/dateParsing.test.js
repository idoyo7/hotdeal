// 이 파일은 KST(Asia/Seoul) 로 실행 환경 타임존이 고정됐다는 전제로 짠 테스트다.
// `process.env.TZ = 'Asia/Seoul'`를 테스트 코드 안에서 세팅하는 방식은 Node 에서
// 이미 캐시된 타임존을 못 바꾸는 경우가 있어 신뢰할 수 없다. 그래서 이 파일만
// package.json 의 test 스크립트가 `TZ=Asia/Seoul node --test`로 별도 실행한다
// (`npm test` 참고). 나머지 tests/*.js 는 실행 환경 TZ 에 의존하지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDateToken } from '../../dist/monitor.js';
import { logger, setLogLevel } from '../../dist/logger.js';
import { logStartupTimezone } from '../../dist/net.js';

const captureLog = (run) => {
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return captured;
};

test('sanity: this process actually runs under Asia/Seoul', () => {
  assert.strictEqual(process.env.TZ, 'Asia/Seoul');
  assert.strictEqual(new Date().getTimezoneOffset(), -540);
});

test('parseDateToken reads "YYYY.MM.DD HH:mm" board timestamps as KST', () => {
  const now = new Date('2026-08-31T05:00:00.000Z'); // 2026-08-31 14:00 KST
  assert.strictEqual(parseDateToken('2026.08.31 15:00', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads "MM.DD HH:mm" (연도 생략, now 의 연도 사용) as KST', () => {
  const now = new Date('2026-08-31T05:00:00.000Z'); // 2026-08-31 14:00 KST
  assert.strictEqual(parseDateToken('08.31 15:00', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads full Korean date ("YYYY년 M월 D일 H시 m분") as KST', () => {
  const now = new Date('2026-08-31T05:00:00.000Z');
  assert.strictEqual(parseDateToken('2026년 8월 31일 15시 0분', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads Korean month/day without year as KST', () => {
  const now = new Date('2026-08-31T05:00:00.000Z');
  assert.strictEqual(parseDateToken('8월 31일 15시 0분', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads "오늘 HH:mm" against the KST calendar day of `now`', () => {
  const now = new Date('2026-08-31T12:00:00.000Z'); // 2026-08-31 21:00 KST
  assert.strictEqual(parseDateToken('오늘 15:00', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads "어제 HH:mm" as one KST calendar day before `now`', () => {
  const now = new Date('2026-08-31T15:30:00.000Z'); // 2026-09-01 00:30 KST
  assert.strictEqual(parseDateToken('어제 15:00', now), '2026-08-31T06:00:00.000Z');
});

test('parseDateToken reads relative "N분전" as plain epoch arithmetic (TZ 무관)', () => {
  const now = new Date('2026-08-31T05:00:00.000Z');
  assert.strictEqual(parseDateToken('3분전', now), '2026-08-31T04:57:00.000Z');
});

test('logger time field carries the +09:00 KST offset', () => {
  setLogLevel('info');

  const captured = captureLog(() => {
    logger.info('kst check');
  });

  const parsed = JSON.parse(captured[0]);
  assert.match(parsed.time, /\+09:00$/);
});

test('logStartupTimezone reports Asia/Seoul and a +540 minute offset', () => {
  setLogLevel('info');

  const captured = captureLog(() => {
    logStartupTimezone();
  });

  const parsed = JSON.parse(captured[0]);
  assert.strictEqual(parsed.timezone, 'Asia/Seoul');
  assert.strictEqual(parsed.offsetMinutes, 540);
});
