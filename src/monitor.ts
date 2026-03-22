import { load, type CheerioAPI } from 'cheerio';
import type { Browser } from 'playwright';
import { AppConfig } from './config.js';
import { HotdealPost } from './types.js';

const MAX_PARENT_DEPTH = 4;
const ANTI_BOT_MARKERS = ['에펨코리아 보안 시스템', 'ddosCheckOnly', '수동 접속 갱신'];
const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
];

const toIso = (value: Date): string => value.toISOString();

const normalizeKeywordText = (value: string): string =>
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

const parseDateToken = (value: string, now: Date): string | undefined => {
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

  const yearMatch = compact.match(/(20\d{2})[\-\/.](\d{1,2})[\-\/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
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

  const monthDayMatch = compact.match(/(?<!\d)(\d{1,2})[\-\/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?(?!\d)/);
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

const normalizePostId = (link: string): string => {
  try {
    const parsed = new URL(link);
    if (parsed.hostname.toLowerCase().endsWith('fmkorea.com')) {
      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        if (/^\d+$/.test(segments[i]!)) {
          return `fmkorea-post:${segments[i]}`;
        }
      }

      const maybeNumber = parsed.searchParams.get('no');
      if (maybeNumber) {
        return `fmkorea-post:${maybeNumber}`;
      }
    }

    return link;
  } catch {
    return link;
  }
};

const looksLikeBlocked = (body: string): boolean => {
  const lower = body.toLowerCase();
  return ANTI_BOT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
};

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
    const blocked = BLOCK_STATUSES.has(response.status) || looksLikeBlocked(body);

    if (!response.ok) {
      return {
        note: `http failed status=${response.status}`,
        blocked,
      };
    }

    if (looksLikeBlocked(body)) {
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
): Promise<{ body?: string; note: string }> => {
  let browser: Browser | undefined;

  try {
    const mod = await import('playwright');
    const chromium = mod.chromium;

    if (config.playwrightWsEndpoint) {
      browser = await chromium.connect(config.playwrightWsEndpoint);
    } else {
      const launchArgs = process.platform === 'linux'
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        : [];

      browser = await chromium.launch({
        headless: config.playwrightHeadless,
        executablePath: config.playwrightExecutablePath,
        args: launchArgs,
      });
    }

    const context = await browser.newContext({
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

    if (looksLikeBlocked(body)) {
      return {
        note: 'playwright blocked by anti-bot page',
      };
    }

    return {
      body,
      note: 'playwright ok',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return {
      note: `playwright request error: ${message}`,
    };
  } finally {
    if (browser) {
      await browser.close();
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
    };
  }

  if (config.crawlMode === 'playwright') {
    const playwright = await fetchCandidateByPlaywright(candidateUrl, userAgent, config);
    notes.push(playwright.note);
    return {
      body: playwright.body,
      notes,
    };
  }

  const playwright = await fetchCandidateByPlaywright(candidateUrl, userAgent, config);
  notes.push(playwright.note);
  if (playwright.body) {
    return {
      body: playwright.body,
      notes,
    };
  }

  const http = await fetchCandidateByHttp(candidateUrl, referer, userAgent, config.requestTimeoutMs);
  notes.push(http.note);
  if (!http.body) {
    return {
      notes,
    };
  }

  return {
    body: http.body,
    notes,
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

    const normalized = normalizeUrl(baseUrl, url).split('#')[0];
    const stableId = normalizePostId(normalized);
    if (!normalized || !isLikelyPostUrl(normalized)) {
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
    const normalized = normalizeUrl(baseUrl, link).split('#')[0];
    const stableId = normalizePostId(normalized);
    if (!cleanTitle || !isLikelyPostUrl(normalized)) {
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

export const fetchLatestPosts = async (config: AppConfig): Promise<HotdealPost[]> => {
  const attempts: string[] = [];

  const result: HotdealPost[] = [];
  const seen = new Set<string>();
  const userAgents = [...new Set([config.userAgent, ...DEFAULT_USER_AGENTS])];
  let attemptIndex = 0;

  for (const boardUrl of config.boardUrls) {
    const boardCandidates = dedupeUrls([boardUrl, ...deriveBoardMirrors(boardUrl)]);

    for (const activeBoardUrl of boardCandidates) {
      let consecutiveEmptyPages = 0;

      for (let page = 1; page <= config.maxPagesPerPoll; page += 1) {
        const urlCandidates = collectUrlCandidates(activeBoardUrl, page);
        let pageHasPosts = false;

        for (const candidateUrl of urlCandidates) {
          const requestSummary = `${activeBoardUrl}${candidateUrl === activeBoardUrl ? '' : ` -> ${candidateUrl}`}`;
          const userAgent = userAgents[attemptIndex % userAgents.length] ?? config.userAgent;
          attemptIndex += 1;

          const fetched = await fetchCandidateBody(candidateUrl, activeBoardUrl, userAgent, config);
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
          result.push(...newPosts);
          attempts.push(`${requestSummary} parsed ${newPosts.length} new posts`);

          if (result.length >= config.maxItemsPerPoll) {
            return result.slice(0, config.maxItemsPerPoll).filter((item) => item.title.length > 0);
          }

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

        if (page < config.maxPagesPerPoll && result.length > 0) {
          await sleep(350);
        }
      }

      if (result.length > 0) {
        return result.filter((item) => item.title.length > 0);
      }
    }
  }

  const summary = attempts.slice(-6).join(' | ');
  throw new Error(`No valid board content found. Attempts: ${summary}`);
};

export const findMatchingPosts = (posts: HotdealPost[], keywords: string[]): HotdealPost[] => {
  if (keywords.length === 0) {
    return posts;
  }

  return posts.filter((post) => {
    return keywords.some((keyword) => keywordMatchesTitle(post.title, keyword));
  });
};

export const findRecentMatchedPosts = (
  posts: HotdealPost[],
  keywords: string[],
  nowHours: number,
  includeDateMissing = false
): HotdealPost[] => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - nowHours * 60 * 60_000);

  const filterKeywords = keywords.length > 0 ? keywords : [''];
  const matchesKeyword = (title: string): boolean => {
    if (filterKeywords.length === 1 && filterKeywords[0] === '') {
      return true;
    }

    return filterKeywords.some((keyword) => keywordMatchesTitle(title, keyword));
  };

  return posts.filter((post) => {
    if (!matchesKeyword(post.title)) {
      return false;
    }

    if (!post.publishedAt) {
      return includeDateMissing;
    }

    const publishedTime = new Date(post.publishedAt);
    if (Number.isNaN(publishedTime.getTime())) {
      return includeDateMissing;
    }

    return publishedTime >= cutoff && publishedTime <= now;
  });
};
