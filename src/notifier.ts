import { AppConfig, TelegramMentionRule } from './config.js';
import { normalizeKeywordText } from './monitor.js';

export type DeliveryResult = {
  ok: boolean;
  target: 'slack' | 'telegram' | 'discord' | 'dry-run';
  message?: string;
  attempts?: number;
};

export type SendAlertsOptions = {
  sleep?: (ms: number) => Promise<void>;
};

const escapeMarkdown = (value: string): string =>
  value.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

// 매칭된 키워드에 해당하는 텔레그램 멘션 대상들을 순서 보존 + 중복 제거로 모은다.
const resolveMentionTargets = (
  rules: TelegramMentionRule[],
  matchedKeywords: string[]
): string[] => {
  const normalizedMatched = matchedKeywords.map((keyword) => normalizeKeywordText(keyword));
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const rule of rules) {
    const normalizedRuleKeyword = normalizeKeywordText(rule.keyword);
    if (!normalizedRuleKeyword || !normalizedMatched.includes(normalizedRuleKeyword)) {
      continue;
    }

    for (const target of rule.targets) {
      if (seen.has(target)) {
        continue;
      }
      seen.add(target);
      targets.push(target);
    }
  }

  return targets;
};

// 숫자 id 는 escapeMarkdown 이후 붙는 raw HTML 링크로, @username 은 그대로 렌더링한다.
const renderMentionsHtml = (targets: string[]): string =>
  targets
    .map((target) => (/^\d+$/.test(target) ? `<a href="tg://user?id=${target}">${target}</a>` : target))
    .join(' ');

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, Math.max(1_000, timeoutMs));

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

// --- 실패 원인 보존 (undici 의 "fetch failed" 뒤에 숨는 진짜 원인을 끌어낸다) ---

type CauseLike = { code?: unknown; message?: unknown; address?: unknown; errors?: unknown };

const describeCauseEntry = (entry: unknown): string | undefined => {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const candidate = entry as CauseLike;
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  if (!code) {
    return undefined;
  }

  const address = typeof candidate.address === 'string' ? candidate.address : undefined;
  return address ? `${code}:${address}` : code;
};

const collectCauseDetails = (cause: unknown): string[] => {
  if (!cause || typeof cause !== 'object') {
    return [];
  }

  const candidate = cause as CauseLike;
  // AggregateError(또는 그 모양을 흉내낸 객체)는 errors 배열에 개별 원인을 담는다 —
  // Happy Eyeballs 가 A/AAAA 를 동시에 시도하다 둘 다 실패하면 이 형태로 온다.
  if (Array.isArray(candidate.errors)) {
    return candidate.errors
      .map(describeCauseEntry)
      .filter((value): value is string => Boolean(value));
  }

  const single = describeCauseEntry(candidate);
  return single ? [single] : [];
};

const describeFetchError = (error: unknown): string => {
  const baseMessage = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const details = collectCauseDetails(cause);
  return details.length > 0 ? `${baseMessage} (${details.join(', ')})` : baseMessage;
};

// --- 재시도 (일시 오류만: 네트워크 예외, 429, 5xx. 그 외 4xx는 즉시 포기) ---

type AttemptResult =
  | { ok: true }
  | { ok: false; retryable: boolean; message: string; retryAfterMs?: number };

