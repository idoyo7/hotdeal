# 로깅 개선 노트

작성일: 2026-08-05
상태: **1단계(A) 구현 완료** / 2단계(B, pretty) 미착수 — 아래 "결정할 것" 참조

## 1단계 실측 결과 (구현 후)

`CRAWL_MODE=http RUN_ONCE=true`로 실제 1사이클을 돌려 측정했다.

| event | 전 | 후 | 절감 |
| --- | --- | --- | --- |
| `monitor.cycle.completed` | 411자 | **114자** | **−72%** |
| `monitor.startup.notifierTargets` | 178자 | 138자 | −22% |
| `monitor.poll.options` | — | 188자 | 신규, 기동·전환 시 1회씩만 |

`monitor.cycle.completed`가 예상치(156자)보다 더 줄어든 이유는 카운터가 전부 0인
사이클에서 `result`가 `{}`로 남기 때문이다. `candidates=1, skipped=1`인 사이클은 156자다.

`result` 키 자체는 비어도 유지한다 — 없어졌다 생겼다 하면 파서·쿼리 쪽이 더 번거롭다.

## 문제 정의

로그 한 줄이 너무 길어서 `kubectl logs`로 눈으로 훑기 어렵다.

**볼륨은 문제가 아니다.** 리더 파드만 폴링을 돌고 `REQUEST_INTERVAL_MS=180000`(3분)이라
하루 약 480줄, 약 200KB/day에 그친다. 줄여서 얻을 게 없다.

진짜 문제는 **한 줄이 411자**라는 것이고, 그 411자의 절반 이상이 정보를 담고 있지 않다.

## 실측: 411자의 해부

기준 샘플 (`monitor.cycle.completed`, 정상 사이클):

```json
{"level":"info","time":"2026-08-05T14:12:32.531Z","event":"monitor.cycle.completed","result":{"candidates":1,"fresh":0,"notified":0,"dryRun":0,"failed":0,"skippedAlreadyProcessed":1,"stateCheckFailed":0},"options":{"intervalMs":180000,"maxPagesPerPoll":1,"maxItemsPerPoll":30,"pollOnce":false},"schedule":{"runAt":"2026-08-05T14:12:16.567Z","nextRunAt":"2026-08-05T14:15:16.567Z"},"message":"monitor cycle run"}
```

| 필드 | 길이 | 비중 | 판정 |
| --- | --- | --- | --- |
| `result` | 119자 | 28% | 7개 중 **5개가 0** (`fresh`, `notified`, `dryRun`, `failed`, `stateCheckFailed`). 정상 사이클엔 정보량 0 |
| `options` | 89자 | 21% | **정적 config를 매 줄 반복**. startup → steady 전환 때 딱 한 번 바뀐다 |
| `schedule` | 86자 | 20% | `nextRunAt`은 `runAt + intervalMs`로 **계산 가능**. `runAt`도 top-level `time`과 거의 중복 |
| `message` | 29자 | 7% | `"monitor cycle run"` = `event`의 **동어반복** |
| `level` + `time` + `event` | 80자 | 19% | 필수 |

**결론: JSON 구조화가 문제가 아니라 필드 다이어트 문제다.**
k8s + 로그스택 환경이므로 구조화 자체는 유지하는 게 맞다.

## 방향 후보

### A. 필드 다이어트 (JSON 포맷 유지) — 411자 → 156자 (−62%)

```json
{"level":"info","time":"2026-08-05T14:12:32.531Z","event":"monitor.cycle.completed","result":{"candidates":1,"skippedAlreadyProcessed":1},"durationMs":1943}
```

- 0값 카운터 생략
- `options` 제거 → startup 및 전환 시점에만 기록
- `schedule` → `durationMs` 하나로 대체
- `message` 제거 (`event`와 중복)

### B. A + `LOG_FORMAT=pretty` 옵션 — 411자 → 85자 (−79%)

```
14:12:32 INFO  monitor.cycle.completed  candidates=1 skippedAlreadyProcessed=1 (1.9s)
```

- `LOG_FORMAT` 기본값은 `json` 유지 → 운영 영향 없음
- 로컬·디버그 시 `pretty`로 전환

실패가 섞인 사이클 비교 (0값이 없어 다이어트 효과가 줄어드는 최악 케이스):

| | 길이 |
| --- | --- |
| A | 190자 |
| B | 113자 |

### 권장

**A를 확정으로 두고 B를 그 위에 얹는다.**
A는 어느 방향으로 가든 반드시 필요한 기반 작업이다. 0값·정적·파생 필드는 JSON에서든
pretty에서든 똑같이 노이즈라, B만 하면 "읽기 편한 포맷으로 쓰레기 필드를 찍는" 상태가 된다.
A만 해도 156자면 터미널 한 줄에 대체로 들어와 실용적으로 충분할 수 있다.

## 트레이드오프 (구현 전 확인할 것)

1. **0값 생략** — `notified=0`이 명시적으로 남지 않는다. 합계 집계(`sum`)에는 영향이 없지만,
   "필드 없음"과 "0"을 구분해야 하는 쿼리가 있다면 걸린다.
2. **`options` 제거** — 어떤 설정으로 돌았는지가 매 줄에서 사라진다.
   startup 1회 + **startup(5p/120i) → steady(1p/30i) 전환 시점** 로그로 복원해야 한다.
   이 전환 로그는 반드시 넣는다.
