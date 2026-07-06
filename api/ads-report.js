// Vercel Serverless Function — 배포 경로: /api/ads-report
// GMV Max 광고 대시보드(ads.html) 데이터 API.
// 구글시트 "틱톡샵 광고 대시보드(RAW)"의 `광고소재성과` 탭(일자×캠페인×소재 롱포맷)을 읽어
// 서버에서 소재/캠페인/전체 3레벨로 집계하고 KILL/BOOST/피로 판정을 계산해 JSON으로 반환한다.
//
// 환경변수:
//   GOOGLE_SERVICE_ACCOUNT  ← 기존 매출 대시보드와 동일한 서비스계정 JSON (광고 시트도 이 계정에 뷰어 공유)
//   ADS_SHEET_ID            ← 광고 스프레드시트 ID (필수)
//   (선택) ADS_TAB          ← 탭명, 기본 "광고소재성과" (헤더 기반 자동탐지 폴백)
//   (선택) DASHBOARD_PASSWORD ← 설정 시 ?pw= 또는 x-dash-pw 헤더 일치해야 응답
//
// 사용:
//   GET /api/ads-report                          → 전체 기간 집계
//   GET /api/ads-report?start=2026-06-01&end=2026-06-30 → 기간 필터 (L1/L2/선택기간 컬럼에만 적용)
//   GET /api/ads-report?fresh=1                  → 캐시 무시(수동 새로고침)
//   GET /api/ads-report?debug=1                  → 탭/헤더 매핑 진단
//
// 중요 규칙(요구사항 문서):
//   · 판정 배지·누적 지표·피로 계산은 날짜 필터와 무관하게 항상 전체 수명 기준
//   · 소재 키 = (소재ID, 캠페인명) — 동일 소재가 복수 캠페인에 존재 가능
//   · 영상 소재(소재ID 숫자)와 프로덕트카드(텍스트)는 항상 분리 집계
//   · 비율 지표는 지출 가중평균(지출 0 행 제외), 0 나눗셈 방어

function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").replace(/\$/g, "").trim();
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function parseDate(v) {
  const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { key: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ts: Date.UTC(y, mo - 1, d) };
}
const DAY = 86400000;
const r2 = x => Math.round(x * 100) / 100;

// ── 헤더 이름 기반 컬럼 탐지 (열 순서 변경에 견고) ──────────────
function mapColumns(header) {
  const h = header.map(x => String(x || "").toLowerCase().replace(/\s+/g, ""));
  const find = (...kws) => { for (let i = 0; i < h.length; i++) if (h[i] && kws.some(k => h[i].includes(k))) return i; return -1; };
  return {
    date: find("날짜", "date"),
    cid: find("소재id", "creativeid", "소재 id"),
    campId: find("캠페인id"),
    camp: find("캠페인명", "캠페인이름"),
    status: find("게재상태", "게재 상태", "delivery"),
    spend: find("지출금액", "지출"),
    orders: find("주문수"),
    cpo: find("주문당비용"),
    gmv: find("총매출", "gmv"),
    roi: find("roi"),
    imp: find("상품노출수"),
    pclk: find("상품클릭수"),
    pctr: find("상품클릭률"),
    ctr: find("광고클릭률"),
    cvr: find("광고전환율"),
    v2s: find("2초"),
    v6s: find("6초"),
    v25: find("25%"),
    v50: find("50%"),
    v75: find("75%"),
    v100: find("100%")
  };
}

