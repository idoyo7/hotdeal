import net from 'node:net';
import { logger } from './logger.js';

/**
 * Node 24 의 global fetch(undici)는 기본적으로 Happy Eyeballs(autoSelectFamily)로
 * A/AAAA 레코드를 함께 시도한다. api.telegram.org 처럼 A+AAAA 를 모두 반환하는
 * 호스트를 IPv6 경로가 없는 클러스터(예: 이 서비스가 배포되는 홈랩 hub 클러스터)에서
 * 호출하면, AAAA 시도가 ENETUNREACH 로 즉시 실패하는데도 undici 가 이를 IPv4 시도까지
 * ETIMEDOUT 으로 끌고 내려가 전체 요청이 무너진다. 클러스터에 IPv6 경로가 생기기 전까지는
 * autoSelectFamily 를 꺼서 IPv4 단독 경로만 쓰게 한다.
 */
export const applyNetworkFamilyPolicy = (autoSelectFamily: boolean): void => {
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(autoSelectFamily);
  }

  logger.info({
    event: 'monitor.startup.networkFamilyPolicy',
    autoSelectFamily,
  });
};

/**
 * 컨테이너는 TZ 를 명시하지 않으면 UTC 로 돈다. `monitor.ts`의 날짜 파싱은 로컬 시각
 * 생성자(`new Date(y, m-1, d, h, min)`)에 의존해 게시판 표기를 KST 로 해석하므로,
 * 배포 환경에서 TZ 설정이 실제로 먹었는지 기동 시점에 로그로 남긴다.
 */
export const logStartupTimezone = (): void => {
  logger.info({
    event: 'monitor.startup.timezone',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: -new Date().getTimezoneOffset(),
  });
};
