// Vercel Serverless Function — 배포 경로: /api/why
// 매출 원인 지도(why.html) 데이터 API.
// 원본 '2026 US 틱톡샵 매출/지표' 시트와 '틱톡샵 광고 대시보드(RAW)' 시트를 직접 읽어
// 기준 기간(A)과 비교 기간(B)의 채널·제품·광고 소재·브랜드 라이브·AF 라이브 데이터를 집계해 JSON으로 반환한다.
//
// 사용:
//   GET /api/why?a=2026-11-09                       → 11/09 vs 전날
//   GET /api/why?a=2026-11-01&a2=2026-11-10         → 11/01~10 vs 직전 같은 길이(10/22~31)
//   GET /api/why?a=...&a2=...&b=...&b2=...          → 비교 기간 직접 지정
//
// 환경변수: GOOGLE_SERVICE_ACCOUNT, ADS_SHEET_ID, (선택) US_MAIN_SHEET_ID
// 응답은 기간별 합계·집계값만 담는다(주문 단위 원자료는 반환하지 않음).

const MAIN_DEFAULT = "15dP91bH_skc7ZzcJ3ehH9H4IKCzSxcfuOcREr3OaL0o";
const DAY = 86400000;
const MEM = globalThis.__whyCache || (globalThis.__whyCache = {});

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,%$\s]/g, "");
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function dkey(v) {
  const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
}
const toTs = k => Date.parse(k + "T00:00:00Z");
const fromTs = t => new Date(t).toISOString().slice(0, 10);
const addDays = (k, n) => fromTs(toTs(k) + n * DAY);
const mins = s => { const m = String(s || "").match(/(?:(\d+)h)?\s*(?:(\d+)m)?/); return m ? (+m[1] || 0) * 60 + (+m[2] || 0) : 0; };
const norm = s => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");
const r2 = x => Math.round(x * 100) / 100;
// 틱톡 영상 ID 상위 32비트 = 생성 시각(초) → 미국 서부 날짜
const postDate = cid => { try { return fromTs(Number(BigInt(cid) >> 32n) * 1000 - 8 * 3600000); } catch (e) { return null; } };

