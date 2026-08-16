// Vercel Serverless Function — 배포 경로: /api/outreach-send
//
// 크리에이터 아웃리치 메일을 **네이버웍스 SMTP** 로 실제 발송한다.
// 템플릿은 루트의 email-template.js 한 곳에서만 만든다(미리보기 = 실제 발송본 보장).
//
//   GET  /api/outreach-send        → 설정 상태 조회 (SMTP 호스트·허용 도메인·배치 상한)
//   POST /api/outreach-send        → 단건/대량 발송
//
// ─── 담당자 10명 이상을 어떻게 다루나 ─────────────────────────────
// 담당자마다 환경변수를 두면 사람이 늘 때마다 Vercel 설정 + 재배포가 필요해 관리가 안 된다.
// 그래서 **각 담당자가 자기 네이버웍스 계정/앱 비밀번호를 브라우저에 한 번 입력**하고,
// 그 자격증명을 요청마다 함께 보내 자기 주소로 발송하는 방식(BYO credential)을 기본으로 한다.
//   · 신규 담당자 온보딩 = 앱 비밀번호 발급 후 입력. 코드 변경·재배포 없음.
//   · 각자 자기 주소로 나가고 답장도 자기에게 온다.
//   · 자격증명은 서버에 저장하지 않는다 (요청 처리 중에만 메모리에 존재).
//
// ─── 오픈 릴레이 방지 ─────────────────────────────────────────────
// 클라이언트가 임의의 SMTP 서버·주소로 보내지 못하도록 두 겹을 잠근다.
//   1) SMTP 호스트/포트는 **서버에서 고정** — 요청으로 바꿀 수 없다.
//   2) 발신 주소는 ALLOWED_DOMAINS 에 속한 회사 도메인만 허용.
//
// ─── 네이버웍스 준비 (담당자 1인당 1회) ──────────────────────────
//   1) 관리자센터에서 POP3/IMAP/SMTP 사용 **허용** (조직 관리자가 1회)
//   2) [설정 > 보안 > 외부 앱 비밀번호] 에서 앱 비밀번호 발급
//      ※ 로그인 비밀번호로는 SMTP 인증이 안 된다.
//
// ─── 환경변수 (전부 선택 — 없어도 동작) ──────────────────────────
//   NW_DOMAIN          발신 허용 도메인. 콤마로 여러 개. 기본 "dalbausa.com,dalba.com"
//   NW_SMTP_HOST       기본 smtp.worksmobile.com
//   NW_SMTP_PORT       기본 465 (SSL). 587 이면 STARTTLS 로 자동 전환
//   NW_BCC             발송 사본을 받을 주소 — 팀 공용 발송 이력 보관용
//   DASHBOARD_PASSWORD 설정 시 x-dashboard-password 헤더 또는 ?pw= 필요 (**강력 권장**)
//   NW_ACCOUNTS        (선택) 공용 계정을 서버에 심어두고 싶을 때만.
//                      JSON 배열: [{"name":"Hannie","email":"...","password":"...","title":"..."}]

const nodemailer = require("nodemailer");
const T = require("../email-template.js");

// 서버 고정값 — 클라이언트가 바꿀 수 없다
const SMTP_HOST = process.env.NW_SMTP_HOST || "smtp.worksmobile.com";
const SMTP_PORT = Number(process.env.NW_SMTP_PORT || 465);

const ALLOWED_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

const MAX_PER_REQUEST = 25;   // Vercel 60s 안에서 안전한 배치 크기 (프론트가 청크로 쪼개 호출)
const SEND_GAP_MS = 400;      // 연속 발송 간격 — 스팸 판정·유량 제한 회피

const sleep = ms => new Promise(r => setTimeout(r, ms));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainOf(email) { return String(email || "").toLowerCase().split("@")[1] || ""; }
function domainAllowed(email) { return ALLOWED_DOMAINS.includes(domainOf(email)); }

// 헤더 인젝션 방지: 표시 이름/주소에 개행이 섞이면 제거
function cleanHeader(s) { return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim(); }

// 서버에 심어둔 공용 계정 (선택 기능 — 없으면 빈 객체)
function envAccounts() {
  const out = {};
  if (!process.env.NW_ACCOUNTS) return out;
  try {
    JSON.parse(process.env.NW_ACCOUNTS).forEach(a => {
      if (!a || !a.email || !a.password) return;
      const name = a.name || String(a.email).split("@")[0];
      out[String(a.email).toLowerCase()] = {
        name, email: String(a.email).toLowerCase(), password: a.password, title: a.title || ""
      };
    });
  } catch (_) { /* JSON 오류는 무시 — BYO 방식으로 계속 동작 */ }
  return out;
}

