// Vercel Serverless Function — 배포 경로: /api/lives
// 틱톡샵 어필리에잇 라이브 보드의 데이터 API. 저장소는 Vercel Blob.
//   GET    /api/lives            → 전체 목록
//   POST   /api/lives            → 라이브 예정 등록
//   PATCH  /api/lives            → 종료 보고(종료시각 + 스크린샷)
// 환경변수:
//   BLOB_READ_WRITE_TOKEN   ← Vercel 대시보드에서 Blob 스토어 생성 시 자동 추가
//   DASHBOARD_PASSWORD      ← (선택) 설정 시 x-board-password 헤더 필요

const { put, list } = require("@vercel/blob");

const INDEX_KEY = "live-board/lives.json";
const MAX_SHOT_BYTES = 4 * 1024 * 1024; // 클라이언트에서 리사이즈 후 올리는 상한

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function readAll() {
  const { blobs } = await list({ prefix: INDEX_KEY, limit: 1 });
  if (!blobs.length) return [];
  const r = await fetch(blobs[0].url + "?_=" + Date.now(), { cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}

async function writeAll(rows) {
  await put(INDEX_KEY, JSON.stringify(rows), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

function clean(s, max) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max || 200);
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ""); }
function isTime(s) { return /^\d{2}:\d{2}$/.test(s || ""); }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const c of req) raw += c;
  try { return JSON.parse(raw || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  try {
    const PW = process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-board-password"] || (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(500).json({ error: "BLOB_READ_WRITE_TOKEN이 없습니다. Vercel에서 Blob 스토어를 만들어 주세요." });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    // ---- 목록 ----
    if (req.method === "GET") {
      const rows = await readAll();
      rows.sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? 1 : -1));
      res.status(200).json({ lives: rows, updated: new Date().toISOString() });
      return;
    }

    // ---- 예정 등록 ----
    if (req.method === "POST") {
      const b = await readBody(req);
      const rec = {
        id: uid(),
        creator: clean(b.creator, 60),
        handle: clean(b.handle, 60),
        date: clean(b.date, 10),
        startTime: clean(b.startTime, 5),
        product: clean(b.product, 120),
        note: clean(b.note, 500),
        endTime: "", actualStart: "", reportNote: "", shotUrl: "", reportedAt: "",
        createdAt: new Date().toISOString()
      };
      if (!rec.creator || !rec.handle || !rec.product) { res.status(400).json({ error: "이름·핸들·제품은 필수입니다." }); return; }
      if (!isDate(rec.date) || !isTime(rec.startTime)) { res.status(400).json({ error: "날짜 또는 시간 형식이 올바르지 않습니다." }); return; }
      const rows = await readAll();
      rows.push(rec);
      await writeAll(rows);
      res.status(200).json({ ok: true, live: rec });
      return;
    }

    // ---- 종료 보고 ----
    if (req.method === "PATCH") {
      const b = await readBody(req);
      const id = clean(b.id, 40);
      const rows = await readAll();
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) { res.status(404).json({ error: "해당 라이브를 찾을 수 없습니다." }); return; }
      if (!isTime(b.endTime)) { res.status(400).json({ error: "종료 시각 형식이 올바르지 않습니다." }); return; }

      let shotUrl = rows[i].shotUrl || "";
      if (b.shotData && typeof b.shotData === "string") {
        const m = b.shotData.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (!m) { res.status(400).json({ error: "스크린샷 형식이 올바르지 않습니다." }); return; }
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > MAX_SHOT_BYTES) { res.status(413).json({ error: "스크린샷 용량이 너무 큽니다." }); return; }
        const ext = m[1] === "image/png" ? "png" : "jpg";
        const blob = await put("live-board/shots/" + id + "-" + uid() + "." + ext, buf, {
          access: "public", contentType: m[1], addRandomSuffix: true
        });
        shotUrl = blob.url;
      }

      rows[i] = Object.assign({}, rows[i], {
        actualStart: isTime(b.actualStart) ? b.actualStart : rows[i].startTime,
        endTime: b.endTime,
        reportNote: clean(b.reportNote, 500),
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
