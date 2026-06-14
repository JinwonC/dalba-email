// 일회성: Gmail 읽기용 refresh token 발급 (로컬에서 1번만 실행)
// 사용법:
//   1) npm i googleapis
//   2) GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 환경변수 설정
//      (Google Cloud Console에서 OAuth 클라이언트 'Desktop app' 생성)
//   3) node get-refresh-token.js  → 출력된 URL 접속해 dalbatiktokshopofficial@gmail.com 로 로그인/동의
//      → 받은 코드를 터미널에 붙여넣기 → refresh_token 출력됨
//   4) 출력된 refresh_token 을 Vercel 환경변수 GOOGLE_REFRESH_TOKEN 에 저장

const { google } = require('googleapis');
const readline = require('readline');

const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.readonly']
});
console.log('\n이 URL을 브라우저에서 열어 동의하세요:\n', url, '\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('받은 코드 붙여넣기: ', async (code) => {
  const { tokens } = await oauth2.getToken(code.trim());
  console.log('\nGOOGLE_REFRESH_TOKEN =\n', tokens.refresh_token, '\n');
  rl.close();
});
