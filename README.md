# AUTOHANDS AI QA SYSTEM

URL과 계정을 등록하면 Chromium으로 서비스를 탐색하고, 규칙 기반 필수 검증과 OpenAI LLM 기반 심층 비즈니스 시나리오를 합성하여 테스트 케이스를 생성·실행한 뒤 Screenshot, Trace, Network/Console Log, Excel, ZIP을 생성하는 지능형 QA 자동화 플랫폼입니다.

## 구현 범위

- **Project / Environment / Credential CRUD**: 다중 환경 및 역할(Role)별 다중 계정 지원
- **강력한 보안 아키텍처**: AES-256-GCM 비밀번호 양방향 암호화, 로그 민감정보(Authorization, Cookie, Password 등) 자동 마스킹, 프로덕션 환경 키 미설정 시 실행 차단
- **로그인 화면 자동 탐지**: 계정 로그인 및 세션 유지 탐색
- **서비스 구조 자동 수집(Discovery)**: 동일 도메인 Page / Form / Input / Button / Fetch·XHR 네트워크 엔드포인트 수집
- **지능형 하이브리드 TC 생성**:
  - `RuleProvider`: NORMAL / EXCEPTION / BOUNDARY 필수 TC 100% 무결성 보장
  - `OpenAIProvider`: Discovery 구조를 바탕으로 실무 비즈니스 시나리오 및 권한(PERMISSION) 심층 TC 합성
- **비동기 분산 워커 아키텍처**: Redis 기반 분산 작업 큐(`Reliable Queue Pattern`)를 통해 Playwright 브라우저 실행을 Worker 프로세스로 격리 (API 무중단 보장)
- **Playwright Test Executor**: 다중 뷰포트(반응형 매트릭스), FAIL 시점 전후 증빙 스크린샷, Trace, Network/Console Log
- **안전 정책(Safety Guard)**: Production 환경에서 삭제·환불·결제·출금·탈퇴 등 위험 액션 자동 차단(`BLOCKED`)
- **종합 보고서**: 5개 Sheet Excel 리포트 및 전체 아티팩트 ZIP 다운로드
- **FAIL 재테스트**: 실패한 케이스만 선별 재실행 (원래 실행 계정 승계)
- **Next.js 한국어 대시보드**: 실시간 진행률, 계정 선택 실행, AI 추천 배지 표시

## 빠른 시작 (Docker)

필수 환경: Docker Desktop

```bash
cp .env.example .env
docker compose up --build
```

- 웹 대시보드: `http://localhost:3000`
- API 상태: `http://localhost:4000/health`

## 로컬 개발

