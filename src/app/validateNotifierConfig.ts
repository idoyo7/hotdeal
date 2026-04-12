import type { AppConfig, NotifierTarget } from '../config.js';

export type NotifierValidationResult = {
  slackConfigured: boolean;
  telegramConfigured: boolean;
  discordConfigured: boolean;
  selectedTargets: NotifierTarget[];
  explicitlySelected: boolean;
};

export class NotifierConfigError extends Error {
  constructor(
    message: string,
    public readonly target: string,
    public readonly missing: string[]
  ) {
    super(message);
    this.name = 'NotifierConfigError';
  }
}

export const validateNotifierConfig = (
  config: AppConfig
): NotifierValidationResult => {
  const selectedTargets = config.notifier.targets ?? [];
  const explicitlySelected = selectedTargets.length > 0;
  const isTargetEnabled = (target: NotifierTarget): boolean =>
    explicitlySelected ? selectedTargets.includes(target) : true;

  const slackConfigured =
    isTargetEnabled('slack') && Boolean(config.notifier.slackWebhookUrl);
  const telegramConfigured =
    isTargetEnabled('telegram') &&
    Boolean(config.notifier.telegramBotToken) &&
    Boolean(config.notifier.telegramChatId);
  const discordConfigured =
    isTargetEnabled('discord') && Boolean(config.notifier.discordWebhookUrl);

  if (!config.notifier.dryRun) {
    if (
      explicitlySelected &&
      selectedTargets.includes('slack') &&
      !config.notifier.slackWebhookUrl
    ) {
      throw new NotifierConfigError(
        'SLACK_WEBHOOK_URL is required when slack target is selected',
        'slack',
        ['SLACK_WEBHOOK_URL']
      );
    }

    if (
      explicitlySelected &&
      selectedTargets.includes('telegram') &&
      (!config.notifier.telegramBotToken || !config.notifier.telegramChatId)
    ) {
      throw new NotifierConfigError(
        'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when telegram target is selected',
        'telegram',
        ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']
      );
    }

    if (
      explicitlySelected &&
      selectedTargets.includes('discord') &&
      !config.notifier.discordWebhookUrl
    ) {
      throw new NotifierConfigError(
        'DISCORD_WEBHOOK_URL is required when discord target is selected',
        'discord',
        ['DISCORD_WEBHOOK_URL']
      );
    }

    if (!slackConfigured && !telegramConfigured && !discordConfigured) {
      throw new NotifierConfigError(
        'No notifier configured',
        'all',
        ['slack/telegram/discord credentials']
      );
    }
  }

  return {
    slackConfigured,
    telegramConfigured,
    discordConfigured,
    selectedTargets,
    explicitlySelected,
  };
};