// ── RAW 파싱 → 소재(소재ID×캠페인) 단위 구조 ───────────────────
function parseCreatives(rows) {
  if (!rows || rows.length < 2) return null;
  const C = mapColumns(rows[0]);
  if (C.date < 0 || C.cid < 0 || C.spend < 0) return null;
  const creatives = {}; // key = cid + "||" + camp
  let minTs = Infinity, maxTs = -Infinity;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const d = parseDate(r[C.date]); if (!d) continue;
    const cid = String(r[C.cid] || "").trim(); if (!cid) continue;
    const camp = String((C.camp >= 0 && r[C.camp]) || "").trim() || "(캠페인명 없음)";
    const key = cid + "||" + camp;
    const c = creatives[key] || (creatives[key] = {
      id: cid, camp, campId: String((C.campId >= 0 && r[C.campId]) || "").trim(),
      isPC: !/^\d+$/.test(cid),
      daily: {},            // dateKey → {ts, spend, gmv, orders}
      status: "-", statusTs: -1,
      wSpend: 0,            // 가중평균 분모(지출>0 행)
      w: { ctr: 0, pctr: 0, cvr: 0, v2s: 0, v6s: 0, v25: 0, v50: 0, v75: 0, v100: 0 },
      imp: 0, pclk: 0
    });
    const spend = num(r[C.spend]), gmv = num(r[C.gmv]), orders = num(r[C.orders]);
    const e = c.daily[d.key] || (c.daily[d.key] = { ts: d.ts, spend: 0, gmv: 0, orders: 0 });
    e.spend += spend; e.gmv += gmv; e.orders += orders;
    c.imp += num(r[C.imp]); c.pclk += num(r[C.pclk]);
    if (spend > 0) { // 비율은 지출 가중평균
      c.wSpend += spend;
      for (const k of ["ctr", "pctr", "cvr", "v2s", "v6s", "v25", "v50", "v75", "v100"])
        if (C[k] >= 0) c.w[k] += num(r[C[k]]) * spend;
    }
    if (C.status >= 0 && r[C.status] && d.ts >= c.statusTs) { c.status = String(r[C.status]).trim(); c.statusTs = d.ts; }
    if (d.ts < minTs) minTs = d.ts;
    if (d.ts > maxTs) maxTs = d.ts;
  }
  return { creatives: Object.values(creatives), minTs, maxTs, cols: C };
}

// 구간 합계 (ts 범위 [a,b] 포함)
function sumRange(c, a, b) {
  let spend = 0, gmv = 0, orders = 0;
  for (const k in c.daily) { const e = c.daily[k]; if (e.ts >= a && e.ts <= b) { spend += e.spend; gmv += e.gmv; orders += e.orders; } }
  return { spend, gmv, orders };
}
// 특정 시점(endTs)까지의 누적 지출
function cumUntil(c, endTs) {
  let s = 0; for (const k in c.daily) { const e = c.daily[k]; if (e.ts <= endTs) s += e.spend; } return s;
}
// 특정 시점 기준 피로 여부 (누적≥200 AND 최근7 < 이전7×0.5 AND 이전7≥30)
function fatiguedAt(c, endTs) {
  if (cumUntil(c, endTs) < 200) return false;
  const l7 = sumRange(c, endTs - 6 * DAY, endTs).spend;
  const p7 = sumRange(c, endTs - 13 * DAY, endTs - 7 * DAY).spend;
  return p7 >= 30 && l7 < p7 * 0.5;
}