const MAX_RETRY_AFTER_MS = 10_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const parseRetryAfterMs = (response: Response): number | undefined => {
  const header = response.headers.get('Retry-After');
  if (!header) {
    return undefined;
  }
  const seconds = Number.parseFloat(header);
  if (Number.isNaN(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1_000;
};

const withRetry = async (
  target: DeliveryResult['target'],
  attempt: () => Promise<AttemptResult>,
  maxAttempts: number,
  retryBaseMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<DeliveryResult> => {
  const attemptCount = Math.max(1, maxAttempts);
  let lastMessage: string | undefined;

  for (let attemptNumber = 1; attemptNumber <= attemptCount; attemptNumber += 1) {
    const result = await attempt();
    if (result.ok) {
      return { ok: true, target, attempts: attemptNumber };
    }

    lastMessage = result.message;
    const isLastAttempt = attemptNumber === attemptCount;
    if (!result.retryable || isLastAttempt) {
      return { ok: false, target, message: lastMessage, attempts: attemptNumber };
    }

    const backoffMs = retryBaseMs * 2 ** (attemptNumber - 1);
    const waitMs = Math.min(result.retryAfterMs ?? backoffMs, MAX_RETRY_AFTER_MS);
    await sleep(waitMs);
  }

  return { ok: false, target, message: lastMessage ?? 'unknown error', attempts: attemptCount };
};

// --- 전송 함수 (단일 시도) ---

const attemptSlackWebhook = async (
  url: string,
  payload: { text: string },
  timeoutMs: number
): Promise<AttemptResult> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error: unknown) {
    return { ok: false, retryable: true, message: `webhook request failed: ${describeFetchError(error)}` };
  }

  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      retryAfterMs: parseRetryAfterMs(response),
      message: `webhook HTTP ${response.status}: ${body}`,
    };
  }

  return { ok: true };
};

