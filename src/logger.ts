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

const reservedKeys = new Set(['level', 'time', 'message', 'error']);

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
  message: string,
  fields?: LogFields,
  error?: unknown
): string => {
  const payload: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
  };

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (reservedKeys.has(key)) {
        continue;
      }
      payload[key] = value;
    }
  }

  payload.message = message;

  if (error !== undefined) {
    payload.error = toSerializableError(error);
  }

  return JSON.stringify(payload);
};

export const setLogLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const logger = {
  debug(message: string, fields?: LogFields): void {
    if (!shouldLog('debug')) {
      return;
    }
    console.log(formatLog('debug', message, fields));
  },
  info(message: string, fields?: LogFields): void {
    if (!shouldLog('info')) {
      return;
    }
    console.log(formatLog('info', message, fields));
  },
  warn(message: string, fields?: LogFields): void {
    if (!shouldLog('warn')) {
      return;
    }
    console.warn(formatLog('warn', message, fields));
  },
  error(message: string, error?: unknown, fields?: LogFields): void {
    if (!shouldLog('error')) {
      return;
    }
    console.error(formatLog('error', message, fields, error));
  },
};
