import assert from 'node:assert/strict';
import test from 'node:test';

import { findMatchingPosts, findRecentMatchedPosts } from '../dist/monitor.js';

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