Node.js 22+, pnpm, PostgreSQL, Redis가 필요합니다.

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:push
pnpm playwright:install
pnpm dev
```

> **Tip**: Windows PowerShell에서는 `Copy-Item .env.example .env`를 사용하세요.

### Docker 없이 실행 (Windows)

`start-dev.bat` 을 더블클릭하면 됩니다. Docker 가 없으면 프로젝트 안의 로컬 PostgreSQL(`pnpm db:local`, 데이터는 `.local/pgdata`)을 자동으로 띄우고, Redis 없이 API 가 분석·실행 작업을 직접 처리합니다.

- 대시보드: http://localhost:3000 (API 호출은 같은 주소의 `/api/*` 로 프록시됨)
- 전부 종료: `pnpm stop` (이 프로젝트의 API·Web·로컬 DB 프로세스만 찾아서 종료)

### 외부에서 접속하기 (무료, 이 PC + Cloudflare Tunnel)

`start-public.bat` 을 더블클릭하면 이 PC 에서 운영 모드로 실행하고 외부 접속용 HTTPS 주소(`https://xxxx.trycloudflare.com`)를 만들어 줍니다.

- 주소는 창에 표시되고 `_public-url.txt` 에도 저장됩니다. 접속 토큰은 `_public-token.txt` 에 있습니다. (둘 다 git 제외)
- API·대시보드는 이 PC(127.0.0.1)에서만 받고, 외부 접속은 터널을 통해서만 들어옵니다. 로그인(API_TOKEN)은 항상 켜집니다.
- 이 PC 가 속한 사내망·공유기 대역(10.x, 172.16-31.x, 192.168.x)과 localhost 는 테스트 대상으로 쓸 수 없습니다. (외부 사용자가 내부망을 들여다보지 못하도록)
- 무료 임시 주소라 다시 실행할 때마다 주소가 바뀝니다. 고정 주소가 필요하면 Cloudflare 계정에 도메인을 연결한 named tunnel 로 바꾸면 됩니다.
- PC 가 꺼지거나 절전 모드로 들어가면 접속이 끊깁니다.
- 종료: `stop-all.bat`

## QA 시나리오 시트로 테스트하기 (웹 · Android · iOS 공통)

팀에서 쓰는 테스트 시트를 그대로 올려 실행하고, 결과를 **같은 양식에 채워서** 내려받습니다.

- **지원 양식**: `STEP (ID)` | `[CASE유형]` | `Menu Depth (1Depth~6Depth)` | `테스트 항목` | `결과` | `이슈현상` | `발생빈도` | `개발사 확인` | `개발사 조치 사항` | `접수일` | `조치일` | `검수`
  - 헤더 행·열 위치가 시트마다 달라도 자동으로 찾습니다. 메뉴 경로는 "위 행과 같으면 비워 두는" 방식을 그대로 해석합니다.
  - `구분 | 표시` 범례(정상동작=O, 실패=F, 테스트불가=NT, 재확인요청=check …)가 있으면 그 코드로 결과를 씁니다.
- **실행 방식** (업로드할 때 행마다 자동 분류, 프로젝트 화면 「케이스」에서 확인·제외 가능)

| 분류 | 하는 일 | 결과 코드 |
|---|---|---|
| 자동 판정 | 메뉴 경로를 화면 문구로 찾아 누르고, 테스트 항목의 문구("…")·대상(…버튼이 노출)을 확인 | 통과 O / 실패 F |
| 자동 이동 + 사람 확인 | 메뉴 경로까지 자동으로 이동해 화면을 캡처, 판정 근거가 문장에 없으면 사람 확인 요청 | check |
| 테스트불가 | 녹화·녹음, 카메라, 사진첩, 푸시, 여러 기기 동시 실행, CMS 대조, 결제, 선행 케이스가 사람 항목인 경우 | NT (사유 기록) |

  - 메뉴 경로를 화면에서 찾지 못하면 실패가 아니라 **check**(경로 표기와 실제 문구가 다를 수 있음)로 기록합니다.
  - `디바이스 이전버튼` 은 뒤로가기, `0023 선행 작업후 …` 은 0023 케이스의 이동을 먼저 수행한 뒤 이어서 실행합니다.
  - `.env` 에 `OPENAI_API_KEY` 가 있으면 판정 근거를 못 찾은 행을 AI 가 보강합니다.
- **화면 탐색 보조** (웹·앱 공통): 메뉴를 바로 못 찾으면 ① 잠시 기다리고 ② 공지·광고·권한 요청 팝업을 닫고(닫기·나중에·오늘 하루 보지 않기 / 권한은 허용 — 확인·동의 같은 확정 버튼은 누르지 않음) ③ 아래로 스크롤하며(최대 `QA_MAX_SCROLLS`회) 다시 찾습니다. 결과의 참고 기록에 남습니다.
- **재시도와 불안정 판정**: 실패한 케이스는 한 번 더 실행하고, 두 번째에 통과하면 **불안정(FLAKY)** 으로 따로 모읍니다(원본 시트에는 check). `QA_RETRY=0` 이면 재시도하지 않고, `QA_RETRY_NAV=1` 이면 메뉴를 못 찾은 경우도 재시도합니다.
- **결과 확인과 사람 판정**: 실행이 끝나면 결과 화면에 **확인 필요**(실패·재확인·불안정·테스트불가) 목록이 먼저 나옵니다. 항목을 펼쳐 사유와 화면 캡처를 보고 **O 통과 / F 실패 / NT 불가** 로 확정하고 메모를 남기세요. 확정한 판정은 상단 집계, 「FAIL 재테스트」 대상, 원본 양식 결과(`이슈현상` 칸에 `[확인] 메모`)에 그대로 반영됩니다. 「자동 판정으로」를 누르면 되돌립니다.
- **결과 내려받기**: 실행이 끝나면 「원본 양식 결과」 버튼 → 원본 파일의 `결과` 칸에 O/F/check/NT, 실패·재확인·NT 행의 `이슈현상` 칸에 `[AUTOHANDS] 사유`, 실패 행의 `접수일`(비어 있을 때)을 채우고 `AUTOHANDS 자동실행 결과` 요약 시트를 덧붙입니다. 통과 행의 기존 이슈 기록은 지우지 않습니다.

### 기획서 → 기법 기반 TC → 자동 실행 (ISTQB TC 작성 스킬과 연결)

[qa-write-skill-istqb](https://github.com/uuuu66/qa-write-skill-istqb) 스킬로 기획서에서 만든 `test-cases.json` (+ `test-model.json`) 을 그대로 올릴 수 있습니다.

1. Claude 에서 스킬로 TC 를 만들 때 아래 표기만 지키면 자동 실행됩니다.
   - 화면·버튼·입력 칸 이름은 「 」: `「마이페이지」 탭을 누른다`, `「닉네임」 필드에 값을 입력한다` (data: `닉네임=가나`)
   - 화면에 실제로 표시되는 문구는 " ": `"닉네임이 변경되었습니다" 문구가 표시된다`
2. 대시보드 「시트·TC 올리기」에서 두 JSON 파일을 함께 선택 → 팀 QA 시트 양식(STEP ID · 1~6Depth · 테스트 항목 · 결과 …) 엑셀로 바뀌고, 오른쪽에 단계 · 사전조건 · 기법 · 우선순위 · 커버 항목 · 근거 · 제목 열이 붙습니다. 기획서가 답하지 않은 질문은 「열린 질문」 시트와 화면에 표시됩니다.
3. 웹·앱 환경에서 실행 → 같은 엑셀에 O/F/check/NT 가 채워집니다.

해석 규칙: 기대 결과의 " " 문구는 강한 검증(없으면 F), 「 」 화면 이름은 약한 검증(없으면 check). 로그인 외의 사전 조건이 있거나 "~되지 않는다" 는 약한 검증. 해석하지 못한 단계가 나오면 그 앞까지만 실행하고 사람 확인. HTTP 상태·DB 상태만 보는 케이스, 결제·푸시·부하 등은 NT.
기존 시트에도 "단계" 열(위 표기)을 추가하면 메뉴 경로 대신 단계대로 실행합니다.

**판정 개선 제안**: 시트마다 「판정 개선 제안」 엑셀을 내려받으면, 자동으로 판정하지 못하는 행(모호한 표현 · 화면 문구 없음 · 추정 판정)과 고쳐 쓰는 예시가 나옵니다.

### 앱 테스트 준비 (Android / iOS)

앱은 [Appium](https://appium.io) 서버를 통해 실행합니다. 같은 시트를 웹 환경과 앱 환경에서 각각 실행할 수 있습니다.

1. **Android** (Windows PC에서 가능)
   - Android Studio 설치 → 에뮬레이터 생성, 또는 실제 폰을 USB 디버깅으로 연결 (`adb devices` 로 확인)
   - `npm install -g appium` → `appium driver install uiautomator2`
   - `start-appium.bat` 실행 (기본 주소 `http://127.0.0.1:4723`)
2. **iOS**: Mac + Xcode 필요 → Mac 에서 `appium driver install xcuitest` 후 `appium --address 0.0.0.0` 실행, 이 서버의 `.env` 에 `APPIUM_URL=http://<Mac 주소>:4723`
3. 대시보드 프로젝트 화면 → 「환경 추가」 → Android 앱 / iOS 앱 선택 → 앱 ID(패키지명/번들 ID) 입력. 화면에 Appium 연결 상태가 표시됩니다.
4. **앱 로그인**: 환경을 추가할 때 테스트 계정(아이디·비밀번호)을 넣으면, 실행을 시작할 때 앱이 로그인 화면(비밀번호 입력 칸이 있는 화면)이면 자동으로 로그인합니다. 계정을 비워 두면 기기에 미리 로그인된 상태로 실행합니다. 로그인에 실패하면 실행이 "계정을 확인하세요" 로 멈춥니다. 케이스마다 앱을 종료→재실행해 첫 화면에서 시작합니다(로그인 상태 유지).
5. **권한 요청**: Android 는 설치할 때 권한을 자동 허용(`autoGrantPermissions`), iOS 는 시스템 알림을 자동 수락(`autoAcceptAlerts`)합니다. 그래도 뜨는 권한·공지 팝업은 실행 중에 닫습니다.
6. **기기 1대 = 실행 1개**: 같은 기기(Appium 주소 + 기기 이름/UDID)를 쓰는 실행이 이미 돌고 있으면, 뒤 실행은 "기다리는 중" 으로 표시되고 앞 실행이 끝난 뒤 시작합니다(최대 `QA_DEVICE_WAIT_MIN` 분).

## AI(LLM) 설정 (.env)

OpenAI API 키를 등록하면 규칙 기반 케이스와 함께 고차원 비즈니스 시나리오가 자동으로 합성됩니다:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```
*(키가 설정되지 않은 경우에도 규칙 엔진으로 100% 안전하게 동작합니다.)*

## 작업 처리 구조 (분석 · 실행)

- **분석(Discovery + TC 생성)과 테스트 실행은 모두 백그라운드 작업**입니다. API는 작업을 등록하고 즉시 응답(202)하며, 대시보드가 진행 상태를 폴링합니다.
- Redis가 연결되어 있고 **살아 있는 워커가 있으면** 작업은 Redis 큐로 가고 워커가 처리합니다. 워커가 없으면 API 프로세스가 직접 처리합니다(좌측 하단에 현재 모드 표시).
- 워커는 10초마다 하트비트를 남깁니다. 워커가 비정상 종료되면 30초 안에 다른 워커가 남은 작업을 회수해 **이미 저장된 결과는 건너뛰고 이어서 실행**합니다. 같은 작업이 3회 연속 워커를 중단시키면 실패로 기록합니다.
- 실행 시 브라우저는 run 당 1개만 띄우고 **로그인은 한 번**만 수행해 상태(쿠키/localStorage)를 공유합니다. 케이스는 격리된 컨텍스트에서 `QA_CONCURRENCY`(기본 3)개씩 병렬로 실행됩니다. 로그인에 실패하면 케이스를 돌리지 않고 실행이 즉시 실패 처리되며 원인이 대시보드에 표시됩니다.

## 서비스 탐색(Discovery) 동작

- 같은 도메인의 링크를 따라가며 페이지·폼·입력·버튼·API 호출을 수집합니다. (최대 `DISCOVERY_MAX_PAGES`)
- **SPA 지원**: 로그인 화면이나 본문이 늦게 그려지는 화면도 기다렸다가 판단합니다(최대 4초). 아이디 칸 없이 비밀번호(접근 토큰·PIN)만 받는 로그인 화면도 지원합니다.
- **버튼으로 열리는 화면 탐색**: 링크 없이 버튼 클릭으로만 열리는 폼·모달도 찾아 테스트합니다. 생성된 TC 는 같은 버튼을 먼저 눌러 화면을 재현합니다. 저장·실행·생성·삭제·로그아웃 같은 버튼은 누르지 않으며, **운영 환경으로 등록한 대상에서는 버튼을 전혀 누르지 않습니다.** (`DISCOVERY_EXPLORE_CLICKS=false` 로 끌 수 있음)
- 모든 페이지에 반복되는 공통 입력(헤더 검색창 등)은 한 번만 검증합니다.
- 실행 중 **처리되지 않은 스크립트 예외**나 **5xx 응답**이 발생하면 해당 케이스는 FAIL 입니다.

## 보안 설정

- **API 인증**: `.env` 에 `API_TOKEN` 을 설정하면 대시보드에 로그인 화면이 나타나고, 모든 `/api` 호출에 인증이 필요합니다. 로그인하면 HttpOnly 세션 쿠키(12시간)가 발급되며, 다른 시스템에서는 `Authorization: Bearer <토큰>` 으로 호출합니다. 로그인 실패가 5분 안에 10회를 넘으면 잠시 차단됩니다. `NODE_ENV=production` 에서는 토큰 없이 API 가 시작되지 않습니다.
- **CORS**: `CORS_ORIGIN` 에 적은 출처와 정확히 일치해야 허용됩니다. 개발 모드에서만 localhost/127.0.0.1 이 자동 허용됩니다.
- **테스트 대상 정책(SSRF 방지)**: 클라우드 메타데이터 주소(169.254.x, metadata.google.internal 등)는 등록·실행·리다이렉트 모든 단계에서 차단됩니다. 사내 스테이징(사설 IP)은 기본 허용이며, `TARGET_ALLOWLIST` / `TARGET_BLOCK_PRIVATE` 로 더 좁힐 수 있습니다.

## 첫 테스트 워크플로우

1. **새 프로젝트 만들기**: 서비스명, 대상 URL, 계정 정보를 등록합니다.
2. **분석 및 TC 생성**: 대상 서비스를 크롤링하고 하이브리드(규칙+AI) TC를 생성합니다.
3. **테스트 실행**: 실행 모드(SMOKE, REGRESSION, FULL_MATRIX) 및 실행 계정을 선택하고 실행합니다.
4. **결과 확인 & 다운로드**: 실시간 대시보드에서 합격률을 확인하고 Excel 보고서 또는 ZIP을 다운로드합니다.
5. **실패 대응**: 실패 항목 발생 시 **FAIL 재테스트**를 실행합니다.

## 주요 디렉터리

```text
apps/web                  Next.js 대시보드 (반응형, 한국어 UI)
apps/api                  Fastify API + Prisma + Redis 분산 큐 등록
apps/worker               Redis 큐 기반 분산 Playwright 테스트 실행 워커
packages/browser-runner   Playwright Discovery / Executor
packages/test-generator   하이브리드(Rule + OpenAI) 지능형 TC 생성 엔진
packages/report           5개 시트 Excel / ZIP 산출물 생성 모듈
packages/core             AES-256-GCM 암호화, 로그 마스킹, Safety Guard
packages/shared           공용 타입, 상수, Redis 분산 큐 인터페이스
```
