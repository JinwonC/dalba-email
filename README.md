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
