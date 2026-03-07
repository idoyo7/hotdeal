import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchLatestPosts, findMatchingPosts, findRecentMatchedPosts } from '../dist/monitor.js';

const makePost = (title, hoursAgo, hasDate = true) => ({
  title,
  link: `https://www.fmkorea.com/post-${title}`,
  id: `id:${title}`,
  publishedAt: hasDate
    ? new Date(Date.now() - hoursAgo * 60 * 60_000).toISOString()
    : undefined,
});

test('findMatchingPosts matches titles by configured keywords', () => {
  const posts = [
    makePost('삼다수 사은품 증정', 1),
    makePost('제주 삼-다-수 특가', 1),
    makePost('CPU 할인 이벤트', 1),
    makePost('RTX 4080 오픈딜', 1),
  ];

  const matched = findMatchingPosts(posts, ['삼다수', 'rtx']);

  assert.deepStrictEqual(
    matched.map((post) => post.id),
    ['id:삼다수 사은품 증정', 'id:제주 삼-다-수 특가', 'id:RTX 4080 오픈딜'],
  );
});

test('findRecentMatchedPosts filters by lookback and parseable publish date', () => {
  const posts = [
    makePost('삼다수 오늘의 특가', 2),
    makePost('삼다수 2주 전 소식', 48),
    makePost('일반 특가', 1),
    { ...makePost('삼다수 무기한 게시글', 0), publishedAt: 'not-a-date' },
    { title: '삼다수 날짜없음', link: 'https://www.fmkorea.com/post-nodate', id: 'id:nodate' },
  ];

  const recent = findRecentMatchedPosts(posts, ['삼다수'], 24);

  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].title, '삼다수 오늘의 특가');
});

test('findRecentMatchedPosts includes unmatched-date posts when explicitly enabled', () => {
  const posts = [
    { ...makePost('삼다수 날짜없음', 0), publishedAt: undefined },
    { ...makePost('삼다수 잘못된날짜', 48), publishedAt: 'bad-date-format' },
  ];

  const recent = findRecentMatchedPosts(posts, ['삼다수'], 24, true);

  assert.strictEqual(recent.length, 2);
  assert.deepStrictEqual(recent.map((post) => post.id), ['id:삼다수 날짜없음', 'id:삼다수 잘못된날짜']);
});

test('fetchLatestPosts prefers descriptive title over vote-count anchor for same post id', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <html><body>
      <a href="https://www.fmkorea.com/9564843258">추천 6</a>
      <a class="hotdeal_var8Y" href="https://www.fmkorea.com/9564843258">제주삼다수 그린 무라벨 2L 18개 [58]</a>
    </body></html>
  `;

  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const posts = await fetchLatestPosts({
      boardUrl: 'https://www.fmkorea.com/index.php?mid=hotdeal&page=2',
      boardUrls: ['https://www.fmkorea.com/index.php?mid=hotdeal&page=2'],
      crawlMode: 'http',
      requestIntervalMs: 1000,
      requestTimeoutMs: 5000,
      maxPagesPerPoll: 1,
      maxItemsPerPoll: 30,
      startupMaxPagesPerPoll: 1,
      startupMaxItemsPerPoll: 30,
      seenStateFile: './seen.json',
      useFileState: false,
      useRedisState: false,
      redisUrl: undefined,
      redisKeyPrefix: 'hotdeal:seen:',
      redisTtlSeconds: 604800,
      leaderElectionEnabled: false,
      leaderElectionLeaseName: 'test',
      leaderElectionNamespace: 'default',
      leaderElectionIdentity: 'test-pod',
      leaderElectionLeaseDurationSeconds: 45,
      leaderElectionRenewIntervalMs: 10000,
      logLevel: 'info',
      lookbackHours: 3,
      startupLookbackHours: 168,
      showRecentMatches: false,
      showRecentHours: 3,
      pollOnce: true,
      userAgent: 'test-agent',
      playwrightWsEndpoint: undefined,
      playwrightExecutablePath: undefined,
      playwrightHeadless: true,
      playwrightNavigationTimeoutMs: 15000,
      playwrightWaitAfterLoadMs: 1500,
      postSelector: undefined,
      linkSelector: undefined,
      titleSelector: undefined,
      keywords: ['삼다수'],
      notifier: {
        slackWebhookUrl: undefined,
        telegramBotToken: undefined,
        telegramChatId: undefined,
        discordWebhookUrl: undefined,
        targets: [],
        dryRun: true,
      },
    });

    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].title, '제주삼다수 그린 무라벨 2L 18개 [58]');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
