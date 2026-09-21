import { load, type CheerioAPI } from 'cheerio';
import type { Browser } from 'playwright-core';
import { AppConfig } from './config.js';
import { HotdealPost } from './types.js';
import { logger } from './logger.js';

let sharedBrowser: Browser | undefined;
let sharedBrowserConfig: string | undefined;
let sharedBrowserCreatedAt = 0;
const BROWSER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24시간마다 브라우저 재생성

const getBrowserConfigKey = (config: AppConfig): string =>
  JSON.stringify({
    wsEndpoint: config.playwrightWsEndpoint,
    headless: config.playwrightHeadless,
    executablePath: config.playwrightExecutablePath,
  });

const getSharedBrowser = async (config: AppConfig): Promise<Browser> => {
  const key = getBrowserConfigKey(config);

  const isExpired = Date.now() - sharedBrowserCreatedAt > BROWSER_MAX_AGE_MS;
  if (sharedBrowser?.isConnected() && sharedBrowserConfig === key && !isExpired) {
    return sharedBrowser;
  }

  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = undefined;
  }

  const mod = await import('playwright-core');
  const chromium = mod.chromium;

  if (config.playwrightWsEndpoint) {
    sharedBrowser = await chromium.connect(config.playwrightWsEndpoint);
  } else {
    let executablePath = config.playwrightExecutablePath;
    let launchArgs = process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [];

    // Lambda: use @sparticuz/chromium-min when no explicit executable path is set
    if (!executablePath) {
      try {
        const sparticuz = (await import('@sparticuz/chromium-min')).default;
        executablePath = await sparticuz.executablePath();
        launchArgs = sparticuz.args;
      } catch {
        // Not available — fall back to playwright-core default resolution
      }
    }

    sharedBrowser = await chromium.launch({
      headless: config.playwrightHeadless,
      executablePath,
      args: launchArgs,
    });
  }

  sharedBrowserConfig = key;
  sharedBrowserCreatedAt = Date.now();

  sharedBrowser.on('disconnected', () => {
    sharedBrowser = undefined;
    sharedBrowserConfig = undefined;
    sharedBrowserCreatedAt = 0;
  });

  return sharedBrowser;
};

export const closeSharedBrowser = async (): Promise<void> => {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = undefined;
    sharedBrowserConfig = undefined;
  }
};

const MAX_PARENT_DEPTH = 4;
// 'ddosCheckOnly'는 원래 마커 목록에 있었지만 동시에 정상 요청에도 흔히
// 붙는 쿼리 파라미터 이름이다(collectUrlCandidates 참고). 정상 게시판 페이지가
// 자기 요청 URL(예: ...&ddosCheckOnly=1)을 canonical 링크나 form action으로
// 그대로 되돌려주면 이 문자열 하나만으로 차단 오탐이 난다. 실제 안티봇 페이지는
// 항상 한글 차단 문구를 동반하므로 그 문구만 신호로 남긴다.
const ANTI_BOT_MARKERS = ['에펨코리아 보안 시스템', '수동 접속 갱신'];
const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
];

const toIso = (value: Date): string => value.toISOString();

export const normalizeKeywordText = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]+/gu, '');

const scoreExtractedTitle = (title: string): number => {
  const clean = title.trim();
  if (!clean) {
    return 0;
  }

  if (/^추천\s*-?\d+$/u.test(clean)) {
    return 1;
  }

  if (/^\d+$/u.test(clean)) {
    return 1;
  }

  if (/^(무료|무배)$/u.test(clean)) {
    return 1;
  }

  return clean.length;
};

export const keywordMatchesTitle = (title: string, keyword: string): boolean => {
  const normalizedKeyword = normalizeKeywordText(keyword);
  if (!normalizedKeyword) {
    return false;
  }

  const normalizedTitle = normalizeKeywordText(title);
  return normalizedTitle.includes(normalizedKeyword);
};

const isLikelyPostUrl = (url: string): boolean => {
  if (!url) {
    return false;
  }

  const lower = url.toLowerCase();
  const blocked = ['login', 'member', 'search', 'logout', 'mypage', 'tag', 'category'];
  if (blocked.some((token) => lower.includes(token))) {
    return false;
  }

  return /fmkorea\.com/.test(lower);
};