// 이번 요청에 쓸 발신 계정 확정
//   우선순위: 요청이 보낸 자격증명 → 서버 공용 계정
function resolveAccount(body) {
  const a = body.auth || {};
  const email = String(a.email || "").trim().toLowerCase();
  const shared = envAccounts();

  if (email && a.password) {
    if (!EMAIL_RE.test(email)) return { error: "발신 이메일 형식이 올바르지 않습니다: " + email };
    if (!domainAllowed(email)) {
      return { error: `발신 주소는 ${ALLOWED_DOMAINS.map(d => "@" + d).join(" 또는 ")} 만 허용됩니다 (요청: ${email})` };
    }
    return {
      account: {
        name: cleanHeader(a.name) || email.split("@")[0],
        email,
        password: String(a.password),
        title: cleanHeader(a.title || "")
      }
    };
  }

  if (email && shared[email]) return { account: shared[email] };
  const list = Object.values(shared);
  if (!email && list.length === 1) return { account: list[0] };

  return {
    error: "발신 계정이 없습니다. 화면 오른쪽 위 [내 발신 계정] 에서 네이버웍스 주소와 " +
           "외부 앱 비밀번호를 등록하세요."
  };
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

module.exports = async (req, res) => {
  try {
    // ─── 접근 보호 ───────────────────────────────────────────────
    // 이 엔드포인트는 **실제로 메일을 보낸다**. 반드시 비밀번호를 걸어 두는 걸 권장.
    const PW = process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    // ─── GET: 설정 상태 (비밀번호류는 절대 반환하지 않는다) ───────
    if (req.method === "GET") {
      const shared = Object.values(envAccounts()).map(a => ({ name: a.name, email: a.email, title: a.title }));
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465 },
        allowedDomains: ALLOWED_DOMAINS,
        maxPerRequest: MAX_PER_REQUEST,
        protected: Boolean(PW),
        bcc: Boolean(process.env.NW_BCC),
        sharedAccounts: shared
      });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const body = readBody(req);
    const campaign = body.campaign || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const dryRun = Boolean(body.dryRun);

    if (!recipients.length) { res.status(400).json({ error: "recipients 가 비어 있습니다" }); return; }
    if (recipients.length > MAX_PER_REQUEST) {
      res.status(400).json({ error: `한 요청당 최대 ${MAX_PER_REQUEST}명까지 (요청: ${recipients.length}명)` });
      return;
    }

    // ─── 발신 계정 확정 ──────────────────────────────────────────
    const resolved = resolveAccount(body);
    if (resolved.error && !dryRun) { res.status(400).json({ error: resolved.error }); return; }
    const account = resolved.account || null;

    // 수신자별 데이터: 캠페인 공통값 + 수신자 개별값(개별값 우선)
    // 서명/발신자는 **인증 계정으로 강제** — 네이버웍스는 인증 계정 외 From 을 허용하지 않는다.
    const compose = r => Object.assign({}, campaign, r, {
      senderName: account ? account.name : (campaign.senderName || ""),
      senderEmail: account ? account.email : (campaign.senderEmail || ""),
      senderTitle: (account && account.title) || campaign.senderTitle || ""
    });

    // ─── dryRun: 발송 없이 렌더 결과만 확인 ──────────────────────
    if (dryRun) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        dryRun: true,
        sender: account ? { name: account.name, email: account.email } : null,
        warning: resolved.error || undefined,
        results: recipients.map(r => {
          const d = compose(r);
          const errs = T.validate(d);
          const built = T.build(d);
          return { to: d.to, ok: !errs.length, errors: errs, subject: built.subject, html: built.html };
        })
      });
      return;
    }

    // ─── SMTP 연결 ───────────────────────────────────────────────
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,          // 465=SSL 즉시 암호화 / 587=STARTTLS
      requireTLS: SMTP_PORT !== 465,
      auth: { user: account.email, pass: account.password },
      pool: true,
      maxConnections: 1,                  // 순차 발송 — 유량 제한 회피
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 25000
    });

    try {
      await transporter.verify();
    } catch (e) {
      transporter.close();
      res.status(502).json({
        error: "네이버웍스 SMTP 인증/연결 실패: " + String((e && e.message) || e),
        hint: "① 관리자센터에서 IMAP/POP3·SMTP 사용이 허용됐는지 " +
              "② 로그인 비밀번호가 아니라 '설정 > 보안 > 외부 앱 비밀번호'에서 발급한 값을 넣었는지 " +
              "③ 계정이 " + account.email + " 가 맞는지 확인하세요."
      });
      return;
    }

    // ─── 순차 발송 ───────────────────────────────────────────────
    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const d = compose(recipients[i]);
      const to = cleanHeader(d.to);

      const errs = T.validate(d);
      if (errs.length) {
        results.push({ to, ok: false, error: errs.join(" / ") });
        continue;
      }

      try {
        const built = T.build(d);
        const toName = cleanHeader(d.creatorName || "");
        const info = await transporter.sendMail({
          from: { name: cleanHeader(account.name), address: account.email },  // 인증 계정 고정
          to: toName ? { name: toName, address: to } : to,
          replyTo: account.email,
          bcc: process.env.NW_BCC || undefined,   // 발송 이력 보관용 사본
          subject: cleanHeader(built.subject),
          text: built.text,
          html: built.html
        });
        results.push({ to, ok: true, messageId: info.messageId, subject: built.subject });
      } catch (e) {
        results.push({ to, ok: false, error: String((e && e.message) || e) });
      }

      if (i < recipients.length - 1) await sleep(SEND_GAP_MS);
    }

    transporter.close();

    const sent = results.filter(r => r.ok).length;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      sentAt: new Date().toISOString(),
      sender: { name: account.name, email: account.email },
      totals: { requested: recipients.length, sent, failed: recipients.length - sent },
      results
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