function colIndex(header, name, nth) {
  let seen = 0;
  for (let i = 0; i < header.length; i++) if (norm(header[i]) === norm(name)) { if (seen === (nth || 0)) return i; seen++; }
  return -1;
}
// 날짜 열 값으로 기간 안 행 번호(1-based) 범위 찾기
function rowSpan(colVals, offset, from, to, pick) {
  let lo = -1, hi = -1;
  colVals.forEach((r, i) => {
    const k = dkey(pick ? pick(r) : r[0]);
    if (k && k >= from && k <= to) { const row = offset + i; if (lo < 0 || row < lo) lo = row; if (row > hi) hi = row; }
  });
  return lo < 0 ? null : [lo, hi];
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const a = dkey(q.a); if (!a) { res.status(400).json({ error: "a=YYYY-MM-DD 가 필요합니다." }); return; }
    const a2 = dkey(q.a2) || a;
    const len = Math.round((toTs(a2) - toTs(a)) / DAY) + 1;
    const b = dkey(q.b) || addDays(a, -len);
    const b2 = dkey(q.b2) || (dkey(q.b) ? b : addDays(a, -1));
    const lo = b < a ? b : a, hi = b2 > a2 ? b2 : a2;
    const per = k => (k >= a && k <= a2 ? "a" : (k >= b && k <= b2 ? "b" : null));
    // 그래프용 추이 창: 스토어·광고 30일, 소재·크리에이터 14일 (기준 기간 끝 기준)
    const t30 = addDays(a2, -29), t14 = addDays(a2, -13);
    const lo30 = t30 < lo ? t30 : lo, lo14 = t14 < lo ? t14 : lo;
    const tDates = []; for (let k = t30; k <= a2; k = addDays(k, 1)) tDates.push(k);
    const sDates = tDates.slice(-14);
    const days = { a: len, b: Math.round((toTs(b2) - toTs(b)) / DAY) + 1 };

    const ck = [a, a2, b, b2].join("|");
    if (q.fresh !== "1" && MEM[ck] && Date.now() - MEM[ck].ts < 600000) { send(res, MEM[ck].val); return; }

    const { google } = require("googleapis");
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) throw new Error("GOOGLE_SERVICE_ACCOUNT 환경변수가 필요합니다.");
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const sheets = google.sheets({ version: "v4", auth });
    const MAIN = process.env.US_MAIN_SHEET_ID || MAIN_DEFAULT, ADS = process.env.ADS_SHEET_ID;
    if (!ADS) throw new Error("ADS_SHEET_ID 환경변수가 필요합니다.");

    // 1) 탭 목록·행 수
    const [mm, am] = await Promise.all([
      sheets.spreadsheets.get({ spreadsheetId: MAIN, fields: "sheets.properties(title,gridProperties.rowCount)" }),
      sheets.spreadsheets.get({ spreadsheetId: ADS, fields: "sheets.properties(title,gridProperties.rowCount)" })
    ]);
    const tabs = (meta, test) => (meta.data.sheets || []).map(s => s.properties).find(p => test(p.title.replace(/\s/g, "")));
    const T = {
      prod: tabs(mm, t => t.includes("제품별유입매출RAW")),
      blive: tabs(mm, t => t.includes("브랜드라이브RAW")),
      alive: tabs(mm, t => t.includes("AFLIVERAW")),
      ord: tabs(mm, t => t.includes("주문별AF매출RAW")),
      cre: tabs(am, t => t === "소재별광고성과" || t === "광고소재성과"),
      camp: tabs(am, t => t === "캠페인광고성과"),
      pid: tabs(am, t => t === "PID매칭"),
      troi: tabs(am, t => t.includes("TROI") || (t.includes("타겟") && t.includes("ROI")))
    };
    for (const k of ["prod", "blive", "ord", "cre", "camp"]) if (!T[k]) throw new Error(`필요한 탭을 찾지 못했습니다: ${k}`);
    const q1 = (p, r) => `'${p.title}'!${r}`;

    // 2) 날짜 열만 먼저 읽어 기간 행 범위를 찾음 (큰 탭은 최근 행만)
    const creTail = Math.max(2, ((T.cre.gridProperties || {}).rowCount || 150000) - 150000);
    const [mainCols, adsCols] = await Promise.all([
      sheets.spreadsheets.values.batchGet({ spreadsheetId: MAIN, ranges: [
        q1(T.prod, "A1:A"), q1(T.blive, "A1:BH"), T.alive ? q1(T.alive, "E1:E") : q1(T.prod, "A1:A1"), q1(T.ord, "A1:A"), q1(T.ord, "M1:O")] }),
      sheets.spreadsheets.values.batchGet({ spreadsheetId: ADS, ranges: [
        q1(T.cre, `A${creTail}:A`), q1(T.camp, "A1:G"), T.pid ? q1(T.pid, "A1:C") : q1(T.camp, "A1:A1"), T.troi ? q1(T.troi, "A1:E") : q1(T.camp, "A1:A1"), q1(T.cre, "A1:W1")] })
    ]);
    const mv = i => (mainCols.data.valueRanges[i] && mainCols.data.valueRanges[i].values) || [];
    const av = i => (adsCols.data.valueRanges[i] && adsCols.data.valueRanges[i].values) || [];
    const prodSpan = rowSpan(mv(0), 1, lo, hi);
    const trendSpan = rowSpan(mv(0), 1, lo30, hi);
    const aliveSpan = T.alive ? rowSpan(mv(2), 1, lo14, hi) : null;
    const ordSpan = rowSpan(mv(3), 1, lo30, hi);
    const creSpan = rowSpan(av(0), creTail, lo14, hi);
    const avail = { prod: !!prodSpan, alive: !!aliveSpan, orders: !!ordSpan, creatives: !!creSpan };

    // 3) 기간 행 본문 읽기
    const mr = [q1(T.prod, "A1:FV1")];
    if (prodSpan) mr.push(q1(T.prod, `A${prodSpan[0]}:FV${prodSpan[1]}`));
    const rangesMain = { prodH: 0, prod: prodSpan ? 1 : -1 };
    if (aliveSpan) { rangesMain.aliveH = mr.push(q1(T.alive, "A1:AI1")) - 1; rangesMain.alive = mr.push(q1(T.alive, `A${aliveSpan[0]}:AI${aliveSpan[1]}`)) - 1; }
    if (ordSpan) { rangesMain.ord = mr.push(q1(T.ord, `A${ordSpan[0]}:O${ordSpan[1]}`)) - 1; }
    if (trendSpan) { rangesMain.trend = mr.push(q1(T.prod, `A${trendSpan[0]}:AH${trendSpan[1]}`)) - 1; }
    const [mb, ab] = await Promise.all([
      sheets.spreadsheets.values.batchGet({ spreadsheetId: MAIN, ranges: mr }),
      creSpan ? sheets.spreadsheets.values.batchGet({ spreadsheetId: ADS, ranges: [q1(T.cre, `A${creSpan[0]}:N${creSpan[1]}`)] }) : Promise.resolve(null)
    ]);
    const mbv = i => (i >= 0 && mb.data.valueRanges[i] && mb.data.valueRanges[i].values) || [];

    // ── 제품×채널
    const PH = mbv(0)[0] || [];
    const C = {
      name: colIndex(PH, "Product Name"), id: colIndex(PH, "Product ID"), gmv: colIndex(PH, "GMV"),
      sl: colIndex(PH, "Seller LIVE-attributed GMV"), sv: colIndex(PH, "Seller video-attributed GMV"),
      cl: colIndex(PH, "Creator LIVE-attributed GMV"), cv: colIndex(PH, "Creator video-attributed GMV"),
      pc: colIndex(PH, "Seller product card GMV"), orders: colIndex(PH, "Orders"), items: colIndex(PH, "Items sold"),
      imp: colIndex(PH, "Product impressions"), clk: colIndex(PH, "Product clicks"), uclk: colIndex(PH, "Unique clicks"),
      slItems: colIndex(PH, "Attributed items sold")
    };
    // 셀러(브랜드) 라이브 블록: 첫 번째 'Attributed GMV' 이후의 제품 지표
    const b0 = colIndex(PH, "Attributed GMV");
    const after = name => { if (b0 < 0) return -1; for (let i = b0; i < PH.length; i++) if (norm(PH[i]) === norm(name)) return i; return -1; };
    const SLB = { gmv: b0, orders: after("Attributed orders"), items: after("Attributed items sold"), imp: after("Product impressions"), clk: after("Product clicks"), atc: after("Add-to-cart count"), uclk: after("Unique clicks") };
    const zl = () => ({ gmv: 0, orders: 0, items: 0, imp: 0, clk: 0, atc: 0, uclk: 0 });
    const prods = {}, store = { a: z(), b: z() }, daily = {};
    function z() { return { gmv: 0, sl: 0, sv: 0, cl: 0, cv: 0, pc: 0, orders: 0, items: 0, imp: 0, clk: 0, uclk: 0 }; }
    for (const r of mbv(rangesMain.prod)) {
      const k = dkey(r[0]); const p = k && per(k); if (!p) continue;
      const id = String(r[C.id] || "").trim(); if (!id) continue;
      const e = prods[id] || (prods[id] = { id, name: String(r[C.name] || ""), a: z(), b: z(), live: { a: zl(), b: zl() } });
      for (const f in SLB) if (SLB[f] >= 0) e.live[p][f] += num(r[SLB[f]]);
      const dd = daily[k] || (daily[k] = { gmv: 0, sl: 0, cl: 0, cv: 0, sv: 0, pc: 0 });
      for (const f of Object.keys(e.a)) { const v = C[f] >= 0 ? num(r[C[f]]) : 0; e[p][f] += v; store[p][f] += v; if (f in dd) dd[f] += v; }
    }

    // ── 30일 추이 (스토어·채널)
    const ti = Object.fromEntries(tDates.map((k, i) => [k, i]));
    const zeros = () => tDates.map(() => 0);
    const trend = { dates: tDates, gmv: zeros(), sl: zeros(), cl: zeros(), cv: zeros(), pc: zeros(), sv: zeros(), orders: zeros(), uclk: zeros(), imp: zeros(), adSpend: zeros(), adLive: zeros(), adGmv: zeros() };
    for (const r of mbv(rangesMain.trend === undefined ? -1 : rangesMain.trend)) {
      const k = dkey(r[0]); const i = ti[k]; if (i === undefined || !String(r[C.id] || "").trim()) continue;
      for (const f of ["gmv", "sl", "cl", "cv", "pc", "sv", "orders", "uclk", "imp"]) if (C[f] >= 0) trend[f][i] += num(r[C[f]]);
    }

    // ── 광고: 캠페인(상품/라이브 광고비) + PID 매칭 + TROI
    const campRows = av(1), cH = campRows[0] || [];
    const cc = { date: 0, cid: colIndex(cH, "캠페인ID"), spend: colIndex(cH, "지출금액"), orders: colIndex(cH, "주문수"), gmv: colIndex(cH, "총매출(GMV)"), pid: colIndex(cH, "PRODUCT ID") };
    const pidOfCamp = {};
    for (const r of av(2).slice(1)) if (r[1] && r[2]) pidOfCamp[String(r[1]).trim()] = String(r[2]).trim();
    const ads = { a: { spend: 0, gmv: 0, liveSpend: 0, prodSpend: 0 }, b: { spend: 0, gmv: 0, liveSpend: 0, prodSpend: 0 } }, adByPid = {};
    for (const r of campRows.slice(1)) {
      const k = dkey(r[cc.date]); if (!k) continue;
      const sp = num(r[cc.spend]), gm = num(r[cc.gmv]);
      const pid = String(r[cc.pid] || "").trim() || pidOfCamp[String(r[cc.cid] || "").trim()] || "";
      const ii = ti[k]; if (ii !== undefined) { trend.adSpend[ii] += sp; trend.adGmv[ii] += gm; if (!pid) trend.adLive[ii] += sp; }
      const p = per(k); if (!p) continue;
      ads[p].spend += sp; ads[p].gmv += gm; if (pid) ads[p].prodSpend += sp; else ads[p].liveSpend += sp;
      if (pid) { const e = adByPid[pid] || (adByPid[pid] = { a: { spend: 0, gmv: 0 }, b: { spend: 0, gmv: 0 } }); e[p].spend += sp; e[p].gmv += gm; }
    }
    const troi = []; let lastDate = null;
    for (const r of av(3).slice(1)) {
      const d = dkey(r[0]) || lastDate; lastDate = d; if (!d || !r[1]) continue;
      if (d >= addDays(lo, -14) && d <= hi) troi.push({ date: d, product: r[1], from: num(r[3]), to: num(r[4]) });
    }

    // ── 주문별 AF: 영상 ID → 크리에이터(전체 탭), 기간 내 영상·라이브 매출
    const creatorOf = {};
    for (const r of mv(4).slice(1)) { const cid = String(r[2] || "").trim(); if (cid && r[0]) creatorOf[cid] = String(r[0]).trim(); }
    const vidRev = {}, liveCP = { a: {}, b: {} };
    const TC = {};
    for (const r of mbv(rangesMain.ord)) {
      const k = dkey(r[0]); if (!k) continue;
      const type = String(r[13] || ""), pay = num(r[6]), qty = num(r[8]) || 1, cid = String(r[14] || "").trim(), h = String(r[12] || "").trim().toLowerCase(), pid = String(r[2] || "").trim();
      const ii = ti[k];
      if (ii !== undefined && h) {
        const t = TC[h] || (TC[h] = { h, gmv: 0, video: 0, live: 0, other: 0, spark: tDates.map(() => 0), vids: {}, prods: {}, lastSale: k });
        t.gmv += pay; t.spark[ii] += pay; if (k > t.lastSale) t.lastSale = k;
        if (/live/i.test(type)) t.live += pay; else if (/video/i.test(type)) t.video += pay; else t.other += pay;
        if (cid && /video/i.test(type)) t.vids[cid] = (t.vids[cid] || 0) + pay;
        t.prods[pid] = (t.prods[pid] || 0) + pay;
      }
      const p = per(k); if (!p) continue;
      if (/live/i.test(type)) {
        const m = liveCP[p][h] || (liveCP[p][h] = {}); const e = m[pid] || (m[pid] = { pay: 0, qty: 0 }); e.pay += pay; e.qty += qty;
      } else if (cid) {
        const e = vidRev[cid] || (vidRev[cid] = { a: 0, b: 0, pid }); e[p] += pay;
      }
    }

    const nameOf = id => (prods[id] && prods[id].name) || "";
    // ── 최근 30일 매출 TOP 50 크리에이터 (영상을 계속 올리는지: 판매가 난 영상의 포스팅일 기준)
    const vidsOf = {};
    for (const r of mv(4).slice(1)) { const cid = String(r[2] || "").trim(), h = String(r[0] || "").trim().toLowerCase(); if (cid && h && /video/i.test(String(r[1] || ""))) (vidsOf[h] = vidsOf[h] || new Set()).add(cid); }
    const end = a2, d7 = addDays(end, -6), d14 = addDays(end, -13), d30 = addDays(end, -29);
    const topCreators = Object.values(TC).sort((x, y) => y.gmv - x.gmv).slice(0, 50).map(t => {
      const posts = [...(vidsOf[t.h] || [])].map(postDate).filter(Boolean).filter(d => d <= end).sort();
      const sum = (i0, i1) => t.spark.slice(i0, i1).reduce((s, v) => s + v, 0);
      return { h: t.h, gmv: Math.round(t.gmv), video: Math.round(t.video), live: Math.round(t.live), other: Math.round(t.other),
        last7: Math.round(sum(23, 30)), prev7: Math.round(sum(16, 23)), spark: t.spark.map(Math.round), lastSale: t.lastSale,
        videosWithSales30: Object.keys(t.vids).length,
        posts7: posts.filter(d => d >= d7).length, posts14: posts.filter(d => d >= d14).length, posts30: posts.filter(d => d >= d30).length,
        lastPost: posts.length ? posts[posts.length - 1] : null, totalVideos: posts.length,
        topProducts: Object.entries(t.prods).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([pid, v]) => ({ pid, name: nameOf(pid), pay: Math.round(v) })) };
    });

    // ── 소재별 광고성과
    const CR = (av(4)[0]) || [];
    const ci = { date: 0, cid: colIndex(CR, "소재ID"), camp: colIndex(CR, "캠페인명"), campId: colIndex(CR, "캠페인ID"), spend: colIndex(CR, "지출금액"), orders: colIndex(CR, "주문수"), gmv: colIndex(CR, "총매출(GMV)"), imp: colIndex(CR, "상품노출수"), clk: colIndex(CR, "상품클릭수"), v6: colIndex(CR, "6초시청률") };
    const cre = {}, si = Object.fromEntries(sDates.map((k, i) => [k, i]));
    for (const r of ((ab && ab.data.valueRanges[0].values) || [])) {
      const k = dkey(r[0]); if (!k) continue;
      const p = per(k), sx = si[k]; if (!p && sx === undefined) continue;
      const cid = String(r[ci.cid] || "").trim(); if (!/^\d{6,}$/.test(cid)) continue;
      const camp = String(r[ci.camp] || "");
      const key = cid + "|" + camp;
      const e = cre[key] || (cre[key] = { cid, camp, pid: pidOfCamp[String(r[ci.campId] || "").trim()] || "", a: { s: 0, g: 0, o: 0, i: 0, c: 0 }, b: { s: 0, g: 0, o: 0, i: 0, c: 0 }, ss: sDates.map(() => 0), sg: sDates.map(() => 0) });
      if (sx !== undefined) { e.ss[sx] += num(r[ci.spend]); e.sg[sx] += num(r[ci.gmv]); }
      if (!p) continue;
      e[p].s += num(r[ci.spend]); e[p].g += num(r[ci.gmv]); e[p].o += num(r[ci.orders]); e[p].i += num(r[ci.imp]); e[p].c += num(r[ci.clk]);
    }
    const creatives = Object.values(cre).filter(e => e.a.s + e.b.s + e.a.g + e.b.g > 0).map(e => ({
      cid: e.cid, camp: e.camp, pid: e.pid, product: nameOf(e.pid), creator: creatorOf[e.cid] || null, posted: postDate(e.cid),
      a: { spend: r2(e.a.s), gmv: r2(e.a.g), orders: e.a.o, imp: e.a.i, clk: e.a.c },
      b: { spend: r2(e.b.s), gmv: r2(e.b.g), orders: e.b.o, imp: e.b.i, clk: e.b.c },
      afRev: vidRev[e.cid] ? { a: r2(vidRev[e.cid].a), b: r2(vidRev[e.cid].b) } : null,
      spark: { spend: e.ss.map(Math.round), gmv: e.sg.map(Math.round) }
    })).sort((x, y) => Math.abs(y.a.gmv - y.b.gmv) - Math.abs(x.a.gmv - x.b.gmv));

    // ── 브랜드 라이브 세션
    const BL = mv(1), BH = BL[0] || [];
    const bi = n => colIndex(BH, n);
    const bcols = { handle: bi("Handle"), title: bi("Room name"), start: bi("Start time"), dur: bi("LIVE duration"), gmv: bi("LIVE-attributed GMV"), items: bi("LIVE-attributed items sold"), sku: bi("LIVE-attributed SKU orders"), cust: bi("Attributed customers"), orders: bi("LIVE orders"), viewers: bi("Viewers"), views: bi("Views"), clicks: bi("LIVE product clicks"), impr: bi("LIVE impressions"), avgview: bi("Avg. viewing duration"), followers: bi("New followers"), auction: bi("LIVE auction-attributed GMV") };
    const blive = { a: [], b: [] };
    let lastPrev = null;
    for (const r of BL.slice(1)) {
      const k = dkey(r[0]); if (!k || r.length < 8) continue;
      const s = { date: k, handle: r[bcols.handle], title: r[bcols.title], start: r[bcols.start], minutes: mins(r[bcols.dur]) };
      for (const f of ["gmv", "items", "sku", "cust", "orders", "viewers", "views", "clicks", "impr", "avgview", "followers", "auction"]) s[f] = bcols[f] >= 0 ? num(r[bcols[f]]) : 0;
      const p = per(k); if (p) blive[p].push(s);
      else if (k < a && (!lastPrev || k >= lastPrev[0].date) && s.handle === "dalba_global") { if (lastPrev && lastPrev[0].date !== k) lastPrev = null; (lastPrev = lastPrev || []).push(s); }
    }

    // ── AF 라이브 세션 → 크리에이터
    const afl = { a: {}, b: {} }, aspark = {};
    if (aliveSpan) {
      const AH = mbv(rangesMain.aliveH)[0] || [];
      const ai = n => colIndex(AH, n);
      const ac = { h: ai("Handle"), start: ai("Start time"), dur: ai("LIVE duration"), gmv: ai("LIVE-attributed GMV"), items: ai("LIVE-attributed items sold"), viewers: ai("Viewers"), clicks: ai("LIVE product clicks") };
      for (const r of mbv(rangesMain.alive)) {
        const k = dkey(r[ac.start]); if (!k) continue;
        const h = String(r[ac.h] || "").trim().toLowerCase(); if (!h) continue;
        if (si[k] !== undefined) { const sp = aspark[h] || (aspark[h] = sDates.map(() => 0)); sp[si[k]] += num(r[ac.gmv]); }
        const p = per(k); if (!p) continue;
        const e = afl[p][h] || (afl[p][h] = { sessions: 0, minutes: 0, gmv: 0, items: 0, viewers: 0, clicks: 0 });
        e.sessions++; e.minutes += mins(r[ac.dur]); e.gmv += num(r[ac.gmv]); e.items += num(r[ac.items]); e.viewers += num(r[ac.viewers]); e.clicks += num(r[ac.clicks]);
      }
    }
    const creators = [...new Set([...Object.keys(afl.a), ...Object.keys(afl.b)])]
      .map(h => ({ h, a: afl.a[h] || null, b: afl.b[h] || null, products: { a: liveCP.a[h] || {}, b: liveCP.b[h] || {} }, spark: (aspark[h] || []).map(Math.round) }))
      .filter(c => (c.a && c.a.gmv > 0) || (c.b && c.b.gmv > 0));

    const out = {
      periods: { a: [a, a2], b: [b, b2], days }, avail,
      store, ads, daily, trend, sparkDates: sDates, topCreators,
      products: Object.values(prods).map(p => ({ ...p, ads: adByPid[p.id] || null })).sort((x, y) => (y.a.gmv + y.b.gmv) - (x.a.gmv + x.b.gmv)),
      creatives, troi,
      brandLive: { a: blive.a, b: blive.b, lastBeforeA: lastPrev },
      afLive: creators,
      source: { main: MAIN, ads: ADS, tabs: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v ? v.title : null])) }
    };
    MEM[ck] = { ts: Date.now(), val: out };
    send(res, out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
function send(res, out) {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(out);
}