const normalizeUrl = (baseUrl: string, raw: string): string => {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
};

const parseRelativeDate = (value: string, now: Date): string | undefined => {
  const compact = value.trim().replace(/\s+/g, '');

  if (compact === '방금' || compact === '방금전') {
    return toIso(now);
  }

  const relativeMatch = compact.match(/(\d+)(초|분|시간|일)전/);
  if (!relativeMatch) {
    return undefined;
  }

  const amount = Number.parseInt(relativeMatch[1], 10);
  if (Number.isNaN(amount)) {
    return undefined;
  }

  const unit = relativeMatch[2];
  const multiplier =
    unit === '초'
      ? 1_000
      : unit === '분'
        ? 60_000
        : unit === '시간'
          ? 3_600_000
          : 86_400_000;

  return toIso(new Date(now.getTime() - amount * multiplier));
};

// exported for KST 파싱 회귀 테스트 (tests/kst/dateParsing.test.js) — 그 외 호출부는 여전히 내부용이다.
export const parseDateToken = (value: string, now: Date): string | undefined => {
  const candidate = value.trim();
  if (!candidate) {
    return undefined;
  }

  const compact = candidate.replace(/\s+/g, '');

  const koreanYearMatch = candidate.match(/(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*(\d{1,2})시\s*(\d{1,2})분?)?/);
  if (koreanYearMatch) {
    const [, year, month, day, hour = '0', minute = '0'] = koreanYearMatch;
    const parsed = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return toIso(parsed);
    }
  }

  const koreanMonthDayMatch = candidate.match(/(?<!\d)(\d{1,2})월\s*(\d{1,2})일(?:\s*(\d{1,2})시\s*(\d{1,2})분?)?(?!\d)/);
  if (koreanMonthDayMatch) {
    const [, month, day, hour = '0', minute = '0'] = koreanMonthDayMatch;
    const parsed = new Date(
      now.getFullYear(),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return toIso(parsed);
    }
  }

  const relative = parseRelativeDate(compact, now);
  if (relative) {
    return relative;
  }

  const todayMatch = compact.match(/(오늘)(?:(\d{1,2}):(\d{2}))?/);
  if (todayMatch) {
    const parsed = new Date(now);
    if (todayMatch[2] && todayMatch[3]) {
      parsed.setHours(Number.parseInt(todayMatch[2], 10), Number.parseInt(todayMatch[3], 10), 0, 0);
    }

    return toIso(parsed);
  }

  const yesterdayMatch = compact.match(/(어제)(?:(\d{1,2}):(\d{2}))?/);
  if (yesterdayMatch) {
    const parsed = new Date(now);
    parsed.setDate(parsed.getDate() - 1);
    if (yesterdayMatch[2] && yesterdayMatch[3]) {
      parsed.setHours(Number.parseInt(yesterdayMatch[2], 10), Number.parseInt(yesterdayMatch[3], 10), 0, 0);
    }

    return toIso(parsed);
  }

  // year/monthDay 는 koreanYearMatch/koreanMonthDayMatch 처럼 공백을 남긴 candidate 로 매칭한다.
  // compact 는 모든 공백을 지우는데, 뒤이은 `\s+(hour):(minute)` 그룹이 그 공백을 전제로 하므로
  // compact 로 매칭하면 "2026.08.31 15:00" 같은 흔한 표기에서 시각이 항상 누락되고 00:00 으로 떨어졌다.
  const yearMatch = candidate.match(/(20\d{2})[\-\/.](\d{1,2})[\-\/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (yearMatch) {
    const [, year, month, day, hour = '0', minute = '0'] = yearMatch;
    const parsed = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return toIso(parsed);
    }
  }

  const monthDayMatch = candidate.match(/(?<!\d)(\d{1,2})[\-\/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?(?!\d)/);
  if (monthDayMatch) {
    const [, month, day, hour = '0', minute = '0'] = monthDayMatch;
    const parsed = new Date(
      now.getFullYear(),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return toIso(parsed);
    }
  }

  const simpleTimeMatch = compact.match(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/);
  if (simpleTimeMatch) {
    const parsed = new Date(now);
    parsed.setHours(Number.parseInt(simpleTimeMatch[1], 10), Number.parseInt(simpleTimeMatch[2], 10), 0, 0);
    if (!Number.isNaN(parsed.getTime())) {
      return toIso(parsed);
    }
  }

  const onlyDigits = compact.replace(/[^0-9]/g, '');
  if (onlyDigits.length >= 10 && onlyDigits.length <= 16) {
    const numeric = Number.parseInt(onlyDigits, 10);
    if (!Number.isNaN(numeric)) {
      const ms = onlyDigits.length === 10 ? numeric * 1000 : numeric;
      const parsedEpoch = new Date(ms);
      if (
        !Number.isNaN(parsedEpoch.getTime()) &&
        parsedEpoch.getFullYear() >= 2020 &&
        parsedEpoch.getFullYear() <= 2035
      ) {
        return toIso(parsedEpoch);
      }
    }
  }

  return undefined;
};

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const dedupeUrls = (urls: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    result.push(url);
  }

  return result;
};