// ── 판정 (요구사항 §4 그대로 · 날짜 필터 무관 고정 기준) ────────
function judge(c, latestTs) {
  const cum = sumRange(c, -Infinity, Infinity);
  const wr = k => c.wSpend ? c.w[k] / c.wSpend : 0;
  const roi = cum.spend ? cum.gmv / cum.spend : 0;
  const cvr = wr("cvr");
  const l7 = sumRange(c, latestTs - 6 * DAY, latestTs).spend;
  const p7 = sumRange(c, latestTs - 13 * DAY, latestTs - 7 * DAY).spend;
  let badge, rank;
  if (cum.spend < 10) { badge = "게이트탈락"; rank = 4; }
  else if (cum.spend >= 37 && cum.orders === 0) { badge = "KILL"; rank = 0; }
  else if (cum.spend >= 100 && roi < 1.5 && cvr < 2) { badge = "KILL"; rank = 0; }
  else if (cum.spend >= 200 && p7 >= 30 && l7 < p7 * 0.5) { badge = "피로"; rank = 1; }
  else if (cum.spend >= 100 && roi >= 3 && cvr >= 3 && l7 >= p7 * 0.8) { badge = "BOOST"; rank = 2; }
  else { badge = "관찰중"; rank = 3; }
  const confidence = cum.spend < 50 ? "판정불가" : cum.spend < 100 ? "예비" : "확정";
  // 4분면 (CVR 3% / 광고CTR 4%)
  const ctr = wr("ctr");
  const quadrant = ctr >= 4
    ? (cvr >= 3 ? "완벽 — 즉시 증산" : "낚시 훅 — 훅 소구점과 상품 페이지 불일치 점검")
    : (cvr >= 3 ? "저격형 — 문제 없음" : "상품 연결 실패 — 6초 이후 시연/CTA 구간 재편집");
  return { badge, rank, confidence, cum, roi, cvr, ctr, l7, p7, quadrant, wr };
}

