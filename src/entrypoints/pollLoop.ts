import { logger } from '../logger.js';

/**
 * k8s 엔트리포인트의 while 루프에서 쓰는 연속 실패 카운터 상태.
 * 순수 함수로 분리해둔 이유는 index.ts/k8s.ts 는 모듈 로드 시점에
 * main() 을 곧바로 실행해버려서(사이드이펙트) 직접 임포트해 테스트하기
 * 어렵기 때문이다 — 이 상태 전이 로직만 별도 모듈로 떼어 단위 테스트한다.
 */
export type PollLoopState = {
  consecutiveFailures: number;
};

export const MAX_CONSECUTIVE_POLL_FAILURES = 5;

export const nextPollLoopStateOnSuccess = (
  state: PollLoopState
): { state: PollLoopState; readinessChanged: boolean } => {
  if (state.consecutiveFailures === 0) {
    return { state, readinessChanged: false };
  }

  return { state: { consecutiveFailures: 0 }, readinessChanged: true };
};

export const nextPollLoopStateOnFailure = (
  state: PollLoopState,
  maxConsecutiveFailures: number = MAX_CONSECUTIVE_POLL_FAILURES
): { state: PollLoopState; shouldMarkNotReady: boolean } => {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    state: { consecutiveFailures },
    shouldMarkNotReady: consecutiveFailures >= maxConsecutiveFailures,
  };
};

/**
 * 폴링 사이클 한 번(리더 선출 확인 + pollOnce)을 실행한다. 실패해도 예외를
 * 밖으로 던지지 않고 삼켜서 while 루프가 계속 살아있게 한다 — k8s API
 * 오류(ENETUNREACH 등)나 크롤 실패로 프로세스가 죽어 파드가 재시작하는 걸 막는다.
 * 연속 실패가 임계치에 도달하면 markReady(false) 로 readiness 를 내려
 * 프로브가 알아채게 하고, 회복하면 되돌린다.
 */
export const runPollAttempt = async (
  attempt: () => Promise<void>,
  state: PollLoopState,
  markReady: (ready: boolean) => void
): Promise<PollLoopState> => {
  try {
    await attempt();

    const result = nextPollLoopStateOnSuccess(state);
    if (result.readinessChanged) {
      markReady(true);
    }
    return result.state;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const result = nextPollLoopStateOnFailure(state);

    logger.error('poll cycle failed', error, {
      event: 'monitor.poll.failed',
      reason,
      consecutiveFailures: result.state.consecutiveFailures,
    });

    if (result.shouldMarkNotReady) {
      markReady(false);
    }

    return result.state;
  }
};

/**
 * 1회 실행(RUN_ONCE) 모드에서 폴 사이클이 실패했는지. 연속 폴링 모드는 실패해도
 * 계속 돌아야 하지만, run:once 스크립트와 Docker 스모크 테스트는 실패를
 * exit code 로 구분할 수 있어야 한다.
 */
export const runOnceFailed = (state: PollLoopState): boolean =>
  state.consecutiveFailures > 0;

/**
 * 기동 시점 store.load() 실패로 프로세스가 죽는 걸 막는다(fail-open).
 * 나머지 상태 저장소 접근은 전부 fail-open인데 여기만 예외였다 — Redis 가
 * 죽어 있어도 CrashLoopBackOff 에 빠지지 않고 계속 진행해야 한다.
 */
export const loadStateStoreSafely = async (
  store: { load(): Promise<void> }
): Promise<void> => {
  try {
    await store.load();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('state store load failed; continuing without prior state', {
      event: 'stateStore.load.failed',
      reason,
    });
  }
};
