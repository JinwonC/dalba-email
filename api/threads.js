// Vercel Serverless Function — 배포 경로: /api/threads
// Gmail 받은편지함을 읽어 협업 메일을 분류해 JSON으로 반환.
//  - 우리 차례(ours): 스레드 마지막 메시지를 크리에이터(외부)가 보냄 → 우리가 답할 차례
//  - 회신 대기(waiting): 마지막 메시지를 우리가 보냄 → 크리에이터 답장 대기
//  - 미열람(unread): 스레드에 안 읽은 메시지 있음
// 환경변수: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (선택) ANTHROPIC_API_KEY → 있으면 요약을 한국어로, 없으면 영어 스니펫.
// (선택) DASHBOARD_PASSWORD → 설정하면 비밀번호가 맞아야 데이터 반환(401 보호).

const { google } = require("googleapis");

const OUR_DOMAINS = ["@dalba.com"];
const OUR_EXACT = ["dalbatiktokshopofficial@gmail.com"];
const REPS = ["Nayeon", "Lizi", "Dohyeon", "Anna", "Jinwon"];
const MAX_THREADS = 50;

function header(payload, name) {
  const h = (payload.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}
function extractEmail(from) {
  const m = (from || "").match(/<([^>]+)>/);
  return (m ? m[1] : from || "").trim().toLowerCase();
}
function displayName(from) {
  let name = (from || "").replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  const email = extractEmail(from);
  if (!name || name.toLowerCase() === email) name = email.split("@")[0];
  return { name, email };
}
function isOurs(email) {
  email = (email || "").toLowerCase();
  return OUR_EXACT.includes(email) || OUR_DOMAINS.some(d => email.includes(d));
}
function repFromText(text) {
  if (!text) return "";
  for (const r of REPS) if (new RegExp("\\b" + r + "\\b", "i").test(text)) return r;
  if (/\bdohyun\b|\bdoheyon\b/i.test(text)) return "Dohyeon";
  return "";
}
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
function cleanBody(t) {
  if (!t) return "";
  t = t.replace(/\r/g, "");
  const markers = [/\nOn .+wrote:/, /\n_{5,}/, /\nFrom:\s/, /\n-{2,}\s*Forwarded/, /\n>/];
  let cut = t.length;
  markers.forEach(m => { const mm = t.match(m); if (mm && mm.index < cut) cut = mm.index; });
  t = t.slice(0, cut).split("\n").filter(l => l.trim()[0] !== ">").join(" ");
  return t.replace(/\s+/g, " ").trim();
}
function stripRe(s) {
  return (s || "").replace(/^((re|fwd?)\s*:\s*)+/i, "").trim() || "(제목 없음)";
}
async function summarizeKo(items) {
  if (!process.env.ANTHROPIC_API_KEY || !items.length) return {};
  const prompt =
    "다음은 틱톡 크리에이터가 K-뷰티 브랜드(달바)에 보낸 협업 이메일(message, 영어)이다.\n" +
    "각 항목을 한국어 1~2문장으로 요약하라. 반드시 한국어로만(금액·고유명사 예외). " +
    "단가·희망 보수, 수락/거절/역제안, 요구 조건, 다음 액션 포함.\n" +
    "출력은 JSON 배열만: [{\"i\":0,\"summary\":\"...\"}]\n\n" + JSON.stringify(items);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    const txt = (data.content && data.content[0] && data.content[0].text) || "";
    const m = txt.match(/\[[\s\S]*\]/);
    const out = {};
    if (m) JSON.parse(m[0]).forEach(a => { if (a.summary) out[a.i] = a.summary.trim(); });
    return out;
  } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  try {
    // --- 비밀번호 보호 (DASHBOARD_PASSWORD 설정 시에만 동작) ---
    const PW = process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-dashboard-password"] ||
                    (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    const list = await gmail.users.threads.list({ userId: "me", q: "in:inbox", maxResults: MAX_THREADS });
    const threads = list.data.threads || [];
    const rows = [];

    for (const t of threads) {
      const thr = await gmail.users.threads.get({ userId: "me", id: t.id, format: "full" });
      const msgs = (thr.data.messages || []).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      if (!msgs.length) continue;

      const last = msgs[msgs.length - 1];
      const lastFrom = header(last.payload, "From");
      const weSentLast = isOurs(extractEmail(lastFrom));
      const status = weSentLast ? "waiting" : "ours";   // ours = 우리 차례
      const unread = msgs.some(m => (m.labelIds || []).includes("UNREAD"));

      // 크리에이터 = 스레드에서 가장 최근의 외부 발신자
      let creatorFrom = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const e = extractEmail(header(msgs[i].payload, "From"));
        if (!isOurs(e)) { creatorFrom = header(msgs[i].payload, "From"); break; }
      }
      if (!creatorFrom) creatorFrom = lastFrom;
      const who = displayName(creatorFrom);

      let rep = "";
      for (const m of msgs) { rep = repFromText(decodeBody(m.payload)); if (rep) break; }
      if (!rep) rep = "(확인 필요)";

      const body = cleanBody(decodeBody(last.payload));

      rows.push({
        date: new Date(Number(last.internalDate)).toISOString().slice(5, 10),
        rep,
        creator: who.name,
        creatorEmail: who.email,
        subject: stripRe(header(last.payload, "Subject")),
        lastFromCreator: !weSentLast,
        status,
        unread,
        message: body.slice(0, 700),
        summary: body.slice(0, 200),
        link: "https://mail.google.com/mail/u/0/#inbox/" + t.id
      });
    }

    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const koMap = await summarizeKo(rows.map((r, i) => ({ i, creator: r.creator, subject: r.subject, message: r.message })));
    rows.forEach((r, i) => { if (koMap[i]) r.summary = koMap[i]; });

    const stats = {
      total: rows.length,
      ours: rows.filter(r => r.status === "ours").length,
      waiting: rows.filter(r => r.status === "waiting").length,
      unread: rows.filter(r => r.unread).length
    };

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ updated: new Date().toISOString(), stats, rows });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
