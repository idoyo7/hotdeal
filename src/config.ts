import { config as loadEnv } from 'dotenv';

loadEnv();

export type NotifierConfig = {
  slackWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  dryRun?: boolean;
};

export type MonitoringConfig = {
  boardUrl: string;
  boardUrls: string[];
  crawlMode: 'http' | 'playwright' | 'auto';
  requestIntervalMs: number;
  requestTimeoutMs: number;
  maxPagesPerPoll: number;
  maxItemsPerPoll: number;
  seenStateFile: string;
  useFileState: boolean;
  useRedisState: boolean;
  redisUrl?: string;
  redisKeyPrefix: string;
  redisTtlSeconds: number;
  keywords: string[];
  pollOnce: boolean;
  lookbackHours: number;
  startupLookbackHours: number;
  showRecentMatches: boolean;
  showRecentHours: number;
  userAgent: string;
  playwrightWsEndpoint?: string;
  playwrightExecutablePath?: string;
  playwrightHeadless: boolean;
  playwrightNavigationTimeoutMs: number;
  playwrightWaitAfterLoadMs: number;
  postSelector?: string;
  linkSelector?: string;
  titleSelector?: string;
};

const getEnv = (key: string): string | undefined => {
  const value = process.env[key];
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toBoolean = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
};

const toInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const toCrawlMode = (value: string | undefined): 'http' | 'playwright' | 'auto' => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'playwright' || normalized === 'auto' || normalized === 'http') {
    return normalized;
  }

  return 'playwright';
};

const splitKeywords = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .map((item) => item.toLowerCase())
    .filter(Boolean);
};

const splitList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const dedupeUrls = (items: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
};

export const getConfig = () => {
  const boardUrl =
    getEnv('FMKOREA_BOARD_URL') || 'https://m.fmkorea.com/hotdeal';
  const fallbackBoardUrls = splitList(getEnv('FMKOREA_BOARD_URLS'));
  const boardUrls = dedupeUrls([boardUrl, ...fallbackBoardUrls]);

  const requestIntervalMs = toInt(getEnv('REQUEST_INTERVAL_MS'), 5 * 60 * 1000);
  const requestTimeoutMs = toInt(getEnv('REQUEST_TIMEOUT_MS'), 20_000);
  const crawlMode = toCrawlMode(getEnv('CRAWL_MODE'));
  const maxPagesPerPoll = toInt(getEnv('MAX_PAGES_PER_POLL'), 3);
  const maxItemsPerPoll = toInt(getEnv('MAX_ITEMS_PER_POLL'), 25);
  const seenStateFile = getEnv('STATE_FILE_PATH') || '';
  const useFileState = toBoolean(getEnv('USE_FILE_STATE'), seenStateFile.length > 0);
  const useRedisState = toBoolean(getEnv('USE_REDIS_STATE'), false);
  const redisUrl = getEnv('REDIS_URL');
  const redisKeyPrefix = getEnv('REDIS_KEY_PREFIX') || 'hotdeal:seen:';
  const redisTtlSeconds = toInt(getEnv('REDIS_TTL_SECONDS'), 0);
  const showRecentMatches = toBoolean(getEnv('SHOW_RECENT_MATCHES'), true);
  const lookbackHours = toInt(getEnv('LOOKBACK_HOURS'), 168);
  const startupLookbackHours = toInt(getEnv('STARTUP_LOOKBACK_HOURS'), 24);
  const pollOnce = getEnv('RUN_ONCE') === 'true';
  const userAgent =
    getEnv('USER_AGENT') ||
    'Mozilla/5.0 (compatible; FMKoreaHotdealMonitor/1.0; +https://example.com)';
  const playwrightWsEndpoint = getEnv('PLAYWRIGHT_WS_ENDPOINT');
  const playwrightExecutablePath = getEnv('PLAYWRIGHT_EXECUTABLE_PATH');
  const playwrightHeadless = toBoolean(getEnv('PLAYWRIGHT_HEADLESS'), true);
  const playwrightNavigationTimeoutMs = toInt(getEnv('PLAYWRIGHT_NAV_TIMEOUT_MS'), requestTimeoutMs);
  const playwrightWaitAfterLoadMs = toInt(getEnv('PLAYWRIGHT_WAIT_AFTER_LOAD_MS'), 900);
  const postSelector = getEnv('POST_SELECTOR');
  const linkSelector = getEnv('LINK_SELECTOR');
  const titleSelector = getEnv('TITLE_SELECTOR');

  const keywords = splitKeywords(getEnv('ALERT_KEYWORDS')).filter(Boolean);

  const notifier: NotifierConfig = {
    slackWebhookUrl: getEnv('SLACK_WEBHOOK_URL'),
    telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: getEnv('TELEGRAM_CHAT_ID'),
    dryRun: toBoolean(getEnv('DRY_RUN'), false),
  };

  return {
    boardUrl,
    boardUrls,
    crawlMode,
    requestIntervalMs,
    requestTimeoutMs,
    maxPagesPerPoll,
    maxItemsPerPoll,
    seenStateFile,
    useFileState,
    useRedisState,
    redisUrl,
    redisKeyPrefix,
    redisTtlSeconds,
    lookbackHours,
    startupLookbackHours,
    showRecentMatches,
    showRecentHours: lookbackHours,
    pollOnce,
    userAgent,
    playwrightWsEndpoint,
    playwrightExecutablePath,
    playwrightHeadless,
    playwrightNavigationTimeoutMs,
    playwrightWaitAfterLoadMs,
    postSelector,
    linkSelector,
    titleSelector,
    notifier,
    keywords,
  } as MonitoringConfig & { notifier: NotifierConfig };
};

export type AppConfig = ReturnType<typeof getConfig>;