// 주 시작(월요일) ts
function weekStart(ts) { const d = new Date(ts); const dow = (d.getUTCDay() + 6) % 7; return ts - dow * DAY; }
function wkLabel(ts) { const d = new Date(ts); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}~`; }

// ── 전체 집계 ──────────────────────────────────────────────────
function buildAdsJson(parsed, startKey, endKey) {
  const { creatives, minTs, maxTs } = parsed;
  const latestTs = maxTs;
  const pStart = startKey ? parseDate(startKey).ts : minTs;
  const pEnd = endKey ? parseDate(endKey).ts : maxTs;

  // 소재별 판정 + 구간 지표
  const list = creatives.map(c => {
    const j = judge(c, latestTs);
    const period = sumRange(c, pStart, pEnd);
    // 스파크라인: 최신일 기준 최근 30일 일별 지출 (게이트 통과 소재만 — payload 절약)
    let spark = null;
    if (j.cum.spend >= 10) {
      spark = [];
      for (let t = latestTs - 29 * DAY; t <= latestTs; t += DAY) {
        const k = new Date(t).toISOString().slice(0, 10);
        spark.push(c.daily[k] ? r2(c.daily[k].spend) : 0);
      }
    }
    return {
      id: c.id, isPC: c.isPC, camp: c.camp, status: c.status,
      badge: j.badge, rank: j.rank, confidence: j.confidence, quadrant: j.quadrant,
      cum: { spend: r2(j.cum.spend), gmv: r2(j.cum.gmv), orders: Math.round(j.cum.orders), roi: j.cum.spend ? r2(j.cum.gmv / j.cum.spend) : null, cvr: r2(j.cvr) },
      last7: r2(j.l7), prev7: r2(j.p7),
      period: { spend: r2(period.spend), gmv: r2(period.gmv), orders: Math.round(period.orders), roi: period.spend ? r2(period.gmv / period.spend) : null },
      spark,
      detail: { v2s: r2(j.wr("v2s")), v6s: r2(j.wr("v6s")), v25: r2(j.wr("v25")), v50: r2(j.wr("v50")), v100: r2(j.wr("v100")), ctr: r2(j.ctr), pctr: r2(j.wr("pctr")), cvr: r2(j.cvr) }
    };
  }).sort((a, b) => a.rank - b.rank || b.cum.spend - a.cum.spend);

  // L1: 기간 KPI (영상/PC 분리)
  const agg = (arr) => {
    const s = arr.reduce((o, x) => ({ spend: o.spend + x.period.spend, gmv: o.gmv + x.period.gmv, orders: o.orders + x.period.orders }), { spend: 0, gmv: 0, orders: 0 });
    return { spend: r2(s.spend), gmv: r2(s.gmv), orders: Math.round(s.orders), roi: s.spend ? r2(s.gmv / s.spend) : null };
  };
  const video = agg(list.filter(x => !x.isPC)), pc = agg(list.filter(x => x.isPC)), blended = agg(list);

  // L1: 주차별 지출·GMV·ROI (선택 기간 내)
  const wk = {};
  for (const c of creatives) for (const k in c.daily) {
    const e = c.daily[k]; if (e.ts < pStart || e.ts > pEnd) continue;
    const ws = weekStart(e.ts);
    const w = wk[ws] || (wk[ws] = { ts: ws, spend: 0, gmv: 0 });
    w.spend += e.spend; w.gmv += e.gmv;
  }
  const weekly = Object.values(wk).sort((a, b) => a.ts - b.ts)
    .map(w => ({ label: wkLabel(w.ts), spend: Math.round(w.spend), gmv: Math.round(w.gmv), roi: w.spend ? r2(w.gmv / w.spend) : null }));

  // L1: 소재 수급 밸런스 — 주간 신규 $10 게이트 통과 vs 신규 피로 진입 (최근 12주, 전체 수명 기준)
  const supplyWeeks = [];
  const lastWk = weekStart(latestTs);
  for (let i = 11; i >= 0; i--) {
    const ws = lastWk - i * 7 * DAY, we = ws + 6 * DAY;
    let passed = 0, fatigued = 0;
    for (const c of creatives) {
      const before = cumUntil(c, ws - DAY), after = cumUntil(c, we);
      if (before < 10 && after >= 10) passed++;
      if (fatiguedAt(c, we) && !fatiguedAt(c, ws - DAY)) fatigued++;
    }
    supplyWeeks.push({ label: wkLabel(ws), passed, fatigued });
  }
  const n = supplyWeeks.length;
  const supplyWarning = n >= 2 && supplyWeeks[n - 1].passed < supplyWeeks[n - 1].fatigued && supplyWeeks[n - 2].passed < supplyWeeks[n - 2].fatigued;

  // L1: 액션 카운터
  const actions = {
    kill: list.filter(x => x.badge === "KILL").length,
    fatigue: list.filter(x => x.badge === "피로").length,
    auth: list.filter(x => /authorization/i.test(x.status)).length
  };

  // L2: 캠페인별
  const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return r2(s[Math.floor(s.length / 2)]); };
  const byCamp = {};
  for (const x of list) (byCamp[x.camp] = byCamp[x.camp] || []).push(x);
  const campDaily = {}; // camp → dateKey → spend (기간 내)
  for (const c of creatives) {
    const m = campDaily[c.camp] || (campDaily[c.camp] = {});
    for (const k in c.daily) { const e = c.daily[k]; if (e.ts >= pStart && e.ts <= pEnd) m[k] = (m[k] || 0) + e.spend; }
  }
  const campaigns = Object.entries(byCamp).map(([name, arr]) => {
    const p = agg(arr);
    const cumG = arr.reduce((s, x) => s + x.cum.gmv, 0);
    const top3 = [...arr].sort((a, b) => b.cum.gmv - a.cum.gmv).slice(0, 3).reduce((s, x) => s + x.cum.gmv, 0);
    const winners = arr.filter(x => x.badge === "BOOST");
    // 파이프라인: 최근 2주 신규 투입(첫 지출일 기준) / $10 통과율 / 피로 수
    const src = creatives.filter(c => c.camp === name);
    let new2w = 0, passed2w = 0;
    for (const c of src) {
      const days = Object.values(c.daily).filter(e => e.spend > 0).map(e => e.ts);
      if (!days.length) continue;
      const first = Math.min(...days);
      if (first >= latestTs - 13 * DAY) { new2w++; if (cumUntil(c, latestTs) >= 10) passed2w++; }
    }
    const daily = Object.entries(campDaily[name] || {}).sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([k, s]) => ({ date: k.slice(5).replace("-", "/"), spend: Math.round(s) }));
    return {
      name, ...p,
      creatives: arr.length,
      winners: winners.length,
      top3Share: cumG ? r2(top3 / cumG * 100) : 0,
      pipeline: { new2w, passRate: new2w ? r2(passed2w / new2w * 100) : null, fatigued: arr.filter(x => x.badge === "피로").length },
      winnerMedians: { v2s: median(winners.map(w => w.detail.v2s)), v6s: median(winners.map(w => w.detail.v6s)), cvr: median(winners.map(w => w.detail.cvr)) },
      daily
    };
  }).sort((a, b) => b.spend - a.spend);

  const fmt = ts => new Date(ts).toISOString().slice(0, 10);
  return {
    meta: { minDate: fmt(minTs), maxDate: fmt(latestTs), start: fmt(pStart), end: fmt(pEnd), creatives: list.length, generatedAt: new Date().toISOString() },
    l1: { blended, video, pc, weekly, supplyWeeks, supplyWarning, actions },
    campaigns,
    creatives: list
  };
}

module.exports = async (req, res) => {
  try {
    // 패스워드 게이트 (설정 시)
    const pw = process.env.DASHBOARD_PASSWORD;
    if (pw) {
      const given = (req.query && req.query.pw) || req.headers["x-dash-pw"] || "";
      if (given !== pw) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    const sheetId = process.env.ADS_SHEET_ID;
    if (!sheetId) throw new Error("ADS_SHEET_ID 환경변수가 필요합니다 (광고 스프레드시트 ID).");

    const { google } = require("googleapis");
    let auth;
    if (process.env.GOOGLE_SERVICE_ACCOUNT) {
      auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
      });
    } else throw new Error("GOOGLE_SERVICE_ACCOUNT 환경변수가 필요합니다.");
    const sheets = google.sheets({ version: "v4", auth });

    // 탭: env 지정 → "광고소재성과" 이름 → 헤더(소재ID+캠페인명+지출) 탐지
    let tab = process.env.ADS_TAB;
    if (!tab) {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties.title" });
      const titles = (meta.data.sheets || []).map(s => s.properties.title);
      tab = titles.find(t => t.replace(/\s/g, "") === "광고소재성과");
      if (!tab) {
        const hb = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges: titles.map(t => `'${t}'!A1:Z1`) });
        const idx = (hb.data.valueRanges || []).findIndex(v => {
          const h = ((v.values && v.values[0]) || []).map(x => String(x).replace(/\s/g, ""));
          return h.some(x => x.includes("소재ID")) && h.some(x => x.includes("캠페인명")) && h.some(x => x.includes("지출"));
        });
        if (idx >= 0) tab = titles[idx];
      }
      if (!tab) throw new Error("'광고소재성과' 탭을 찾지 못했습니다. (ADS_TAB 환경변수로 지정 가능)");
    }

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${tab}'!A:Z` });
    const rows = resp.data.values || [];
    const parsed = parseCreatives(rows);
    if (!parsed) throw new Error(`'${tab}' 탭에서 필수 컬럼(날짜·소재ID·지출금액)을 찾지 못했습니다.`);

    // 진단 모드
    if (req.query && req.query.debug === "1") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ tab, header: rows[0], colMap: parsed.cols, rowCount: rows.length - 1, minDate: new Date(parsed.minTs).toISOString().slice(0, 10), maxDate: new Date(parsed.maxTs).toISOString().slice(0, 10), creatives: parsed.creatives.length });
      return;
    }

    const out = buildAdsJson(parsed, (req.query && req.query.start) || null, (req.query && req.query.end) || null);
    const fresh = req.query && req.query.fresh === "1";
    res.setHeader("Cache-Control", fresh ? "no-store" : "s-maxage=3600, stale-while-revalidate=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// 테스트용 내부 노출
module.exports._internals = { num, parseDate, mapColumns, parseCreatives, judge, buildAdsJson, fatiguedAt, sumRange, cumUntil };
