import type { LogLevel } from './config.js';

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';

const shouldLog = (level: LogLevel): boolean => priorities[level] >= priorities[currentLevel];

type LogFields = Record<string, unknown>;

// message 를 생략하고 fields 만 넘길 수 있게 한다. event 이름이 이미 무엇이
// 일어났는지 말하는 호출부에서 message 는 동어반복이다.
type LogInput = string | LogFields;

const reservedKeys = new Set(['level', 'time', 'message', 'error']);

/**
 * 정보를 담지 않은 필드를 떨어낸다. `0`·`''`·`null`·`undefined` 만 대상이고
 * `false` 는 남긴다 — `pollOnce: false`, `explicitlySelected: false` 는 정보다.
 *
 * 주의: 이걸 통과한 페이로드에서는 "필드 없음"과 "0"이 구분되지 않는다.
 * 합계 집계에는 영향이 없지만 필드 존재를 조건으로 쓰는 쿼리는 영향을 받는다.
 */
export const compact = (fields: LogFields): LogFields => {
  const result: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === 0 || value === '' || value === null || value === undefined) {
      continue;
    }
    result[key] = value;
  }

  return result;
};

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/**
 * `Date#toISOString()`은 항상 UTC(`Z`)로 나간다. 사용자가 로그를 KST 로 보길 원해서
 * 로컬 오프셋을 붙인 RFC3339 표기로 대체한다. TZ 가 UTC 인 환경에서는 `+00:00`이 붙어
 * 의미는 그대로 유지된다. `new Date(...)`로 다시 파싱 가능하다(logger.test.js 회귀 확인).
 */
const toLocalIsoString = (date: Date): string => {
  const offsetMinutesTotal = -date.getTimezoneOffset();
  const sign = offsetMinutesTotal >= 0 ? '+' : '-';
  const absOffsetMinutes = Math.abs(offsetMinutesTotal);
  const offsetHours = pad(Math.floor(absOffsetMinutes / 60));
  const offsetMinutes = pad(absOffsetMinutes % 60);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${offsetHours}:${offsetMinutes}`
  );
};

const toSerializableError = (error: unknown): unknown => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
};

const formatLog = (
  level: LogLevel,
  message: string | undefined,
  fields?: LogFields,
  error?: unknown
): string => {
  const payload: Record<string, unknown> = {
    level,
    time: toLocalIsoString(new Date()),
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (reservedKeys.has(key)) {
        continue;
      }
      payload[key] = value;
    }
  }

  if (message) {
    payload.message = message;
  }

  if (error !== undefined) {
    payload.error = toSerializableError(error);
  }

  return JSON.stringify(payload);
};

const render = (
  level: LogLevel,
  input: LogInput,
  fields?: LogFields
): string =>
  typeof input === 'string'
    ? formatLog(level, input, fields)
    : formatLog(level, undefined, input);

export const setLogLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const logger = {
  debug(input: LogInput, fields?: LogFields): void {
    if (!shouldLog('debug')) {
      return;
    }
    console.log(render('debug', input, fields));
  },
  info(input: LogInput, fields?: LogFields): void {
    if (!shouldLog('info')) {
      return;
    }
    console.log(render('info', input, fields));
  },
  warn(input: LogInput, fields?: LogFields): void {
    if (!shouldLog('warn')) {
      return;
    }
    console.warn(render('warn', input, fields));
  },
  error(message: string, error?: unknown, fields?: LogFields): void {
    if (!shouldLog('error')) {
      return;
    }
    console.error(formatLog('error', message, fields, error));
  },
};
