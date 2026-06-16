# 이메일 회신 트래커 — 호스팅 + Gmail 라이브 연동

우리가 만든 HTML 대시보드를 **Vercel에 호스팅**하고, 열 때마다 **Gmail에서 실시간으로**
"회신 필요(우리 차례)" 메일을 그 포맷으로 가져온다.

## 폴더 구조 (이대로 배치)
```
dalba-inbox-tracker/
├─ index.html          ← (이 폴더의 index.html) 프론트 대시보드
├─ package.json        ← (이 폴더의 package.json)
├─ get-refresh-token.js← 토큰 발급용(로컬 1회)
└─ api/
   └─ threads.js       ← (이 폴더의 threads.js 를 api/ 안에 넣기)
```
> ⚠️ `threads.js` 는 반드시 `api/` 폴더 안에 둬야 `/api/threads` 로 동작함.

## 동작 원리
- 브라우저가 `index.html` 을 염 → `/api/threads` 호출
- 서버 함수가 Gmail API로 받은편지함을 읽고 분류 → JSON 반환 → 표로 렌더
- 열 때마다 최신. (서버 캐시 10분, "새로고침" 버튼 있음)

## 배포 순서

### 1) Google OAuth 클라이언트 만들기
- Google Cloud Console → 새 프로젝트 → **Gmail API 사용 설정**
- 사용자 인증 정보 → OAuth 클라이언트 ID → 유형 **데스크톱 앱** 생성
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 확보

### 2) refresh token 발급 (로컬 1회)
```
npm i googleapis
export GOOGLE_CLIENT_ID=...   # Windows는 set
export GOOGLE_CLIENT_SECRET=...
node get-refresh-token.js
```
- 출력 URL 접속 → **dalbatiktokshopofficial@gmail.com** 로 로그인·동의
- 받은 코드 붙여넣기 → `GOOGLE_REFRESH_TOKEN` 출력됨 (저장)

### 3) Vercel 배포
```
npm i -g vercel
vercel        # 프로젝트 폴더에서
```
- Vercel 대시보드 → Project → Settings → **Environment Variables** 에 추가:
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REFRESH_TOKEN`
  - (선택) `ANTHROPIC_API_KEY` ← 넣으면 요약이 **한국어**로, 없으면 영어 스니펫
- 재배포 → 발급된 URL이 라이브 대시보드. 팀에 공유.

### 4) (선택) 슬랙 자동 게시
- 하루 2번 슬랙에 URL을 던지고 싶으면 GitHub Actions(schedule)나 Vercel Cron으로
  `chat.postMessage` (채널 ID `C0BB70T8VUG`) 호출하는 작은 잡 추가.
- 메시지 예: `📩 이메일 회신 트래커 — {URL}`

## 데일리 매출 보고서 → Slack (api/daily-report.js)

구글시트 **"매출지표"** 의 두 탭을 읽어 매일 Slack **#데일리-분석** 채널에 매출 리포트를 게시한다.
- `매출raw` — 상품×일자 애널리틱스(날짜별 누적) → 섹션 1~5
- `매출발생영상` — 콘텐츠/크리에이터 단위 매출 귀속 → 섹션 6

### 보고서 구성 (6섹션)
1. **전체 요약** — GMV·노출·방문자·장바구니·주문·구매자·AOV (DoD/WoW)
2. **채널별 매출** — Affiliate / Product Card / Seller Video / Seller LIVE (합 100%)
3. **제품별 매출 TOP 10** — DoD·WoW·주문수
4. **크리에이터·콘텐츠 효율** — 영상/라이브 1건당 매출
5. **전환 퍼널** — 노출→클릭→장바구니→주문 + 장바구니율 추이
6. **매출 발생 영상** — 제품별 전체, Content ID·크리에이터·TikTok 링크 (스레드 분할 게시)

### 동작
- `GET /api/daily-report` → 두 탭 읽기 → 집계 → Slack 게시(본문 + 섹션6 스레드)
- `GET /api/daily-report?date=2026-06-13` → **특정일 수동 실행**
- `GET /api/daily-report?dryRun=1` → 게시 없이 결과 JSON 반환(미리보기/검증)
- `매출raw`에서 가장 최신 날짜를 자동 인식, 직전일(DoD)·7일 전(WoW)과 비교
- `매출발생영상`이 하루 lag면 해당 탭의 최신일로 섹션6 작성하고 안내 문구 표시

### 환경변수 (Vercel)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
  - ⚠️ refresh token에 **Sheets 읽기 스코프** 포함 필요:
    `https://www.googleapis.com/auth/spreadsheets.readonly`
- `SHEET_ID` — 스프레드시트 ID (예: `1RjXg3xO1UMhG_Ykmprn4v4bx2gVntOkjW-SE3RZOzhU`)
- (선택) `RAW_SHEET` 기본 `매출raw` · `VIDEO_SHEET` 기본 `매출발생영상`
- (선택) `TOP_N` — 랭킹 개수, 기본 10
- `SLACK_BOT_TOKEN` (+ `SLACK_CHANNEL`, 기본 `C0BAEH36VDX` = #데일리-분석) — 봇에 `chat:write` 권한 + 채널 초대 필요
- (선택) `CRON_SECRET` — 설정 시 `Authorization: Bearer <secret>` 또는 `?secret=` 일치해야 실행 (Vercel Cron이 자동 전송). *슬래시 커맨드는 이 검사에서 제외됨.*

### 스케줄
- `vercel.json` cron 으로 **매일 02:00 UTC = 한국시간 오전 11:00** 자동 실행.
  시간 변경은 `schedule`(cron, UTC 기준) 수정.

### Slack에서 수동 실행 (날짜 입력)
- **슬래시 커맨드** (권장): Slack 앱 설정 → Slash Commands → 새 커맨드
  - Command: `/매출보고서`, Request URL: `https://<배포주소>/api/daily-report`
  - 사용: `/매출보고서 2026-06-13` (날짜 생략 시 최신일)
  - 동작: 입력 날짜로 리포트를 #데일리-분석에 게시 (커맨드는 입력한 채널이 아니라 항상 #데일리-분석으로 게시)
  - ⚠️ 게시 메시지가 여러 건이라 3초 응답 제한을 넘길 수 있으나, 메시지는 정상 게시됨. `CRON_SECRET`을 설정했다면 슬래시 커맨드는 예외 처리되어 동작.
- 또는 브라우저에서 `…/api/daily-report?date=2026-06-13` 직접 호출.

## 분류 로직 (threads.js에 내장, 검증됨)
- 우리측 주소: `@dalba.com` / `dalbatiktokshopofficial@gmail.com`
- 담당자 5명: Nayeon, Lizi, Dohyeon, Anna, Jinwon (본문 서명·호칭에서 추출)
- 회신 필요: 스레드 최근 메시지를 외부(크리에이터)가 보냄
- 노이즈 제외: 구글 보안알림/Kalodata 인증/Surfshark/네이버웍스 발송실패/드라이브공유

## 보안 메모
- 토큰·키는 코드에 넣지 말고 **환경변수**로만. (이미 그렇게 설계됨)
- 대시보드 URL이 공개되면 누구나 받은편지함 요약을 보게 되므로, 필요시 Vercel
  Password Protection(Pro) 또는 간단한 비밀번호 게이트를 추가 권장.
```
