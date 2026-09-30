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
const crypto = require("crypto");
const { Readable } = require("stream");

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
function shotSecret() {
  return process.env.LIVE_SECRET || process.env.LIVE_USERS || process.env.BLOB_STORE_ID || "dalba-live";
}
function shotSig(pathname, exp) {
  return crypto.createHmac("sha256", shotSecret()).update(pathname + "|" + exp).digest("base64url");
}
function shotSrc(pathname) {
  const exp = Date.now() + 12 * 3600 * 1000;   // 12시간 유효
  return "/api/lives?shot=" + encodeURIComponent(pathname) + "&e=" + exp + "&t=" + shotSig(pathname, exp);
}
function shotOk(pathname, e, t) {
  const exp = Number(e || 0);
  if (!exp || Date.now() > exp) return false;
  const want = Buffer.from(shotSig(pathname, exp));
  const got = Buffer.from(String(t || ""));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
async function serveShot(req, res, pathname) {
  if (!shotOk(pathname, req.query && req.query.e, req.query && req.query.t)) {
    res.status(403).end("forbidden"); return;
  }
  const r = await get(pathname, blobOpts({ access: "private" }));
  if (!r || r.statusCode !== 200 || !r.stream) { res.status(404).end("not found"); return; }
  res.setHeader("Content-Type", r.contentType || "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=600");
  Readable.fromWeb(r.stream).pipe(res);
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
    return { error: "Couldn't read LIVE_USERS (" + n + " chars). Use one account per line: username:password:name:handle[:admin]" };
  }
  if (!list_.length) return { error: "No accounts are configured in LIVE_USERS." };
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
const TZS = ["America/New_York","America/Chicago","America/Denver","America/Phoenix",
  "America/Los_Angeles","America/Anchorage","Pacific/Honolulu","Asia/Seoul","UTC"];
const isTz = s => TZS.indexOf(s) >= 0;

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = ""; for await (const c of req) raw += c;
  try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 스크린샷은 서명 토큰으로 검증 (img 태그는 헤더를 못 보냄)
    if (req.method === "GET" && req.query && req.query.shot) {
      return await serveShot(req, res, String(req.query.shot));
    }

    const auth = authenticate(req);
    if (auth.error) { res.status(500).json({ error: auth.error }); return; }
    if (auth.unauthorized) { res.status(401).json({ error: "Wrong username or password." }); return; }
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
        error: "No Blob store credentials. Connect a Blob store to this project in Vercel Storage, then redeploy."
             + (found.length ? " (BLOB vars present: " + found.join(", ") + ")" : " (no BLOB env vars found)")
      });
      return;
    }

    if (req.method === "GET") {
      const rows = await readAll();
      rows.sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? 1 : -1));
      const out = rows.map(r => r.shotPath ? Object.assign({}, r, { shotSrc: shotSrc(r.shotPath) }) : r);
      res.status(200).json({ lives: out, me, updated: new Date().toISOString() });
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
        tz: isTz(body.tz) ? body.tz : "America/New_York",
        note: clean(body.note, 500),
        endTime: "", actualStart: "", reportNote: "", shotPath: "", reportedAt: "",
        createdAt: new Date().toISOString()
      };
      if (!isDate(rec.date) || !isTime(rec.startTime)) {
        res.status(400).json({ error: "Please check the date and start time." }); return;
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
      if (i < 0) { res.status(404).json({ error: "That live was not found." }); return; }
      if (!me.admin && rows[i].ownerId !== me.id) {
        res.status(403).json({ error: "You can only change your own lives." }); return;
      }

      // 일정 수정
      if (body.action === "edit") {
        if (!isDate(body.date) || !isTime(body.startTime)) {
          res.status(400).json({ error: "Please check the date and start time." }); return;
        }
        rows[i] = Object.assign({}, rows[i], {
          date: clean(body.date, 10),
          startTime: clean(body.startTime, 5),
          tz: isTz(body.tz) ? body.tz : (rows[i].tz || "America/New_York"),
          note: clean(body.note, 500),
          updatedAt: new Date().toISOString()
        });
        await writeAll(rows);
        res.status(200).json({ ok: true, live: rows[i] });
        return;
      }

      // 일정 취소(삭제)
      if (body.action === "cancel") {
        rows.splice(i, 1);
        await writeAll(rows);
        res.status(200).json({ ok: true, removed: true });
        return;
      }

      if (!isTime(body.endTime)) { res.status(400).json({ error: "Please check the end time." }); return; }

      let shotPath = rows[i].shotPath || "";
      if (body.shotData && typeof body.shotData === "string") {
        const m = body.shotData.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (!m) { res.status(400).json({ error: "That screenshot format is not supported." }); return; }
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > MAX_SHOT_BYTES) { res.status(413).json({ error: "That screenshot is too large." }); return; }
        const blob = await put("live-board/shots/" + id + ".jpg", buf, blobOpts({
          access: "private", contentType: m[1], addRandomSuffix: true
        }));
        shotPath = blob.pathname;
      }

      rows[i] = Object.assign({}, rows[i], {
        actualStart: isTime(body.actualStart) ? body.actualStart : rows[i].startTime,
        endTime: body.endTime,
        reportNote: clean(body.reportNote, 500),
        shotPath,
        reportedAt: new Date().toISOString()
      });
      await writeAll(rows);
      res.status(200).json({ ok: true, live: Object.assign({}, rows[i], rows[i].shotPath ? { shotSrc: shotSrc(rows[i].shotPath) } : {}) });
      return;
    }

    res.status(405).json({ error: "Unsupported request." });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
