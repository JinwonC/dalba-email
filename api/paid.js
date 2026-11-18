// Vercel Serverless Function — 배포 경로: /api/paid
// 유가 협업 관리(why.html '유가 협업' 탭) 데이터 API.
//  · 협업 시트 '유/무가 성과 트래킹 (GMV)' 탭: 영상별 핸들·회차·비용·PAID 여부·담당자·제품·포스팅일·영상 URL·콘셉트
//  · 협업 시트 '유가 캐스팅 (casting)' 탭: 크리에이터별 계약(유형·회차·진행 현황·계약 영상 수·네고 후 금액·개당 단가)
//  · 매출 시트 '주문별 AF 매출 RAW' 탭: 영상 ID별 결제액 → 영상별 누적 매출·최근 7일 매출
//
// 사용: GET /api/paid            (10분 캐시, ?fresh=1 이면 다시 읽음)
// 환경변수: GOOGLE_SERVICE_ACCOUNT, (선택) PAID_SHEET_ID, US_MAIN_SHEET_ID
// 서비스 계정이 협업 시트를 볼 수 있어야 한다(시트 공유 → 보기 권한).

const PAID_DEFAULT = "1JFq6m2-rvSpiGKQsTpr91Hj-RckHpqFfEl_BLkQI_hs";
const MAIN_DEFAULT = "15dP91bH_skc7ZzcJ3ehH9H4IKCzSxcfuOcREr3OaL0o";
const DAY = 86400000;
const MEM = globalThis.__paidCache || (globalThis.__paidCache = {});

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,%$\s]/g, "");
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
// "2026-10-01", "2026. 8. 31", "26. 5. 15" → "YYYY-MM-DD"
function dkey(v) {
  const m = String(v || "").match(/(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const y = +m[1] < 100 ? 2000 + +m[1] : +m[1], mo = +m[2], d = +m[3];
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const addDays = (k, n) => new Date(Date.parse(k + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
const r2 = x => Math.round(x * 100) / 100;
const handleOf = v => String(v || "").trim().replace(/^@/, "").toLowerCase();
// 영상 ID는 URL에서 읽는다 (시트의 자동수식 열은 큰 숫자가 깨진 행이 있다)
const vidOf = (url, fallback) => { const m = String(url || "").match(/video\/(\d{15,20})/); if (m) return m[1]; const f = String(fallback || "").trim(); return /^\d{15,20}$/.test(f) ? f : ""; };

// 주문 행(날짜 열, 결제액 열, [크리에이터, 유형, 콘텐츠 ID] 열) → 영상 ID별 매출
function salesByVideo(dates, pays, meta) {
  const S = {}; let end = null;
  for (let i = 1; i < meta.length; i++) { const k = dkey((dates[i] || [])[0]); if (k && (!end || k > end)) end = k; }
  const d7 = end ? addDays(end, -6) : null;
  for (let i = 1; i < meta.length; i++) {
    const r = meta[i] || [], cid = String(r[2] || "").trim(); if (!cid || !/video/i.test(String(r[1] || ""))) continue;
    const k = dkey((dates[i] || [])[0]); if (!k) continue;
    const pay = num((pays[i] || [])[0]);
    const e = S[cid] || (S[cid] = { g: 0, n: 0, g7: 0, first: k, last: k });
    e.g += pay; e.n++; if (d7 && k >= d7) e.g7 += pay; if (k < e.first) e.first = k; if (k > e.last) e.last = k;
  }
  return { S, end };
}
// '유/무가 성과 트래킹 (GMV)' 행 → 영상 목록
// 유가 = PAID로 적혔거나 비용이 있는 영상. NON_PAID인데 비용이 적힌 행이 있고, 시트의 '월별 사용 예산'도 그 비용을 포함한다.
function buildVideos(rows, S) {
  const out = [];
  for (const r of (rows || []).slice(1)) {
    const h = handleOf(r[0]); if (!h) continue;
    const posted = dkey(r[6]), cid = vidOf(r[7], r[8]); if (!posted && !cid) continue;
    const t = norm(r[3]).toUpperCase(), s = S[cid];
    out.push({ h, round: String(r[1] || "").trim(), cost: r2(num(r[2])), paid: t === "PAID" || num(r[2]) > 0 ? 1 : 0, mgr: String(r[4] || "").trim(), product: String(r[5] || "").trim() || "(제품 미기입)",
      posted, cid, concept: String(r[10] || "").trim().slice(0, 60), gmv: s ? r2(s.g) : 0, orders: s ? s.n : 0, gmv7: s ? r2(s.g7) : 0, lastSale: s ? s.last : null });
  }
  return out;
}
// '유가 캐스팅 (casting)' 행 → 계약 목록 (머리글 이름으로 열을 찾는다)
function buildCasting(rows) {
  const H = (rows && rows[0]) || [], idx = n => H.findIndex(x => norm(x).includes(norm(n)));
  const c = { type: idx("협업유형"), date: idx("협업진행일자"), month: H.findIndex(x => norm(x) === "월"), mgr: idx("담당자"), h: idx("CREATORHANDLE"), round: idx("회차"), status: idx("진행현황"), n: idx("계약영상수"), rate: idx("네고후rate"), unit: idx("개당단가") };
  if (c.h < 0) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const h = handleOf(r[c.h]); if (!h) continue;
    const g = i => (i >= 0 ? String(r[i] || "").trim() : "");
    const products = []; for (let i = 0; i + 1 < Math.min(8, c.type > 0 ? c.type : 8); i += 2) { const nm = String(r[i] || "").trim(), n = num(r[i + 1]); if (nm || n) products.push({ name: nm, n }); }
    out.push({ h, type: g(c.type), date: dkey(g(c.date)), month: g(c.month), mgr: g(c.mgr), round: g(c.round), status: g(c.status), n: num(g(c.n)), rate: r2(num(g(c.rate))), unit: r2(num(g(c.unit))), products });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (q.fresh !== "1" && MEM.val && Date.now() - MEM.ts < 600000) { send(res, MEM.val); return; }
    const { google } = require("googleapis");
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT 환경변수가 필요합니다.");
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const PAID = process.env.PAID_SHEET_ID || PAID_DEFAULT, MAIN = process.env.US_MAIN_SHEET_ID || MAIN_DEFAULT;
    let pm;
    try { pm = await sheets.spreadsheets.get({ spreadsheetId: PAID, fields: "sheets.properties(title)" }); }
    catch (e) { const code = e && (e.code || (e.response && e.response.status)); if (code === 403 || code === 404) { res.status(200).json({ error: "협업 시트를 읽을 권한이 없습니다. 시트를 서비스 계정(다른 시트에 공유해 둔 것과 같은 계정)에 '뷰어'로 공유해 주세요.", needShare: true }); return; } throw e; }
    const mm = await sheets.spreadsheets.get({ spreadsheetId: MAIN, fields: "sheets.properties(title)" });
    const find = (meta, test) => (meta.data.sheets || []).map(s => s.properties.title).find(t => test(t.replace(/\s/g, "")));
    const T = { track: find(pm, t => t.includes("성과트래킹")), cast: find(pm, t => t.includes("유가캐스팅")), ord: find(mm, t => t.includes("주문별AF매출RAW")) };
    if (!T.track) throw new Error("'유/무가 성과 트래킹 (GMV)' 탭을 찾지 못했습니다.");
    if (!T.ord) throw new Error("'주문별 AF 매출 RAW' 탭을 찾지 못했습니다.");
    const q1 = (t, r) => `'${t}'!${r}`;
    const [pv, mv] = await Promise.all([
      sheets.spreadsheets.values.batchGet({ spreadsheetId: PAID, ranges: [q1(T.track, "A1:K"), T.cast ? q1(T.cast, "A1:W") : q1(T.track, "A1:A1")] }),
      sheets.spreadsheets.values.batchGet({ spreadsheetId: MAIN, ranges: [q1(T.ord, "A1:A"), q1(T.ord, "G1:G"), q1(T.ord, "M1:O")] })
    ]);
    const v = (b, i) => (b.data.valueRanges[i] && b.data.valueRanges[i].values) || [];
    const { S, end } = salesByVideo(v(mv, 0), v(mv, 1), v(mv, 2));
    const out = { dataEnd: end, videos: buildVideos(v(pv, 0), S), casting: T.cast ? buildCasting(v(pv, 1)) : [], source: { paid: PAID, main: MAIN, tabs: T } };
    MEM.val = out; MEM.ts = Date.now();
    send(res, out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
module.exports.salesByVideo = salesByVideo;
module.exports.buildVideos = buildVideos;
module.exports.buildCasting = buildCasting;
function send(res, out) {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(out);
}
