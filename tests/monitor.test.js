import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { getConfig } from '../dist/config.js';
import { fetchLatestPosts, findMatchingPosts } from '../dist/monitor.js';
import {
  RECURRING_MAX_ITEMS_PER_POLL,
  RECURRING_MAX_PAGES_PER_POLL,
  STARTUP_MAX_ITEMS_PER_POLL,
  STARTUP_MAX_PAGES_PER_POLL,
  resolveCycleProfile,
} from '../dist/runtimeProfile.js';

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

test('findMatchingPosts does not require publishedAt metadata', () => {
  const posts = [
    {
      title: '삼다수 생수 특가',
      link: 'https://www.fmkorea.com/1',
      id: 'id:no-date',
      publishedAt: undefined,
    },
    {
      title: '삼다수 공동구매',
      link: 'https://www.fmkorea.com/2',
      id: 'id:invalid-date',
      publishedAt: 'not-a-date',
    },
    {
      title: '기타 핫딜',
      link: 'https://www.fmkorea.com/3',
      id: 'id:other',
      publishedAt: new Date().toISOString(),
    },
  ];

  const matched = findMatchingPosts(posts, ['삼다수']);
  assert.deepStrictEqual(
    matched.map((post) => post.id),
    ['id:no-date', 'id:invalid-date'],
  );
});

test('findMatchingPosts matches zero-width-obfuscated Korean keyword', () => {
  const posts = [
    {
      title: '펩\u200d시 제로슈거 라임향 355ml 48캔',
      link: 'https://www.fmkorea.com/11',
      id: 'id:pepsi-zwj',
      publishedAt: new Date().toISOString(),
    },
  ];

  const matched = findMatchingPosts(posts, ['펩시']);
  assert.deepStrictEqual(matched.map((post) => post.id), ['id:pepsi-zwj']);
});

test('resolveCycleProfile returns fixed startup and recurring depths', () => {
  assert.deepStrictEqual(resolveCycleProfile(true), {
    name: 'startup',
    maxPagesPerPoll: STARTUP_MAX_PAGES_PER_POLL,
    maxItemsPerPoll: STARTUP_MAX_ITEMS_PER_POLL,
  });
  assert.deepStrictEqual(resolveCycleProfile(false), {
    name: 'recurring',
    maxPagesPerPoll: RECURRING_MAX_PAGES_PER_POLL,
    maxItemsPerPoll: RECURRING_MAX_ITEMS_PER_POLL,
  });
});

