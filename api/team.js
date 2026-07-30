// Vercel Serverless Function — 배포 경로: /api/team
// @dalbausa.com 아웃리치 팀 6명의 이메일 활동을 날짜 범위별로 집계해 JSON 반환.
//   직원별: 발송 수(아웃바운드) · 컨택 크리에이터 수 · 받은 답장 · 진행 단계 · 회신 필요
//   전역: 중복 컨택(같은 크리에이터를 2명 이상)
// 쿼리: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (없으면 최근 7일)
// 환경변수: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   ※ REFRESH_TOKEN 은 아웃리치 CC가 모이는 메일함(forgemini8938) 기준이어야 함.
// (선택) DASHBOARD_PASSWORD → 설정 시 x-dashboard-password 헤더 또는 ?pw= 필요.

const { google } = require("googleapis");

// 직원 발신주소 → 표시 이름
const TEAM = {
  "hannie@dalbausa.com": "Hannie",
  "quinn@dalbausa.com": "Quinn",
  "jane@dalbausa.com": "Jane",
  "delilah@dalbausa.com": "Delilah",
  "elwyn@dalbausa.com": "Elwyn",
  "juan@dalbausa.com": "Juan"
};
const TEAM_DOMAIN = "@dalbausa.com";
// 내부/노이즈 (크리에이터 아님)
const INTERNAL_RE = /@dalba\.com$|@dalbausa\.com$|forgemini8938@gmail\.com$/i;
const NOISE_RE = /no-?reply|no_reply|mailer-daemon|postmaster|notifications?@|@google\.com$|worksmobile|surfshark|kalodata/i;

const MAX_THREADS = 150;   // 안전 상한 (Vercel 60s)
const STAGE_BODY_CAP = 60; // 본문까지 열어 단계 판별할 최대 스레드 수(답장 있는 것 위주)