3. **pretty 추가 시** — 포맷 2벌 유지 비용과 테스트 표면이 늘어난다.

## 결정할 것

- [ ] 범위: **A만** / **A + B** / **A + B + 필드명 단축**
      (필드명 단축은 `skippedAlreadyProcessed` → `skipped` 등. 기존 쿼리·대시보드가 있다면 깨진다)
- [ ] OTel `MetadataLookupWarning` 노이즈를 같이 잡을지 (아래 참조)

## TODO

### 1단계 — 필드 다이어트 (A) — 완료

- [x] `src/logger.ts`에 `compact()` 추가 — `0`·`''`·`null`·`undefined` 제거, `false`는 보존
- [x] `monitor.cycle.completed`에서 `options` 블록 제거
- [x] `monitor.cycle.completed`에서 `schedule` 제거하고 `durationMs`로 대체
- [x] `message`가 `event`와 동어반복인 호출부 정리 — **info/warn만**. error는 실패 시 진단
      가치가 있고 빈도가 낮아 의도적으로 남겼다
- [x] `monitor.poll.options` 추가 — 옵션 값이 바뀔 때만 기록하므로 기동(`phase: startup`) +
      startup → steady 전환(`phase: steady`) 2회로 자연히 수렴한다
- [x] 다른 event 점검 — `delivery.sent`, `lambda.invocation.completed`에도 `compact` 적용
- [x] 테스트: `tests/logger.test.js`에 6개 추가 (compact 경계값, message 생략,
      cycle.completed 스냅샷 + 200자 회귀 가드, error message 보존)

`logger.info({...})`처럼 message 없이 fields만 넘기는 호출을 허용하도록 시그니처를
`string | LogFields`로 확장했다. 기존 `logger.info('msg', {...})` 호출부는 그대로 동작한다.

### 2단계 — pretty 포맷 (B, 채택 시)

- [ ] `LOG_FORMAT` 환경변수 추가 (`json` 기본 / `pretty`)
- [ ] `src/config.ts`에 파싱 추가 (`getEnv` → 검증 헬퍼)
- [ ] `src/logger.ts`에 pretty 렌더러 구현
- [ ] `.env.example`에 문서화
- [ ] README 환경변수 표에 추가
- [ ] 테스트: 두 포맷 모두 커버

### 3단계 — 로그 스트림 정합성 (선택)

- [ ] OTel `MetadataLookupWarning` 원인 확인 및 억제
- [ ] 로그 스트림이 100% JSON 파싱되는지 검증

## 참고

### 관련 파일

- `src/logger.ts` — JSON 직렬화, 레벨 필터, `compact()`
- `src/config.ts` — `LOG_LEVEL` 파싱 (`LOG_FORMAT` 추가 지점)
- `src/entrypoints/k8s.ts` — startup 로그, `monitor.cycle.completed`·`monitor.poll.options` 호출부
- `src/app/poll.ts` — `delivery.*`·`stateStore.*` 호출부
- `src/index.ts` — `entrypoints/k8s.js`를 import하는 3줄 shim (`node dist/index.js`가 실배포 커맨드)

### 로거 호출 현황

| 레벨 | 호출 수 |
| --- | --- |
| `logger.debug` | 15 |
| `logger.error` | 10 |
| `logger.info` | 6 |
| `logger.warn` | 2 |

event 이름은 31종. 기본 `LOG_LEVEL=info`에서 실제로 찍히는 건 info/warn/error 18개 호출부다.

### OTel 경고 노이즈

로그 스트림에 JSON이 아닌 줄이 섞인다. 파싱을 깨뜨린다.

```
(node:1) MetadataLookupWarning: received unexpected error = All promises were rejected code = UNKNOWN
(Use `node --trace-warnings ...` to show where the warning was created)
```

OTel auto-instrumentation(`instrumentation.opentelemetry.io/inject-nodejs`)이
GCP 메타데이터 서버를 조회하다 실패하며 내는 경고다. 기동 시 1회 발생한다.

### 실측 재현 명령

```bash
# 리더 파드 확인
kubectl -n hotdeal get lease fmkorea-hotdeal-monitor -o jsonpath='{.spec.holderIdentity}'

# 로그 샘플
kubectl -n hotdeal logs <pod> -c monitor --tail=25

# event별 빈도·평균 길이
kubectl -n hotdeal logs <pod> -c monitor --since=1h \
  | python3 -c "
import json,collections,sys
c,b=collections.Counter(),collections.Counter()
for l in sys.stdin:
    l=l.strip()
    if not l.startswith('{'): continue
    try: r=json.loads(l)
    except: continue
    k=r.get('event','(none)'); c[k]+=1; b[k]+=len(l)
for k,v in c.most_common(): print(f'{v:4}회 평균 {b[k]//v:5}자 {k}')
"
```

### 배포 형상

이 저장소에는 매니페스트가 없다. `idoyo7/montstrap`의 `stage/hotdeal/manifests/`를
ArgoCD가 auto-sync한다. `LOG_FORMAT` 같은 환경변수를 추가하려면 거기 `configmap.yaml`을
수정하고 push하면 된다. Deployment에 `reloader.stakater.com/auto`가 붙어 있어
ConfigMap 변경 시 자동 롤아웃된다.