test('getConfig ignores removed lookback and page-depth env knobs', () => {
  const removedEnvKeys = {
    recurringHours: `LOOK${'BACK_HOURS'}`,
    startupHours: `STARTUP_${'LOOK' + 'BACK_HOURS'}`,
    recentMatches: `SHOW_${'RECENT_MATCHES'}`,
  };
  const removedConfigKeys = {
    recurringHours: `look${'backHours'}`,
    startupHours: `startup${'LookbackHours'}`,
    recentHours: `showRecent${'Hours'}`,
    recentMatches: `showRecent${'Matches'}`,
  };

  const previousEnv = {
    MAX_PAGES_PER_POLL: process.env.MAX_PAGES_PER_POLL,
    MAX_ITEMS_PER_POLL: process.env.MAX_ITEMS_PER_POLL,
    STARTUP_MAX_PAGES_PER_POLL: process.env.STARTUP_MAX_PAGES_PER_POLL,
    STARTUP_MAX_ITEMS_PER_POLL: process.env.STARTUP_MAX_ITEMS_PER_POLL,
    [removedEnvKeys.recurringHours]: process.env[removedEnvKeys.recurringHours],
    [removedEnvKeys.startupHours]: process.env[removedEnvKeys.startupHours],
    [removedEnvKeys.recentMatches]: process.env[removedEnvKeys.recentMatches],
  };

  process.env.MAX_PAGES_PER_POLL = '99';
  process.env.MAX_ITEMS_PER_POLL = '999';
  process.env.STARTUP_MAX_PAGES_PER_POLL = '77';
  process.env.STARTUP_MAX_ITEMS_PER_POLL = '777';
  process.env[removedEnvKeys.recurringHours] = '999';
  process.env[removedEnvKeys.startupHours] = '999';
  process.env[removedEnvKeys.recentMatches] = 'false';

  try {
    const config = getConfig();
    assert.strictEqual(config.maxPagesPerPoll, RECURRING_MAX_PAGES_PER_POLL);
    assert.strictEqual(config.maxItemsPerPoll, RECURRING_MAX_ITEMS_PER_POLL);
    assert.strictEqual(config.pollOnce, process.env.RUN_ONCE === 'true');
    assert.strictEqual(removedConfigKeys.recurringHours in config, false);
    assert.strictEqual(removedConfigKeys.startupHours in config, false);
    assert.strictEqual(removedConfigKeys.recentHours in config, false);
    assert.strictEqual(removedConfigKeys.recentMatches in config, false);
    assert.strictEqual(resolveCycleProfile(true).maxPagesPerPoll, 5);
    assert.strictEqual(resolveCycleProfile(false).maxPagesPerPoll, 1);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

test('fetchLatestPosts aggregates posts across multiple board URLs', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('board-a.local')) {
      return new Response(
        '<html><body><a href="https://www.fmkorea.com/501">[네이버] 펩시제로슈거 라임향,제로카페인 355ml 48캔</a></body></html>',
        { status: 200 },
      );
    }

    if (url.includes('board-b.local')) {
      return new Response(
        '<html><body><a href="https://www.fmkorea.com/502">[옥션] 펩시제로 라임 210ml 30캔 + 아이시스 300ml 20펫</a></body></html>',
        { status: 200 },
      );
    }

    return new Response('<html><body></body></html>', { status: 404 });
  };

  try {
    const posts = await fetchLatestPosts({
      boardUrl: 'http://board-a.local/hotdeal',
      boardUrls: ['http://board-a.local/hotdeal', 'http://board-b.local/hotdeal'],
      crawlMode: 'http',
      requestIntervalMs: 1000,
      requestTimeoutMs: 5000,
      maxPagesPerPoll: 1,
      maxItemsPerPoll: 30,
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
      keywords: ['펩시'],
      notifier: {
        slackWebhookUrl: undefined,
        telegramBotToken: undefined,
        telegramChatId: undefined,
        discordWebhookUrl: undefined,
        targets: [],
        dryRun: true,
      },
    });

    assert.strictEqual(posts.length, 2);
    assert.deepStrictEqual(
      posts.map((post) => post.id).sort(),
      ['fmkorea-post:501', 'fmkorea-post:502'],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RUN_ONCE executes startup cycle only', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const page = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const body = page === 1
      ? '<html><body><a href="https://www.fmkorea.com/123">제주삼다수 특가</a></body></html>'
      : '<html><body></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const boardUrl = `http://127.0.0.1:${address.port}/hotdeal`;

  try {
    const env = {
      ...process.env,
      RUN_ONCE: 'true',
      DRY_RUN: 'true',
      CRAWL_MODE: 'http',
      USE_REDIS_STATE: 'false',
      LEADER_ELECTION_ENABLED: 'false',
      FMKOREA_BOARD_URL: boardUrl,
      ALERT_KEYWORDS: '삼다수',
      LOG_LEVEL: 'info',
    };

    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`monitor process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 15_000);

      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code ?? 0);
      });
    });

    assert.strictEqual(exitCode, 0, stderr);

    const cycleEvents = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((event) => event && event.event === 'monitor.cycle.completed');

    assert.strictEqual(cycleEvents.length, 1, stdout);
    assert.strictEqual(cycleEvents[0].options?.cycleMode, 'startup');
    assert.strictEqual(/"cycleMode":"recurring"/.test(stdout), false, stdout);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