function header(payload, name) {
  const h = (payload.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}
function extractEmail(s) {
  const m = (s || "").match(/<([^>]+)>/);
  return (m ? m[1] : s || "").trim().toLowerCase();
}
function isTeam(email) { return TEAM_DOMAIN && (email || "").toLowerCase().endsWith(TEAM_DOMAIN); }
function isInternal(email) { return INTERNAL_RE.test(email || ""); }
function isNoise(email) { return NOISE_RE.test(email || ""); }
function teamName(email) { return TEAM[(email || "").toLowerCase()] || ((email || "").split("@")[0] || ""); }

function decodeBody(payload) {
  function walk(p) {
    if (!p) return "";
    if (p.mimeType === "text/plain" && p.body && p.body.data)
      return Buffer.from(p.body.data, "base64").toString("utf8");
    if (p.parts) { for (const c of p.parts) { const r = walk(c); if (r) return r; } }
    if (p.body && p.body.data) return Buffer.from(p.body.data, "base64").toString("utf8");
    return "";
  }
  return walk(payload);
}

// 진행 단계: contract > negotiating > replied > first
function stageFrom(hasReply, bodyText) {
  const t = (bodyText || "").toLowerCase();
  if (/\bcontract\b|\bagreement\b|\bsign(ed|ing)?\b|docu\s?sign|e-?sign|countersign|계약|서명/i.test(t)) return "contract";
  if (/\$\s?\d|\brate(s)?\b|\bpricing\b|\bprice\b|per (video|post)|\bbudget\b|\bquote\b|\bfee\b|보수|단가|견적|협의/i.test(t)) return "negotiating";
  if (hasReply) return "replied";
  return "first";
}
function ymd(d) { return d.toISOString().slice(0, 10); }

module.exports = async (req, res) => {
  try {
    const PW = process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    // --- 날짜 범위 ---
    const now = new Date();
    let to = (req.query && req.query.to) ? new Date(req.query.to + "T23:59:59Z") : now;
    let from = (req.query && req.query.from)
      ? new Date(req.query.from + "T00:00:00Z")
      : new Date(now.getTime() - 7 * 864e5);
    if (isNaN(from)) from = new Date(now.getTime() - 7 * 864e5);
    if (isNaN(to)) to = now;
    const beforeExcl = new Date(to.getTime() + 864e5); // Gmail before: 는 미포함 → +1일

    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    const q = `(from:dalbausa.com OR to:dalbausa.com) after:${from.toISOString().slice(0,10).replace(/-/g,"/")} before:${beforeExcl.toISOString().slice(0,10).replace(/-/g,"/")}`;

    // 스레드 id 수집 (페이지네이션, 상한)
    const ids = [];
    let pageToken;
    do {
      const list = await gmail.users.threads.list({ userId: "me", q, maxResults: 100, pageToken });
      (list.data.threads || []).forEach(t => ids.push(t.id));
      pageToken = list.data.nextPageToken;
    } while (pageToken && ids.length < MAX_THREADS);
    const capped = ids.length >= MAX_THREADS;
    ids.length = Math.min(ids.length, MAX_THREADS);

    // 직원별 집계 초기화
    const emp = {};
    Object.values(TEAM).forEach(n => emp[n] = {
      name: n, outbound: 0, creators: new Set(), replies: 0,
      stages: { first: 0, replied: 0, negotiating: 0, contract: 0 },
      needsReply: []
    });
    const creatorToEmployees = {}; // 중복 감지: creatorEmail -> Set(name)
    let totalOutbound = 0, totalReplies = 0;

    for (const id of ids) {
      // 1차: 메타데이터만 (빠름)
      const thr = await gmail.users.threads.get({
        userId: "me", id, format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date"]
      });
      const msgs = (thr.data.messages || []).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      if (!msgs.length) continue;

      // 이 스레드의 담당 직원 + 크리에이터 파악
      let repName = "", creatorEmail = "", hasReply = false, outboundInThread = 0;
      for (const m of msgs) {
        const fromE = extractEmail(header(m.payload, "From"));
        const toE = extractEmail(header(m.payload, "To"));
        const inWindow = Number(m.internalDate) >= from.getTime() && Number(m.internalDate) <= to.getTime();

        if (isTeam(fromE)) {
          // 직원이 보냄 → 아웃바운드 (수신자가 외부 크리에이터일 때만)
          if (!isInternal(toE) && !isNoise(toE) && toE) {
            repName = repName || teamName(fromE);
            creatorEmail = creatorEmail || toE;
            if (inWindow) { outboundInThread++; }
          }
        } else if (isTeam(toE) && !isInternal(fromE) && !isNoise(fromE) && fromE) {
          // 크리에이터가 직원에게 답장
          hasReply = true;
          repName = repName || teamName(toE);
          creatorEmail = creatorEmail || fromE;
        }
      }
      if (!repName || !creatorEmail) continue; // 순수 내부/노이즈 스레드 제외

      const e = emp[repName] || (emp[repName] = {
        name: repName, outbound: 0, creators: new Set(), replies: 0,
        stages: { first: 0, replied: 0, negotiating: 0, contract: 0 }, needsReply: []
      });
      e.outbound += outboundInThread;
      totalOutbound += outboundInThread;
      e.creators.add(creatorEmail);
      (creatorToEmployees[creatorEmail] = creatorToEmployees[creatorEmail] || new Set()).add(repName);
      if (hasReply) { e.replies++; totalReplies++; }

      // 회신 필요: 마지막 메시지가 크리에이터(외부) → 직원이 아직 답 안 함
      const last = msgs[msgs.length - 1];
      const lastFrom = extractEmail(header(last.payload, "From"));
      if (!isTeam(lastFrom) && !isInternal(lastFrom) && !isNoise(lastFrom)) {
        const ageH = Math.round((now.getTime() - Number(last.internalDate)) / 36e5);
        e.needsReply.push({
          creatorEmail,
          subject: (header(last.payload, "Subject") || "").replace(/^((re|fwd?)\s*:\s*)+/i, "").slice(0, 80),
          ageHours: ageH,
          link: "https://mail.google.com/mail/u/0/#inbox/" + id
        });
      }

      // 단계 판별: 답장 있는 스레드는 본문까지 열어 정밀 판별(상한 내)
      let stage = stageFrom(hasReply, "");
      if (hasReply && STAGE_BODY_CAP > 0) {
        try {
          const full = await gmail.users.threads.get({ userId: "me", id, format: "full" });
          const text = (full.data.messages || []).map(m => decodeBody(m.payload)).join("\n");
          stage = stageFrom(true, text);
        } catch (_) {}
      }
      e.stages[stage] = (e.stages[stage] || 0) + 1;
    }

    // 직원 배열 정리
    const employees = Object.values(emp).map(e => ({
      name: e.name,
      outbound: e.outbound,
      creators: e.creators.size,
      replies: e.replies,
      needsReplyCount: e.needsReply.length,
      needsReply: e.needsReply.sort((a, b) => b.ageHours - a.ageHours).slice(0, 20),
      stages: e.stages
    })).sort((a, b) => b.outbound - a.outbound);

    // 중복 컨택
    const duplicates = Object.entries(creatorToEmployees)
      .filter(([, set]) => set.size >= 2)
      .map(([creatorEmail, set]) => ({ creatorEmail, employees: [...set] }));

    const totalNeedsReply = employees.reduce((s, e) => s + e.needsReplyCount, 0);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      updated: new Date().toISOString(),
      range: { from: ymd(from), to: ymd(to) },
      capped,
      totals: {
        outbound: totalOutbound,
        replies: totalReplies,
        needsReply: totalNeedsReply,
        duplicates: duplicates.length,
        activeEmployees: employees.filter(e => e.outbound > 0).length,
        teamSize: Object.keys(TEAM).length
      },
      employees,
      duplicates
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
