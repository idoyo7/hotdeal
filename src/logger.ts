import type { LogLevel } from './config.js';

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  error: 30,
};

let currentLevel: LogLevel = 'info';

const shouldLog = (level: LogLevel): boolean => priorities[level] >= priorities[currentLevel];

const formatLog = (level: LogLevel, message: string): string => {
  const levelLabel = level.toUpperCase();
  const timestamp = new Date().toISOString();
  return `[${levelLabel}] [${timestamp}] ${message}`;
};

export const setLogLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const logger = {
  debug(message: string): void {
    if (!shouldLog('debug')) {
      return;
    }
    console.log(formatLog('debug', message));
  },
  info(message: string): void {
    if (!shouldLog('info')) {
      return;
    }
    console.log(formatLog('info', message));
  },
  error(message: string, error?: unknown): void {
    if (!shouldLog('error')) {
      return;
    }

    if (error === undefined) {
      console.error(formatLog('error', message));
      return;
    }

    console.error(formatLog('error', message), error);
  },
};
