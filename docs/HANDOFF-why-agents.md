# 매출 원인 지도 + 에이전트 리포트 — 인수인계

다른 Claude 세션에서 이어서 작업하기 위한 메모. (2026-11-14 기준)

## 한 줄 요약
d'Alba US 틱톡샵 매출이 왜 움직였는지 보여주는 웹페이지(`why.html`)와, 제품별 AI 에이전트 10명 + 라이브 에이전트 1명이 매일 분석해 주는 리포트 탭.

- 사이트: https://project-zizml.vercel.app/why.html (Vercel, `main` 브랜치 자동 배포)
- 저장소: `JinwonC/dalba-email`
- 작업 방식: 작업 브랜치에서 커밋 → PR → squash 머지 → Vercel 자동 배포 → 실제 화면 캡처로 확인

## 데이터 출처 (중요)
- **원본 시트** `15dP91bH_skc7ZzcJ3ehH9H4IKCzSxcfuOcREr3OaL0o` (슬랙용 IMPORTRANGE 시트는 쓰지 않는다. 행 수 한도로 깨져 있음)
  - `(중요,수동) 제품별 유입매출 RAW (520업데이트)` — 제품×날짜 매출·퍼널·채널(셀러 라이브/셀러 영상/크리에이터/상품카드)
  - `(중요,수동) 주문별 AF 매출 RAW` — A 날짜, C PID, F Price(판매가), G 결제액, I 수량, M 크리에이터, N 콘텐츠 유형(Video/Livestream), O 콘텐츠 ID
  - `(수동) 브랜드 라이브 RAW` — 방송 세션별 (dalba_global)
  - `(수동) AF LIVE RAW` — 크리에이터 라이브 세션별
- **광고 시트** `1AhVPPUq6Npri72uhtFcOUVMBl1jA7nf2P0qDCDRRKfA`
  - `캠페인 광고성과`, `소재별 광고성과`(약 31만 행 → 끝부분만 읽음), `PID 매칭`, `TROI 변동 내역`
- 시트 입력이 보통 1~2일 늦다. 아직 안 들어온 날짜는 제품 매출이 0으로 나온다.
- 영상 ID → 포스팅일: `Number(BigInt(id) >> 32n)` 초 (PT 기준).

## 파일
| 파일 | 역할 |
|---|---|
| `api/why.js` | `/api/why?a=&a2=&b=&b2=` 두 기간 비교 데이터 (스토어·채널·제품·광고·소재·크리에이터 TOP·브랜드/AF 라이브·제품별 판매가 분포). 10분 캐시 |
| `api/agents.js` | 에이전트. `GET ?a=날짜` 저장된 결과, `POST ?a=&agent=키` 한 명 실행, `GET ?cron=1` 매일 자동 실행. 결과는 Vercel Blob `agents/날짜/에이전트.json` |
| `api/handles.js` | 영상 ID → 크리에이터 핸들 (TikTok 페이지) |
| `why.html` | 화면. 탭: 에이전트 리포트 / 요약(채널 폭포 그래프 + 원인 지도) / 광고 소재(제품별 판정 막대·KILL·부스팅·영상 ID) / 크리에이터 TOP 30 / 라이브(방송 파이프·30일 그래프·AF 흐름 지도) |
| `agents.html` | `why.html?tab=ag`로 넘김 |
| `vercel.json` | cron: `/api/daily-report` 01:30 UTC, `/api/agents?cron=1` 04:10 UTC(한국 13:10) |

## 에이전트
- 제품 10명: 그라인딩, PRO 2X, 퍼스트 기프트세트, 퍼스트 본품, 보르피린3종, 톤업, 비타 5종, 더블라인, 반반패드, 톤업 홀리데이 세트 (`AGENTS` 배열, PID 포함)
- 라이브 1명: 브랜드 라이브 퍼널·판매 제품 + AF 라이브 크리에이터
- 기준일을 **전날, 지난주 같은 요일**과 비교. 결과(JSON): headline, verdict, why[], video, price, ads, live, actions[], watch
- 소재 판정: ROI<1 또는 지출만 → KILL 검토, 1~1.5 주의, 1.5~3 좋음, ≥3 또는 지출 없이 매출 → 아주 좋음, 좋음 이상 & 일 광고비<$20 → 부스팅 권장. 광고비<$3 & 매출<$15는 판정 안 함

## 지금 막힌 것
- **Vercel에 `ANTHROPIC_API_KEY`가 없다.** 그래서 에이전트가 실행되지 않는다 (데일리 리포트 AI 한줄평도 꺼져 있었을 것).
  - Max 요금제는 claude.ai/Claude Code 사용분이라 **API 호출 비용은 포함되지 않는다.** API 키는 console.anthropic.com에서 따로 만들고 크레딧 충전이 필요.
  - 대안: API 키 없이 Max 요금제 안에서 돌리려면, Claude Code **예약 작업**이 매일 `/api/why` 데이터를 읽어 11개 분석을 쓰고, 결과를 사이트에 저장하는 엔드포인트(예: `POST /api/agents?save=1`, 비밀번호 필요)로 올리는 방식으로 바꾸면 된다. (아직 구현 안 함)
- 실행 비밀번호는 Vercel `DASHBOARD_PASSWORD` (사용자가 알고 있음, 채팅에 받지 말 것).

## 다음 할 일 후보
1. API 키 등록 후 에이전트 결과 품질 확인, 프롬프트(`SYSTEM`)·데이터(`productBrief`/`liveBrief`) 다듬기
2. 제품 담당자별 이름 붙이기 + 담당자 필터 버튼 (담당자 목록은 사용자에게 받기)
3. (선택) Max 요금제 예약 작업 방식으로 전환
4. `ads.html`/`api/ads-report.js`는 아직 옛 탭 이름·전체 소재 탭 읽기라 느리거나 깨질 수 있음

## 지켜야 할 것
- 키·비밀번호를 코드나 채팅에 남기지 않는다 (Vercel 환경변수에만).
- `/api/daily-report`를 그냥 GET하면 슬랙에 글이 올라간다. 확인용으로는 항상 `format=json`.
- 사용자는 "보기 쉽게, 단순하게"를 중요하게 본다. 그래프를 더하기보다 탭마다 그래프 하나 + 펼치는 목록.
- 커밋 메시지·PR에 모델 이름을 쓰지 않는다.
