import { AppConfig } from './config.js';

export type DeliveryResult = {
  ok: boolean;
  target: 'slack' | 'telegram' | 'discord' | 'dry-run';
  message?: string;
};

const escapeMarkdown = (value: string): string =>
  value.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

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

const sendSlack = async (
  url: string,
  payload: { text: string },
  timeoutMs: number
): Promise<DeliveryResult> => {
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
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, target: 'slack', message: `request failed: ${reason}` };
  }

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, target: 'slack', message: `HTTP ${response.status}: ${body}` };
  }

  return { ok: true, target: 'slack' };
};

const sendDiscord = async (
  url: string,
  payload: { content: string },
  timeoutMs: number
): Promise<DeliveryResult> => {
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
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, target: 'discord', message: `request failed: ${reason}` };
  }

  if (!response.ok) {
    const body = await response.text();
    const retryAfter = response.headers.get('Retry-After');
    const suffix = retryAfter ? ` (retry-after=${retryAfter}s)` : '';
    return { ok: false, target: 'discord', message: `HTTP ${response.status}${suffix}: ${body}` };
  }

  return { ok: true, target: 'discord' };
};

const sendTelegram = async (
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs: number
): Promise<DeliveryResult> => {
  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const safeText = escapeMarkdown(text);
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
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, target: 'telegram', message: `request failed: ${reason}` };
  }

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, target: 'telegram', message: `HTTP ${response.status}: ${body}` };
  }

  return { ok: true, target: 'telegram' };
};

export const sendAlerts = async (
  config: AppConfig,
  title: string,
  postUrl: string,
  matchedKeywords: string[]
): Promise<DeliveryResult[]> => {
  const selectedTargets = config.notifier.targets ?? [];
  const isSelected = (target: 'slack' | 'telegram' | 'discord'): boolean =>
    selectedTargets.length === 0 || selectedTargets.includes(target);

  const slackEnabled = isSelected('slack') && Boolean(config.notifier.slackWebhookUrl);
  const telegramEnabled =
    isSelected('telegram') &&
    Boolean(config.notifier.telegramBotToken) &&
    Boolean(config.notifier.telegramChatId);
  const discordEnabled = isSelected('discord') && Boolean(config.notifier.discordWebhookUrl);

  if (config.notifier.dryRun) {
    const baseMessage = `[DRY-RUN] ${title} :: ${postUrl} [${matchedKeywords.join(', ')}]`;
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
      results.push({ ok: true, target: 'telegram', message: baseMessage });
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

  const jobs: Promise<DeliveryResult>[] = [];

  if (slackEnabled && config.notifier.slackWebhookUrl) {
    jobs.push(sendSlack(config.notifier.slackWebhookUrl, { text }, config.requestTimeoutMs));
  }

  if (telegramEnabled && config.notifier.telegramBotToken && config.notifier.telegramChatId) {
    jobs.push(
      sendTelegram(config.notifier.telegramBotToken, config.notifier.telegramChatId, text, config.requestTimeoutMs)
    );
  }

  if (discordEnabled && config.notifier.discordWebhookUrl) {
    jobs.push(sendDiscord(config.notifier.discordWebhookUrl, { content: text }, config.requestTimeoutMs));
  }

  return Promise.all(jobs);
};