const attemptSlackBot = async (
  botToken: string,
  channel: string,
  text: string,
  timeoutMs: number
): Promise<AttemptResult> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      'https://slack.com/api/chat.postMessage',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({ channel, text }),
      },
      timeoutMs
    );
  } catch (error: unknown) {
    return { ok: false, retryable: true, message: `bot request failed: ${describeFetchError(error)}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, retryable: false, message: `bot HTTP ${response.status}: read failed` };
  }

  if (!response.ok) {
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      retryAfterMs: parseRetryAfterMs(response),
      message: `bot HTTP ${response.status}: ${body}`,
    };
  }

  try {
    const parsed = JSON.parse(body) as { ok?: boolean; error?: string };
    if (!parsed.ok) {
      // 200 이지만 API 레벨 오류(예: invalid_auth) — 재시도해도 소용없는 설정 오류다.
      return { ok: false, retryable: false, message: `bot API error: ${parsed.error ?? 'unknown'}` };
    }
  } catch {
    // non-JSON 200 response — treat as success
  }

  return { ok: true };
};

const attemptDiscord = async (
  url: string,
  payload: { content: string },
  timeoutMs: number
): Promise<AttemptResult> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error: unknown) {
    return { ok: false, retryable: true, message: `request failed: ${describeFetchError(error)}` };
  }

  const body = await response.text();
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response);
    const suffix = retryAfterMs !== undefined ? ` (retry-after=${retryAfterMs / 1000}s)` : '';
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      retryAfterMs,
      message: `HTTP ${response.status}${suffix}: ${body}`,
    };
  }

  return { ok: true };
};

const attemptTelegram = async (
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs: number,
  rawHtmlSuffix?: string
): Promise<AttemptResult> => {
  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const safeText = escapeMarkdown(text) + (rawHtmlSuffix ? `\nCC: ${rawHtmlSuffix}` : '');
  let response: Response;
  try {
    response = await fetchWithTimeout(
      telegramApiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: safeText,
          parse_mode: 'HTML',
        }),
      },
      timeoutMs
    );
  } catch (error: unknown) {
    return { ok: false, retryable: true, message: `request failed: ${describeFetchError(error)}` };
  }

  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      retryAfterMs: parseRetryAfterMs(response),
      message: `HTTP ${response.status}: ${body}`,
    };
  }

  return { ok: true };
};

export const sendAlerts = async (
  config: AppConfig,
  title: string,
  postUrl: string,
  matchedKeywords: string[],
  options?: SendAlertsOptions
): Promise<DeliveryResult[]> => {
  const selectedTargets = config.notifier.targets ?? [];
  const isSelected = (target: 'slack' | 'telegram' | 'discord'): boolean =>
    selectedTargets.length === 0 || selectedTargets.includes(target);

  const slackBotConfigured =
    Boolean(config.notifier.slackBotToken) && Boolean(config.notifier.slackChannel);
  const slackWebhookConfigured = Boolean(config.notifier.slackWebhookUrl);
  const slackEnabled = isSelected('slack') && (slackBotConfigured || slackWebhookConfigured);
  const telegramEnabled =
    isSelected('telegram') &&
    Boolean(config.notifier.telegramBotToken) &&
    Boolean(config.notifier.telegramChatId);
  const discordEnabled = isSelected('discord') && Boolean(config.notifier.discordWebhookUrl);

  const mentionTargets = resolveMentionTargets(
    config.notifier.telegramMentionRules ?? [],
    matchedKeywords
  );

  if (config.notifier.dryRun) {
    const baseMessage = `[DRY-RUN] ${title} :: ${postUrl} [${matchedKeywords.join(', ')}]`;
    const telegramMessage =
      mentionTargets.length > 0 ? `${baseMessage} cc=${mentionTargets.join(',')}` : baseMessage;
    if (!slackEnabled && !telegramEnabled && !discordEnabled) {
      return [
        {
          ok: true,
          target: 'dry-run',
          message: baseMessage,
        },
      ];
    }

    const results: DeliveryResult[] = [];
    if (slackEnabled) {
      results.push({ ok: true, target: 'slack', message: baseMessage });
    }
    if (telegramEnabled) {
      results.push({ ok: true, target: 'telegram', message: telegramMessage });
    }
    if (discordEnabled) {
      results.push({ ok: true, target: 'discord', message: baseMessage });
    }
    return results;
  }

  const text =
    `\n[FMKorea Hotdeal Alert]\n` +
    `Title: ${title}\n` +
    `Keywords: ${matchedKeywords.join(', ')}\n` +
    `Link: ${postUrl}`;

  const maxAttempts = config.deliveryMaxAttempts ?? 3;
  const retryBaseMs = config.deliveryRetryBaseMs ?? 500;
  const sleep = options?.sleep ?? defaultSleep;

  const jobs: Promise<DeliveryResult>[] = [];

  if (slackEnabled) {
    if (slackBotConfigured && config.notifier.slackBotToken && config.notifier.slackChannel) {
      const botToken = config.notifier.slackBotToken;
      const channel = config.notifier.slackChannel;
      jobs.push(
        withRetry(
          'slack',
          () => attemptSlackBot(botToken, channel, text, config.requestTimeoutMs),
          maxAttempts,
          retryBaseMs,
          sleep
        )
      );
    } else if (config.notifier.slackWebhookUrl) {
      const webhookUrl = config.notifier.slackWebhookUrl;
      jobs.push(
        withRetry(
          'slack',
          () => attemptSlackWebhook(webhookUrl, { text }, config.requestTimeoutMs),
          maxAttempts,
          retryBaseMs,
          sleep
        )
      );
    }
  }

  if (telegramEnabled && config.notifier.telegramBotToken && config.notifier.telegramChatId) {
    const botToken = config.notifier.telegramBotToken;
    const chatId = config.notifier.telegramChatId;
    const mentionHtml = mentionTargets.length > 0 ? renderMentionsHtml(mentionTargets) : undefined;
    jobs.push(
      withRetry(
        'telegram',
        () => attemptTelegram(botToken, chatId, text, config.requestTimeoutMs, mentionHtml),
        maxAttempts,
        retryBaseMs,
        sleep
      )
    );
  }

  if (discordEnabled && config.notifier.discordWebhookUrl) {
    const webhookUrl = config.notifier.discordWebhookUrl;
    jobs.push(
      withRetry(
        'discord',
        () => attemptDiscord(webhookUrl, { content: text }, config.requestTimeoutMs),
        maxAttempts,
        retryBaseMs,
        sleep
      )
    );
  }

  return Promise.all(jobs);
};
