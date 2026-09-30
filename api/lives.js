// Vercel Serverless Function — 배포 경로: /api/lives
// 틱톡샵 어필리에잇 라이브 보드 API. 저장소는 Vercel Blob.
//   POST /api/lives  {action:"login"}        → 로그인 확인 (이름·핸들 반환)
//   GET  /api/lives                          → 전체 라이브 목록 + 내 정보
//   POST /api/lives  {action:"create", ...}  → 라이브 예정 등록
//   PATCH /api/lives {id, endTime, ...}      → 종료 보고
//
// 환경변수:
//   BLOB_READ_WRITE_TOKEN  ← Vercel에서 Blob 스토어 생성 시 자동 추가
//   LIVE_USERS             ← 크리에이터 계정 JSON 배열. 예:
//     [{"id":"bea","pw":"1234","name":"Bea Phan","handle":"@beaphan"},
//      {"id":"admin","pw":"5678","name":"운영팀","handle":"","admin":true}]
//     admin:true 계정은 모든 라이브를 보고·수정할 수 있습니다.

const { put, get } = require("@vercel/blob");

const INDEX_KEY = "live-board/lives.json";
const MAX_SHOT_BYTES = 4 * 1024 * 1024;

// Blob 토큰 찾기 — Vercel이 스토어 이름을 접두사로 붙이는 경우가 있어
// 이름이 BLOB_READ_WRITE_TOKEN 으로 끝나는 환경변수는 모두 허용한다.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(n => /BLOB_READ_WRITE_TOKEN$/i.test(n));
  return k ? process.env[k] : "";
}
// 새 Vercel Blob은 BLOB_STORE_ID + VERCEL_OIDC_TOKEN 으로 SDK가 자동 인증한다.
function blobReady() {
  return !!(blobToken() || process.env.BLOB_STORE_ID);
}
function blobOpts(extra) {
  const o = Object.assign({}, extra || {});
  const t = blobToken();
  if (t) o.token = t;          // 있으면 명시, 없으면 SDK가 OIDC로 해결
  return o;
}
function blobEnvNames() {
  return Object.keys(process.env).filter(n => /BLOB/i.test(n));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function accounts() {
  const raw = String(process.env.LIVE_USERS || "").trim();
  if (!raw) return [];
  // 스마트 따옴표 / 전각 문자 교정 (메모앱·모바일에서 복사하면 자주 바뀜)
  const norm = raw
    .replace(/[“”″＂]/g, '"')
    .replace(/[‘’′]/g, "'")
    .replace(/：/g, ":")
    .replace(/，/g, ",");

  // 1) JSON 배열 형식
  if (norm[0] === "[" || norm[0] === "{") {
    try {
      let a = JSON.parse(norm);
      if (!Array.isArray(a)) a = [a];
      return a;
    } catch (e) { return null; }
  }

  // 2) 줄 단위 간단 형식:  아이디:비번:이름:핸들[:admin]
  const rows = norm.split(/[\r\n]+/).map(s => s.trim()).filter(s => s && s[0] !== "#");
  const out = [];
  for (const line of rows) {
    const p = line.split(":").map(s => s.trim());
    if (!p[0] || !p[1]) continue;
    out.push({
      id: p[0], pw: p[1],
      name: p[2] || p[0],
      handle: p[3] || "",
      admin: /^admin$/i.test(p[4] || "")
    });
  }
  return out.length ? out : null;
}

function authenticate(req) {
  const list_ = accounts();
  if (list_ === null) {
    const n = String(process.env.LIVE_USERS || "").trim().length;
    return { error: "LIVE_USERS 값을 읽지 못했습니다(길이 " + n + "자). 한 줄에 한 명씩 '아이디:비번:이름:핸들' 형식으로 넣어 보세요." };
  }
  if (!list_.length) return { error: "LIVE_USERS 환경변수에 계정이 등록되어 있지 않습니다." };
  const id = String(req.headers["x-live-id"] || "").trim();
  const pw = String(req.headers["x-live-pw"] || "");
  if (!id || !pw) return { unauthorized: true };
  const hit = list_.find(u => String(u.id).trim() === id && String(u.pw) === pw);
  if (!hit) return { unauthorized: true };
  return { me: { id: String(hit.id).trim(), name: String(hit.name || hit.id), handle: String(hit.handle || ""), admin: !!hit.admin } };
}

async function readAll() {
  try {
    const r = await get(INDEX_KEY, blobOpts({ access: "private", useCache: false }));
    if (!r || r.statusCode !== 200 || !r.stream) return [];
    const txt = await new Response(r.stream).text();
    const j = JSON.parse(txt || "[]");
    return Array.isArray(j) ? j : [];
  } catch (e) {
    const n = String((e && (e.name + " " + e.message)) || "");
    if (/not.?found|404/i.test(n)) return [];   // 최초 실행: 아직 파일 없음
    throw e;
  }
}
async function writeAll(rows) {
  await put(INDEX_KEY, JSON.stringify(rows), blobOpts({
    access: "private", contentType: "application/json",
    addRandomSuffix: false, allowOverwrite: true
  }));
}
function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max || 200);
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isTime = s => /^\d{2}:\d{2}$/.test(s || "");

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const auth = authenticate(req);
    if (auth.error) { res.status(500).json({ error: auth.error }); return; }
    if (auth.unauthorized) { res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." }); return; }
    const me = auth.me;

    const body = (req.method === "POST" || req.method === "PATCH") ? await readBody(req) : {};

    // 로그인 확인만 (Blob 없이도 동작)
    if (req.method === "POST" && body.action === "login") {
      res.status(200).json({ ok: true, me });
      return;
    }

    if (!blobReady()) {
      const found = blobEnvNames();
      res.status(500).json({
        error: "Blob 토큰을 찾지 못했습니다. Vercel Storage에서 Blob 스토어를 이 프로젝트에 연결하고 재배포하세요."
             + (found.length ? " (발견된 BLOB 관련 변수: " + found.join(", ") + ")" : " (BLOB이 들어간 환경변수가 하나도 없습니다)")
      });
      return;
    }

    if (req.method === "GET") {
      const rows = await readAll();
      rows.sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? 1 : -1));
      res.status(200).json({ lives: rows, me, updated: new Date().toISOString() });
      return;
    }

    if (req.method === "POST") {
      const rec = {
        id: uid(),
        ownerId: me.id,
        creator: me.name,
        handle: me.handle,
        date: clean(body.date, 10),
        startTime: clean(body.startTime, 5),
        note: clean(body.note, 500),
        endTime: "", actualStart: "", reportNote: "", shotUrl: "", reportedAt: "",
        createdAt: new Date().toISOString()
      };
      if (!isDate(rec.date) || !isTime(rec.startTime)) {
        res.status(400).json({ error: "날짜 또는 시간 형식이 올바르지 않습니다." }); return;
      }
      const rows = await readAll();
      rows.push(rec);
      await writeAll(rows);
      res.status(200).json({ ok: true, live: rec });
      return;
    }

    if (req.method === "PATCH") {
      const id = clean(body.id, 40);
      const rows = await readAll();
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) { res.status(404).json({ error: "해당 라이브를 찾을 수 없습니다." }); return; }
      if (!me.admin && rows[i].ownerId !== me.id) {
        res.status(403).json({ error: "본인이 등록한 라이브만 보고할 수 있습니다." }); return;
      }
      if (!isTime(body.endTime)) { res.status(400).json({ error: "종료 시각 형식이 올바르지 않습니다." }); return; }

      let shotUrl = rows[i].shotUrl || "";
      if (body.shotData && typeof body.shotData === "string") {
        const m = body.shotData.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (!m) { res.status(400).json({ error: "스크린샷 형식이 올바르지 않습니다." }); return; }
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > MAX_SHOT_BYTES) { res.status(413).json({ error: "스크린샷 용량이 너무 큽니다." }); return; }
        const blob = await put("live-board/shots/" + id + ".jpg", buf, blobOpts({
          access: "public", contentType: m[1], addRandomSuffix: true
        }));
        shotUrl = blob.url;
      }

      rows[i] = Object.assign({}, rows[i], {
        actualStart: isTime(body.actualStart) ? body.actualStart : rows[i].startTime,
        endTime: body.endTime,
        reportNote: clean(body.reportNote, 500),
        shotUrl,
        reportedAt: new Date().toISOString()
      });
      await writeAll(rows);
      res.status(200).json({ ok: true, live: rows[i] });
      return;
    }

    res.status(405).json({ error: "지원하지 않는 요청입니다." });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
