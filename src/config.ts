import { config as loadEnv } from 'dotenv';

loadEnv();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type NotifierTarget = 'slack' | 'telegram' | 'discord';

export type NotifierConfig = {
  slackWebhookUrl?: string;
  slackBotToken?: string;
  slackChannel?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  discordWebhookUrl?: string;
  targets?: NotifierTarget[];
  dryRun?: boolean;
};

export type StateBackend = 'memory' | 'file' | 'redis' | 'dynamodb';

export type MonitoringConfig = {
  boardUrl: string;
  boardUrls: string[];
  crawlMode: 'http' | 'playwright' | 'auto';
  requestIntervalMs: number;
  requestTimeoutMs: number;
  maxPagesPerPoll: number;
  maxItemsPerPoll: number;
  startupMaxPagesPerPoll: number;
  startupMaxItemsPerPoll: number;
  seenStateFile: string;
  useFileState: boolean;
  useRedisState: boolean;
  redisUrl?: string;
  redisKeyPrefix: string;
  redisTtlSeconds: number;
  stateBackend: StateBackend;
  dynamoTableName: string;
  dynamoTtlSeconds: number;
  dynamoRegion?: string;
  leaderElectionEnabled: boolean;
  leaderElectionLeaseName: string;
  leaderElectionNamespace: string;
  leaderElectionIdentity: string;
  leaderElectionLeaseDurationSeconds: number;
  leaderElectionRenewIntervalMs: number;
  logLevel: LogLevel;
  keywords: string[];
  pollOnce: boolean;
  userAgent: string;
  playwrightWsEndpoint?: string;
  playwrightExecutablePath?: string;
  playwrightHeadless: boolean;
  playwrightNavigationTimeoutMs: number;
  playwrightWaitAfterLoadMs: number;
  postSelector?: string;
  linkSelector?: string;
  titleSelector?: string;
  enableLegacyDomFallbackScrape: boolean;
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

const toLogLevel = (value: string | undefined): LogLevel => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return 'info';
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

const toNotifierTargets = (value: string | undefined): NotifierTarget[] => {
  const parsed = splitList(value).map((item) => item.toLowerCase());
  const seen = new Set<NotifierTarget>();
  const result: NotifierTarget[] = [];

  for (const item of parsed) {
    if (item !== 'slack' && item !== 'telegram' && item !== 'discord') {
      continue;
    }

    const target = item as NotifierTarget;
    if (seen.has(target)) {
      continue;
    }

    seen.add(target);
    result.push(target);
  }

  return result;
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

  const requestIntervalMs = toInt(getEnv('REQUEST_INTERVAL_MS'), 3 * 60 * 1000);
  const requestTimeoutMs = toInt(getEnv('REQUEST_TIMEOUT_MS'), 20_000);
  const crawlMode = toCrawlMode(getEnv('CRAWL_MODE'));
  const maxPagesPerPoll = toInt(getEnv('MAX_PAGES_PER_POLL'), 1);
  const maxItemsPerPoll = toInt(getEnv('MAX_ITEMS_PER_POLL'), 30);
  const startupMaxPagesPerPoll = toInt(getEnv('STARTUP_MAX_PAGES_PER_POLL'), maxPagesPerPoll);
  const startupMaxItemsPerPoll = toInt(getEnv('STARTUP_MAX_ITEMS_PER_POLL'), maxItemsPerPoll);
  const seenStateFile = getEnv('STATE_FILE_PATH') || '';
  const useFileState = toBoolean(getEnv('USE_FILE_STATE'), seenStateFile.length > 0);
  const useRedisState = toBoolean(getEnv('USE_REDIS_STATE'), false);
  const redisUrl = getEnv('REDIS_URL');
  const redisKeyPrefix = getEnv('REDIS_KEY_PREFIX') || 'hotdeal:seen:';
  const redisTtlSeconds = toInt(getEnv('REDIS_TTL_SECONDS'), 604_800);

  // State backend: explicit selection or backward-compatible derivation
  const stateBackendRaw = getEnv('STATE_BACKEND')?.trim().toLowerCase();
  const stateBackend: 'memory' | 'file' | 'redis' | 'dynamodb' =
    stateBackendRaw === 'redis' || stateBackendRaw === 'dynamodb' ||
    stateBackendRaw === 'file' || stateBackendRaw === 'memory'
      ? stateBackendRaw
      : useRedisState ? 'redis' : useFileState ? 'file' : 'memory';
  const dynamoTableName = getEnv('DYNAMODB_TABLE_NAME') || 'hotdeal-seen-posts';
  const dynamoTtlSeconds = toInt(getEnv('DYNAMODB_TTL_SECONDS'), 604_800);
  const dynamoRegion = getEnv('DYNAMODB_REGION') || getEnv('AWS_REGION');

  const leaderElectionEnabled = toBoolean(getEnv('LEADER_ELECTION_ENABLED'), false);
  const leaderElectionLeaseName = getEnv('LEADER_ELECTION_LEASE_NAME') || 'fmkorea-hotdeal-monitor';
  const leaderElectionNamespace =
    getEnv('LEADER_ELECTION_NAMESPACE') || getEnv('POD_NAMESPACE') || 'default';
  const leaderElectionIdentity =
    getEnv('LEADER_ELECTION_IDENTITY') || getEnv('POD_NAME') || `monitor-${process.pid}`;
  const leaderElectionLeaseDurationSeconds = toInt(getEnv('LEADER_ELECTION_LEASE_DURATION_SECONDS'), 30);
  const leaderElectionRenewIntervalMs = toInt(getEnv('LEADER_ELECTION_RENEW_INTERVAL_MS'), 10_000);
  const logLevel = toLogLevel(getEnv('LOG_LEVEL'));
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
  const enableLegacyDomFallbackScrape = toBoolean(getEnv('ENABLE_LEGACY_DOM_FALLBACK_SCRAPE'), false);
  const notifierTargets = toNotifierTargets(getEnv('NOTIFIER_TARGETS'));

  const keywords = splitKeywords(getEnv('ALERT_KEYWORDS')).filter(Boolean);

  const notifier: NotifierConfig = {
    slackWebhookUrl: getEnv('SLACK_WEBHOOK_URL'),
    slackBotToken: getEnv('SLACK_BOT_TOKEN'),
    slackChannel: getEnv('SLACK_CHANNEL'),
    telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: getEnv('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: getEnv('DISCORD_WEBHOOK_URL'),
    targets: notifierTargets,
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
    startupMaxPagesPerPoll,
    startupMaxItemsPerPoll,
    seenStateFile,
    useFileState,
    useRedisState,
    redisUrl,
    redisKeyPrefix,
    redisTtlSeconds,
    stateBackend,
    dynamoTableName,
    dynamoTtlSeconds,
    dynamoRegion,
    leaderElectionEnabled,
    leaderElectionLeaseName,
    leaderElectionNamespace,
    leaderElectionIdentity,
    leaderElectionLeaseDurationSeconds,
    leaderElectionRenewIntervalMs,
    logLevel,
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
    enableLegacyDomFallbackScrape,
    notifier,
    keywords,
  } as MonitoringConfig & { notifier: NotifierConfig };
};

export type AppConfig = ReturnType<typeof getConfig>;