const deriveBoardMirrors = (boardUrl: string): string[] => {
  try {
    const base = new URL(boardUrl);
    const host = base.hostname.toLowerCase();

    if (!host.endsWith('fmkorea.com')) {
      return [];
    }

    const baseHost = host.replace(/^www\./, '').replace(/^m\./, '');
    const mobileHost = `m.${baseHost}`;
    const desktopHost = `www.${baseHost}`;

    if (host === mobileHost) {
      const desktop = new URL(base.toString());
      desktop.hostname = desktopHost;
      return [desktop.toString()];
    }

    if (host === desktopHost) {
      const mobile = new URL(base.toString());
      mobile.hostname = mobileHost;
      return [mobile.toString()];
    }

    const mobile = new URL(base.toString());
    mobile.hostname = mobileHost;
    const desktop = new URL(base.toString());
    desktop.hostname = desktopHost;
    return dedupeUrls([mobile.toString(), desktop.toString()]);
  } catch {
    return [];
  }
};

const extractFmkoreaPostNumber = (link: string): string | undefined => {
  try {
    const parsed = new URL(link);
    if (parsed.hostname.toLowerCase().endsWith('fmkorea.com')) {
      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (/^\d+$/.test(segments[i]!)) {
          return segments[i]!;
        }
      }

      for (const param of ['document_srl', 'no']) {
        const maybeNumber = parsed.searchParams.get(param);
        if (maybeNumber && /^\d+$/.test(maybeNumber)) {
          return maybeNumber;
        }
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
};

const normalizePostLink = (link: string): string => {
  const postNumber = extractFmkoreaPostNumber(link);
  if (!postNumber) {
    return link;
  }

  return `https://www.fmkorea.com/${postNumber}`;
};

const normalizePostId = (link: string): string => {
  const postNumber = extractFmkoreaPostNumber(link);
  if (postNumber) {
    return `fmkorea-post:${postNumber}`;
  }

  return link;
};

// normalizePostId 가 숫자 게시글 번호를 뽑아내지 못하면 링크를 id 로 그대로 돌려주는데,
// 그건 게시글이 아니라 게시판/목록 URL(예: /hotdeal)을 게시글로 착각했다는 신호다.
const POST_ID_PATTERN = /^fmkorea-post:\d+$/;
const isValidPostId = (id: string): boolean => POST_ID_PATTERN.test(id);

// 어떤 마커가 판정 근거였는지 돌려준다 — monitor.fetch.blocked 로그의 marker 필드에 쓴다.
const findBlockMarker = (body: string): string | undefined => {
  const lower = body.toLowerCase();
  return ANTI_BOT_MARKERS.find((marker) => lower.includes(marker.toLowerCase()));
};

const looksLikeBlocked = (body: string): boolean => findBlockMarker(body) !== undefined;

const buildRequestHeaders = (referer: string, userAgent: string): Record<string, string> => ({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.5',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: referer,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': userAgent,
});

const addQueryParam = (url: string, key: string, value: string): string => {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    return `${url}${url.includes('?') ? '&' : '?'}${key}=${value}`;
  }
};

const collectUrlCandidates = (url: string, page: number): string[] => {
  const pageUrl = page <= 1 ? url : addQueryParam(url, 'page', String(page));
  const candidates = [pageUrl, addQueryParam(pageUrl, 'ddosCheckOnly', '1')];
  return candidates.filter((candidate, index, list) => list.indexOf(candidate) === index);
};

type CandidateFetchResult = {
  body?: string;
  notes: string[];
  blocked: boolean;
};

const BLOCK_STATUSES = new Set([403, 429, 430]);

const fetchCandidateByHttp = async (
  candidateUrl: string,
  referer: string,
  userAgent: string,
  timeoutMs: number
): Promise<{ body?: string; note: string; blocked: boolean }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(candidateUrl, {
      headers: buildRequestHeaders(referer, userAgent),
      signal: controller.signal,
    });

    const body = await response.text();
    const marker = findBlockMarker(body);
    const blocked = BLOCK_STATUSES.has(response.status) || marker !== undefined;

    if (blocked) {
      logger.warn('anti-bot block detected', {
        event: 'monitor.fetch.blocked',
        url: candidateUrl,
        marker: marker ?? `http_status_${response.status}`,
      });
    }

    if (!response.ok) {
      return {
        note: `http failed status=${response.status}`,
        blocked,
      };
    }

    if (marker !== undefined) {
      return {
        note: 'http blocked by anti-bot page',
        blocked: true,
      };
    }

    return {
      body,
      note: 'http ok',
      blocked: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return {
      note: `http request error: ${message}`,
      blocked: false,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const fetchCandidateByPlaywright = async (
  candidateUrl: string,
  userAgent: string,
  config: AppConfig
): Promise<{ body?: string; note: string; blocked: boolean }> => {
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;

  try {
    const browser = await getSharedBrowser(config);

    context = await browser.newContext({
      userAgent,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.5',
      },
    });

    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        void route.abort();
        return;
      }

      void route.continue();
    });

    const page = await context.newPage();
    await page.goto(candidateUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwrightNavigationTimeoutMs,
    });

    if (config.playwrightWaitAfterLoadMs > 0) {
      await page.waitForTimeout(config.playwrightWaitAfterLoadMs);
    }

    const body = await page.content();
    await context.close();
    context = undefined;

    const marker = findBlockMarker(body);
    if (marker !== undefined) {
      logger.warn('anti-bot block detected', {
        event: 'monitor.fetch.blocked',
        url: candidateUrl,
        marker,
      });
      return {
        note: 'playwright blocked by anti-bot page',
        blocked: true,
      };
    }

    return {
      body,
      note: 'playwright ok',
      blocked: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return {
      note: `playwright request error: ${message}`,
      blocked: false,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
};

const fetchCandidateBody = async (
  candidateUrl: string,
  referer: string,
  userAgent: string,
  config: AppConfig
): Promise<CandidateFetchResult> => {
  const notes: string[] = [];

  if (config.crawlMode === 'http') {
    const http = await fetchCandidateByHttp(candidateUrl, referer, userAgent, config.requestTimeoutMs);
    notes.push(http.note);
    return {
      body: http.body,
      notes,
      blocked: http.blocked,
    };
  }

  if (config.crawlMode === 'playwright') {
    const playwright = await fetchCandidateByPlaywright(candidateUrl, userAgent, config);
    notes.push(playwright.note);
    return {
      body: playwright.body,
      notes,
      blocked: playwright.blocked,
    };
  }

  const playwright = await fetchCandidateByPlaywright(candidateUrl, userAgent, config);
  notes.push(playwright.note);
  if (playwright.body) {
    return {
      body: playwright.body,
      notes,
      blocked: playwright.blocked,
    };
  }

  const http = await fetchCandidateByHttp(candidateUrl, referer, userAgent, config.requestTimeoutMs);
  notes.push(http.note);
  if (!http.body) {
    return {
      notes,
      blocked: playwright.blocked || http.blocked,
    };
  }

  return {
    body: http.body,
    notes,
    blocked: playwright.blocked || http.blocked,
  };
};

type CheerioNode = ReturnType<CheerioAPI>;

const getPublishedDate = ($node: CheerioNode, now: Date): string | undefined => {
  const candidates: string[] = [];

  const push = (value: string | undefined): void => {
    const normalized = value?.trim();
    if (normalized) {
      candidates.push(normalized);
    }
  };

  push($node.attr('datetime'));
  push($node.attr('data-time'));
  push($node.attr('data-timestamp'));
  push($node.attr('data-date'));
  push($node.attr('title'));
  push($node.find('time').first().attr('datetime'));
  push($node.find('time').first().text());

  let current: CheerioNode = $node;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parent = current.parent();
    if (parent.length === 0) {
      break;
    }

    push(parent.attr('datetime'));
    push(parent.attr('data-time'));
    push(parent.attr('data-timestamp'));
    push(parent.attr('data-date'));
    push(parent.attr('title'));
    push(parent.text());
    current = parent;
  }

  push($node.text());

  const tokenizedCandidates: string[] = [];
  for (const candidate of candidates) {
    const parts = candidate
      .split(/[\t\n\r]+/)
      .flatMap((part) => part.split(/,|\(|\)/g))
      .map((part) => part.trim())
      .filter(Boolean);

    tokenizedCandidates.push(...parts);
  }

  const uniqueCandidates = [...new Set(tokenizedCandidates)];

  for (const candidate of uniqueCandidates) {
    const parsed = parseDateToken(candidate, now);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
};

const extractFromCandidates = (doc: CheerioAPI, baseUrl: string, config: AppConfig): HotdealPost[] => {
  const result: HotdealPost[] = [];
  const used = new Map<string, number>();
  const now = new Date();

  const addPost = (title: string, url: string, publishedAt?: string): void => {
    const cleanTitle = title.trim();
    if (!cleanTitle || cleanTitle.length < 2) {
      return;
    }

    const normalized = normalizePostLink(normalizeUrl(baseUrl, url).split('#')[0]);
    const stableId = normalizePostId(normalized);
    if (!normalized || !isLikelyPostUrl(normalized)) {
      return;
    }

    if (!isValidPostId(stableId)) {
      logger.warn('rejected parsed item without a resolvable post id', {
        event: 'monitor.parse.rejected',
        reason: 'unresolved_post_id',
        title: cleanTitle,
        link: normalized,
      });
      return;
    }

    const existingIndex = used.get(stableId);
    if (existingIndex !== undefined) {
      if (scoreExtractedTitle(cleanTitle) > scoreExtractedTitle(result[existingIndex]?.title ?? '')) {
        result[existingIndex] = { title: cleanTitle, link: normalized, id: stableId, publishedAt };
      }
      return;
    }

    used.set(stableId, result.length);
    result.push({ title: cleanTitle, link: normalized, id: stableId, publishedAt });
  };

  if (config.postSelector) {
    const postNodes = doc(config.postSelector).toArray();
    for (const node of postNodes) {
      const titleNode = config.titleSelector ? doc(node).find(config.titleSelector).first() : doc(node);
      const linkNode = config.linkSelector
        ? doc(node).find(config.linkSelector).first()
        : doc(titleNode).find('a').first();

      const titleText = titleNode
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      const href = linkNode.attr('href')?.trim();
      if (href) {
        const publishedAt = getPublishedDate(doc(node), now);
        addPost(titleText, href, publishedAt);
      }
    }
  }

  const anchors = doc('a[href]').toArray();
  for (const anchor of anchors) {
    const href = doc(anchor).attr('href');
    if (!href) {
      continue;
    }

    const normalized = normalizeUrl(baseUrl, href);
    if (!isLikelyPostUrl(normalized)) {
      continue;
    }

    const titleText = doc(anchor)
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const publishedAt = getPublishedDate(doc(anchor), now);
    addPost(titleText, normalized, publishedAt);
  }

  return result;
};

const extractWithFallback = (doc: CheerioAPI, baseUrl: string, config: AppConfig): HotdealPost[] => {
  const posts = extractFromCandidates(doc, baseUrl, config);
  if (posts.length > 0) {
    return posts;
  }

  if (!config.enableLegacyDomFallbackScrape) {
    return posts;
  }

  const now = new Date();
  const titleHints = ['title', 'subject', 'name', 'subject-link'];
  const fallback: HotdealPost[] = [];
  const used = new Map<string, number>();

  const add = (title: string, link: string, publishedAt?: string): void => {
    const cleanTitle = title.trim().replace(/\s+/g, ' ');
    const normalized = normalizePostLink(normalizeUrl(baseUrl, link).split('#')[0]);
    const stableId = normalizePostId(normalized);
    if (!cleanTitle || !isLikelyPostUrl(normalized)) {
      return;
    }

    if (!isValidPostId(stableId)) {
      logger.warn('rejected parsed item without a resolvable post id', {
        event: 'monitor.parse.rejected',
        reason: 'unresolved_post_id',
        title: cleanTitle,
        link: normalized,
      });
      return;
    }

    const existingIndex = used.get(stableId);
    if (existingIndex !== undefined) {
      if (scoreExtractedTitle(cleanTitle) > scoreExtractedTitle(fallback[existingIndex]?.title ?? '')) {
        fallback[existingIndex] = { title: cleanTitle, link: normalized, id: stableId, publishedAt };
      }
      return;
    }

    used.set(stableId, fallback.length);
    fallback.push({ title: cleanTitle, link: normalized, id: stableId, publishedAt });
  };

  doc('*').each((_, element) => {
    const node = doc(element);
    const classes = node.attr('class')?.toLowerCase() || '';
    const hasHint = titleHints.some((token) => classes.includes(token));
    if (!hasHint) {
      return;
    }

    const link = node.find('a[href]').first().attr('href');
    const title = node.text().trim();
    if (!link || !title) {
      return;
    }

    const publishedAt = getPublishedDate(node, now);
    add(title, link, publishedAt);
  });

  return fallback;
};

/**
 * 단일 보드 소스(+ 미러 fallback)에서 게시글을 가져온다.
 * 미러는 원본 URL이 실패했을 때만 시도하는 fallback이다.
 */
const fetchFromBoardSource = async (
  boardUrl: string,
  config: AppConfig,
  seen: Set<string>,
  userAgents: string[],
  attemptOffset: number
): Promise<{
  posts: HotdealPost[];
  attempts: string[];
  nextOffset: number;
  usedMirror: boolean;
  blocked: boolean;
}> => {
  const posts: HotdealPost[] = [];
  const attempts: string[] = [];
  const mirrors = dedupeUrls([boardUrl, ...deriveBoardMirrors(boardUrl)]);
  let attemptIndex = attemptOffset;
  let usedMirror = false;
  let blocked = false;

  for (const activeBoardUrl of mirrors) {
    let consecutiveEmptyPages = 0;
    let boardHasPosts = false;

    for (let page = 1; page <= config.maxPagesPerPoll; page += 1) {
      const urlCandidates = collectUrlCandidates(activeBoardUrl, page);
      let pageHasPosts = false;

      for (const candidateUrl of urlCandidates) {
        const requestSummary = `${activeBoardUrl}${candidateUrl === activeBoardUrl ? '' : ` -> ${candidateUrl}`}`;
        const userAgent = userAgents[attemptIndex % userAgents.length] ?? config.userAgent;
        attemptIndex += 1;

        const fetched = await fetchCandidateBody(candidateUrl, activeBoardUrl, userAgent, config);
        if (fetched.blocked) {
          blocked = true;
        }
        for (const note of fetched.notes) {
          attempts.push(`${requestSummary} ${note}`);
        }

        if (!fetched.body) {
          continue;
        }

        const $ = load(fetched.body);
        const all = extractWithFallback($, activeBoardUrl, config);
        const newPosts = all.filter((post) => {
          if (seen.has(post.id)) {
            return false;
          }
          seen.add(post.id);
          return true;
        });

        if (newPosts.length === 0) {
          attempts.push(`${requestSummary} parsed 0 new posts`);
          continue;
        }

        pageHasPosts = true;
        boardHasPosts = true;
        posts.push(...newPosts);
        attempts.push(`${requestSummary} parsed ${newPosts.length} new posts`);
        break;
      }

      if (!pageHasPosts) {
        consecutiveEmptyPages += 1;
      } else {
        consecutiveEmptyPages = 0;
      }

      if (consecutiveEmptyPages >= 2) {
        break;
      }

      if (page < config.maxPagesPerPoll && posts.length > 0) {
        await sleep(350);
      }
    }

    // 미러는 fallback — 원본에서 게시글을 찾았으면 미러 시도 불필요
    if (boardHasPosts) {
      usedMirror = activeBoardUrl !== boardUrl;
      break;
    }
  }

  return { posts, attempts, nextOffset: attemptIndex, usedMirror, blocked };
};

// 보드별 결과를 라운드로빈으로 섞는다 — 순차 하드컷(ceil(limit/N))은 뒤에
// 나오는 보드의 실제 수확량을 미리 알 수 없어 앞 보드에 할당한 몫을 되돌려받지
// 못한다(예: 보드1=22, 보드2=8, 보드3=0, limit=30 인데 보드1을 10건으로 잘라
// 12건을 근거 없이 버린 사고). 라운드로빈은 각 보드에서 한 건씩 순서대로
// 가져가다 상한에 닿으면 멈추고, 소진된 보드는 건너뛴다 — 그러면 (a) 모든
// 보드가 최소 대표성을 갖고 (b) 남는 슬롯을 다른 보드가 전부 쓰며 (c) 전체
// 수확량이 상한 이하면 하나도 버리지 않는다.
const roundRobinMerge = (boardPosts: HotdealPost[][], limit: number): HotdealPost[] => {
  const cursors = new Array(boardPosts.length).fill(0);
  const merged: HotdealPost[] = [];

  while (merged.length < limit) {
    let anyTaken = false;

    for (let index = 0; index < boardPosts.length; index += 1) {
      if (merged.length >= limit) {
        break;
      }

      const list = boardPosts[index]!;
      const cursor = cursors[index]!;
      if (cursor >= list.length) {
        continue;
      }

      merged.push(list[cursor]!);
      cursors[index] = cursor + 1;
      anyTaken = true;
    }

    if (!anyTaken) {
      break;
    }
  }

  return merged;
};

export const fetchLatestPosts = async (config: AppConfig): Promise<HotdealPost[]> => {
  const allAttempts: string[] = [];
  const boardPosts: HotdealPost[][] = [];
  const seen = new Set<string>();
  const userAgents = [...new Set([config.userAgent, ...DEFAULT_USER_AGENTS])];
  let attemptIndex = 0;
  const boardCount = config.boardUrls.length;
  let totalFetched = 0;

  // 각 boardUrl은 독립적인 크롤링 소스 — 전부 순회
  for (let index = 0; index < boardCount; index += 1) {
    const boardUrl = config.boardUrls[index]!;
    const boardStartedAt = Date.now();
    const { posts, attempts, nextOffset, usedMirror, blocked } = await fetchFromBoardSource(
      boardUrl,
      config,
      seen,
      userAgents,
      attemptIndex
    );

    attemptIndex = nextOffset;
    allAttempts.push(...attempts);
    totalFetched += posts.length;
    boardPosts.push(posts);

    logger.info('board fetch completed', {
      event: 'monitor.fetch.board',
      url: boardUrl,
      postCount: posts.length,
      durationMs: Date.now() - boardStartedAt,
      usedMirror,
      blocked,
    });

    // 소스 간 요청 간격
    if (posts.length > 0 && index < boardCount - 1) {
      await sleep(500);
    }
  }

  if (totalFetched === 0) {
    const summary = allAttempts.slice(-6).join(' | ');
    throw new Error(`No valid board content found. Attempts: ${summary}`);
  }

  const merged = roundRobinMerge(boardPosts, Math.max(0, config.maxItemsPerPoll));
  const titled = merged.filter((item) => item.title.length > 0);

  if (totalFetched > titled.length) {
    logger.warn('collected posts truncated to configured limit', {
      event: 'monitor.fetch.truncated',
      collected: totalFetched,
      limit: config.maxItemsPerPoll,
      dropped: totalFetched - titled.length,
    });
  }

  return titled;
};

export const findMatchingPosts = (posts: HotdealPost[], keywords: string[]): HotdealPost[] => {
  if (keywords.length === 0) {
    return posts;
  }

  return posts.filter((post) => {
    return keywords.some((keyword) => keywordMatchesTitle(post.title, keyword));
  });
};
