import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchLatestPosts, findMatchingPosts } from '../dist/monitor.js';

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

test('findMatchingPosts includes posts regardless of publishedAt', () => {
  const posts = [
    makePost('삼다수 오늘의 특가', 2),
    makePost('삼다수 2주 전 소식', 48),
    { ...makePost('삼다수 무기한 게시글', 0), publishedAt: 'not-a-date' },
    { title: '삼다수 날짜없음', link: 'https://www.fmkorea.com/post-nodate', id: 'id:nodate' },
    makePost('일반 특가', 1),
  ];

  const matched = findMatchingPosts(posts, ['삼다수']);

  assert.strictEqual(matched.length, 4);
  assert.deepStrictEqual(matched.map((post) => post.id), [
    'id:삼다수 오늘의 특가',
    'id:삼다수 2주 전 소식',
    'id:삼다수 무기한 게시글',
    'id:nodate',
  ]);
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
      enableLegacyDomFallbackScrape: false,
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
    assert.strictEqual(posts[0].link, 'https://www.fmkorea.com/9564843258');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts treats plain and trending FMKorea URLs as the same post', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <html><body>
      <a href="https://www.fmkorea.com/9695144650">추천 6</a>
      <a href="https://www.fmkorea.com/index.php?mid=hotdeal&sort_index=pop&order_type=desc&document_srl=9695144650&listStyle=webzine">기글 특가 원문 제목</a>
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
      stateBackend: 'memory',
      dynamoTableName: 'hotdeal-seen-posts',
      dynamoTtlSeconds: 604800,
      dynamoRegion: undefined,
      leaderElectionEnabled: false,
      leaderElectionLeaseName: 'test',
      leaderElectionNamespace: 'default',
      leaderElectionIdentity: 'test-pod',
      leaderElectionLeaseDurationSeconds: 45,
      leaderElectionRenewIntervalMs: 10000,
      logLevel: 'info',
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
      enableLegacyDomFallbackScrape: false,
      keywords: ['기글'],
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
    assert.strictEqual(posts[0].id, 'fmkorea-post:9695144650');
    assert.strictEqual(posts[0].title, '기글 특가 원문 제목');
    assert.strictEqual(posts[0].link, 'https://www.fmkorea.com/9695144650');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts legacy DOM fallback is disabled by default', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <html><body>
      <div class="subject-link">구식 fallback 경로 제목<a href="https://www.fmkorea.com/9564843999"></a></div>
    </body></html>
  `;

  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    await assert.rejects(
      fetchLatestPosts({
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
        enableLegacyDomFallbackScrape: false,
        keywords: ['삼다수'],
        notifier: {
          slackWebhookUrl: undefined,
          telegramBotToken: undefined,
          telegramChatId: undefined,
          discordWebhookUrl: undefined,
          targets: [],
          dryRun: true,
        },
      }),
      /No valid board content found/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts rejects listing-page links that never resolve to a post id', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <html><body>
      <a href="https://m.fmkorea.com/hotdeal">8. 삼다수 -1</a>
      <a href="https://www.fmkorea.com/10277559350">삼다수 정상 게시글</a>
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
      enableLegacyDomFallbackScrape: false,
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
    assert.strictEqual(posts[0].id, 'fmkorea-post:10277559350');
    assert.strictEqual(posts[0].link, 'https://www.fmkorea.com/10277559350');
    assert.ok(!posts.some((post) => post.link === 'https://m.fmkorea.com/hotdeal'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts legacy DOM fallback works only when enabled', async () => {
  const originalFetch = globalThis.fetch;
  const html = `
    <html><body>
      <div class="subject-link">구식 fallback 경로 제목<a href="https://www.fmkorea.com/9564843999"></a></div>
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
      enableLegacyDomFallbackScrape: true,
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
    assert.strictEqual(posts[0].id, 'fmkorea-post:9564843999');
    assert.strictEqual(posts[0].title, '구식 fallback 경로 제목');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- 2차 개선: 크롤 계층 로깅 / 보드별 상한 / ddosCheckOnly 오탐 ---

const captureLog = async (run) => {
  const captured = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => captured.push(args.join(' '));
  console.warn = (...args) => captured.push(args.join(' '));

  try {
    const result = await run();
    return { captured, result };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
};

const parsedLogs = (captured) =>
  captured.map((line) => JSON.parse(line));

const baseTestConfig = (boardUrls, overrides = {}) => ({
  boardUrl: boardUrls[0],
  boardUrls,
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
  stateBackend: 'memory',
  dynamoTableName: 'hotdeal-seen-posts',
  dynamoTtlSeconds: 604800,
  dynamoRegion: undefined,
  leaderElectionEnabled: false,
  leaderElectionLeaseName: 'test',
  leaderElectionNamespace: 'default',
  leaderElectionIdentity: 'test-pod',
  leaderElectionLeaseDurationSeconds: 45,
  leaderElectionRenewIntervalMs: 10000,
  logLevel: 'info',
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
  enableLegacyDomFallbackScrape: false,
  keywords: [],
  notifier: {
    slackWebhookUrl: undefined,
    telegramBotToken: undefined,
    telegramChatId: undefined,
    discordWebhookUrl: undefined,
    targets: [],
    dryRun: true,
  },
  ...overrides,
});

const makeBoardHtml = (basePostId, count, label) => {
  const anchors = [];
  for (let i = 0; i < count; i += 1) {
    anchors.push(`<a href="https://www.fmkorea.com/${basePostId + i}">${label} 특가 ${i}</a>`);
  }
  return `<html><body>${anchors.join('\n')}</body></html>`;
};

test('fetchLatestPosts logs monitor.fetch.board once per board with url/postCount/durationMs/usedMirror/blocked', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrl = 'https://www.fmkorea.com/index.php?mid=hotdeal&page=1';
  globalThis.fetch = async () =>
    new Response(makeBoardHtml(9000000, 2, '단일보드'), { status: 200 });

  try {
    const config = baseTestConfig([boardUrl]);
    const { captured, result: posts } = await captureLog(() => fetchLatestPosts(config));

    assert.strictEqual(posts.length, 2);

    const boardLogs = parsedLogs(captured).filter(
      (entry) => entry.event === 'monitor.fetch.board'
    );
    assert.strictEqual(boardLogs.length, 1);
    assert.strictEqual(boardLogs[0].url, boardUrl);
    assert.strictEqual(boardLogs[0].postCount, 2);
    assert.strictEqual(typeof boardLogs[0].durationMs, 'number');
    assert.strictEqual(boardLogs[0].usedMirror, false);
    assert.strictEqual(boardLogs[0].blocked, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts logs monitor.fetch.blocked with a marker and reports blocked:true on that board', async () => {
  const originalFetch = globalThis.fetch;
  const blockedHtml = '<html><body>에펨코리아 보안 시스템에 의해 접속이 제한되었습니다</body></html>';
  const okBoardUrl = 'https://www.fmkorea.com/index.php?mid=okboard';
  const blockedBoardUrl = 'https://www.fmkorea.com/index.php?mid=securedboard';

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('mid=okboard')) {
      return new Response(makeBoardHtml(9100000, 1, '정상보드'), { status: 200 });
    }
    return new Response(blockedHtml, { status: 200 });
  };

  try {
    const config = baseTestConfig([blockedBoardUrl, okBoardUrl]);
    const { captured, result: posts } = await captureLog(() => fetchLatestPosts(config));

    assert.strictEqual(posts.length, 1);

    const parsed = parsedLogs(captured);
    const blockedWarnings = parsed.filter((entry) => entry.event === 'monitor.fetch.blocked');
    assert.ok(blockedWarnings.length > 0, 'monitor.fetch.blocked 로그가 최소 1건 있어야 한다');
    assert.ok(
      blockedWarnings.every((entry) => entry.marker === '에펨코리아 보안 시스템'),
      'marker 필드가 실제로 판정에 쓰인 문구를 담아야 한다'
    );
    assert.ok(blockedWarnings.every((entry) => typeof entry.url === 'string' && entry.url.length > 0));

    const boardLogs = parsed.filter((entry) => entry.event === 'monitor.fetch.board');
    const blockedBoardLog = boardLogs.find((entry) => entry.url === blockedBoardUrl);
    const okBoardLog = boardLogs.find((entry) => entry.url === okBoardUrl);
    assert.strictEqual(blockedBoardLog.blocked, true);
    assert.strictEqual(blockedBoardLog.postCount, 0);
    assert.strictEqual(okBoardLog.blocked, false);
    assert.strictEqual(okBoardLog.postCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts does not treat a normal page reflecting its own ddosCheckOnly URL as blocked', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrl = 'https://www.fmkorea.com/index.php?mid=hotdeal&ddosCheckOnly=1';
  // 정상 게시판 페이지가 canonical 링크로 자기 요청 URL(ddosCheckOnly=1 포함)을 되돌려주는 경우
  const html = `
    <html><head><link rel="canonical" href="${boardUrl}"></head>
    <body>${makeBoardHtml(9200000, 1, '정상')}</body></html>
  `;
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const config = baseTestConfig([boardUrl]);
    const posts = await fetchLatestPosts(config);
    assert.strictEqual(posts.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts still treats a genuine anti-bot page as blocked', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrl = 'https://www.fmkorea.com/index.php?mid=hotdeal';
  const html = '<html><body>에펨코리아 보안 시스템 - 수동 접속 갱신이 필요합니다 (ddosCheckOnly)</body></html>';
  globalThis.fetch = async () => new Response(html, { status: 200 });

  try {
    const config = baseTestConfig([boardUrl]);
    await assert.rejects(fetchLatestPosts(config), /No valid board content found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const countByLinkPrefix = (posts, prefix) =>
  posts.filter((post) => post.link.includes(`fmkorea.com/${prefix}`)).length;

test('fetchLatestPosts round-robins the shared per-poll cap so equal boards split evenly', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrls = [
    'https://www.fmkorea.com/index.php?mid=board1',
    'https://www.fmkorea.com/index.php?mid=board2',
    'https://www.fmkorea.com/index.php?mid=board3',
  ];

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('mid=board1')) {
      return new Response(makeBoardHtml(1000000, 40, '보드1'), { status: 200 });
    }
    if (target.includes('mid=board2')) {
      return new Response(makeBoardHtml(2000000, 40, '보드2'), { status: 200 });
    }
    return new Response(makeBoardHtml(3000000, 40, '보드3'), { status: 200 });
  };

  try {
    const config = baseTestConfig(boardUrls, { maxItemsPerPoll: 30 });
    const { captured, result: posts } = await captureLog(() => fetchLatestPosts(config));

    assert.strictEqual(posts.length, 30);
    assert.strictEqual(countByLinkPrefix(posts, '1'), 10, '보드1이 정확히 10건이어야 한다');
    assert.strictEqual(countByLinkPrefix(posts, '2'), 10, '보드2가 정확히 10건이어야 한다');
    assert.strictEqual(countByLinkPrefix(posts, '3'), 10, '보드3이 정확히 10건이어야 한다');

    const truncated = parsedLogs(captured).filter(
      (entry) => entry.event === 'monitor.fetch.truncated'
    );
    assert.strictEqual(truncated.length, 1);
    assert.strictEqual(truncated[0].limit, 30);
    assert.strictEqual(truncated[0].collected, 120);
    assert.strictEqual(truncated[0].dropped, 90);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchLatestPosts lets later boards use the slots an earlier board could not fill', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrls = [
    'https://www.fmkorea.com/index.php?mid=board1',
    'https://www.fmkorea.com/index.php?mid=board2',
    'https://www.fmkorea.com/index.php?mid=board3',
  ];

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('mid=board1')) {
      return new Response(makeBoardHtml(1000000, 5, '보드1'), { status: 200 });
    }
    if (target.includes('mid=board2')) {
      return new Response(makeBoardHtml(2000000, 40, '보드2'), { status: 200 });
    }
    return new Response(makeBoardHtml(3000000, 40, '보드3'), { status: 200 });
  };

  try {
    const config = baseTestConfig(boardUrls, { maxItemsPerPoll: 30 });
    const posts = await fetchLatestPosts(config);
    assert.strictEqual(posts.length, 30, '보드1이 못 채운 슬롯을 뒤 보드가 채워 총 30건이어야 한다');
    assert.strictEqual(
      countByLinkPrefix(posts, '1'),
      5,
      '보드1의 5건은 상한 계산과 무관하게 전부 포함돼야 한다'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 프로덕션 회귀: m.fmkorea.com/hotdeal(22건) + www.fmkorea.com/hotdeal(8건) +
// 먹거리 카테고리(0건), limit=30 에서 순차 하드컷(ceil(30/3)=10)이 보드1을
// 22건 중 10건으로 잘라 12건을 근거 없이 버렸다. collected(30)==limit(30)인데
// dropped=12 가 나온 사고였다 — 라운드로빈으로 두 보드의 수확분이 전부 살아야 한다.
test('fetchLatestPosts does not drop posts when total collected already fits under the limit', async () => {
  const originalFetch = globalThis.fetch;
  const boardUrls = [
    'https://m.fmkorea.com/hotdeal',
    'https://www.fmkorea.com/hotdeal',
    'https://www.fmkorea.com/index.php?mid=hotdeal&category=1196844726',
  ];

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('category=1196844726')) {
      return new Response('<html><body>no posts here</body></html>', { status: 200 });
    }
    if (target.startsWith('https://m.fmkorea.com/hotdeal')) {
      return new Response(makeBoardHtml(1000000, 22, '모바일보드'), { status: 200 });
    }
    return new Response(makeBoardHtml(2000000, 8, '데스크톱보드'), { status: 200 });
  };

  try {
    const config = baseTestConfig(boardUrls, { maxItemsPerPoll: 30 });
    const { captured, result: posts } = await captureLog(() => fetchLatestPosts(config));

    assert.strictEqual(posts.length, 30, '수확한 22+8건이 상한 30 안에 다 들어가야 한다');
    assert.strictEqual(countByLinkPrefix(posts, '1'), 22, '보드1의 22건이 전부 살아야 한다');
    assert.strictEqual(countByLinkPrefix(posts, '2'), 8, '보드2의 8건이 전부 살아야 한다');

    const truncated = parsedLogs(captured).filter(
      (entry) => entry.event === 'monitor.fetch.truncated'
    );
    assert.strictEqual(
      truncated.length,
      0,
      'collected(30)==limit(30)이면 아무것도 잘리지 않았으니 truncated 로그가 없어야 한다'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
