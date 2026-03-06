import { AppConfig } from './config.js';

export type DeliveryResult = {
  ok: boolean;
  target: 'slack' | 'telegram' | 'dry-run';
  message?: string;
};

const escapeMarkdown = (value: string): string =>
  value.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

const sendSlack = async (url: string, payload: { text: string }): Promise<DeliveryResult> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, target: 'slack', message: `HTTP ${response.status}: ${body}` };
  }

  return { ok: true, target: 'slack' };
};

const sendTelegram = async (
  botToken: string,
  chatId: string,
  text: string
): Promise<DeliveryResult> => {
  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const safeText = escapeMarkdown(text);
  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: safeText,
      parse_mode: 'HTML',
    }),
  });

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
  if (config.notifier.dryRun) {
    const baseMessage = `[DRY-RUN] ${title} :: ${postUrl} [${matchedKeywords.join(', ')}]`;
    if (config.notifier.slackWebhookUrl === undefined && config.notifier.telegramBotToken === undefined) {
      return [
        {
          ok: true,
          target: 'dry-run',
          message: baseMessage,
        },
      ];
    }

    const results: DeliveryResult[] = [];
    if (config.notifier.slackWebhookUrl) {
      results.push({ ok: true, target: 'slack', message: baseMessage });
    }
    if (config.notifier.telegramBotToken && config.notifier.telegramChatId) {
      results.push({ ok: true, target: 'telegram', message: baseMessage });
    }
    return results;
  }

  const text =
    `\n[FMKorea Hotdeal Alert]\n` +
    `Title: ${title}\n` +
    `Keywords: ${matchedKeywords.join(', ')}\n` +
    `Link: ${postUrl}`;

  const jobs: Promise<DeliveryResult>[] = [];

  if (config.notifier.slackWebhookUrl) {
    jobs.push(sendSlack(config.notifier.slackWebhookUrl, { text }));
  }

  if (config.notifier.telegramBotToken && config.notifier.telegramChatId) {
    jobs.push(
      sendTelegram(config.notifier.telegramBotToken, config.notifier.telegramChatId, text)
    );
  }

  return Promise.all(jobs);
};
