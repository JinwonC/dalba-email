// Vercel Serverless Function — 배포 경로: /api/daily-report
// 구글시트 "매출지표"에서 두 탭을 읽어 d'Alba 데일리 매출 리포트를 Slack(#데일리-분석)에 게시한다.
//   · 매출raw          : 상품×일자 애널리틱스 (날짜별 누적) → 섹션 1~5
//   · 매출발생영상      : 콘텐츠/크리에이터 단위 매출 귀속 → 섹션 6
//
// 보고서 구성
//   1. 전체 요약 (GMV·노출·방문자·장바구니·주문·구매자·AOV, DoD/WoW)
//   2. 채널별 매출 (Affiliate / Product Card / Seller Video / Seller LIVE)
//   3. 제품별 매출 TOP 10 (DoD·WoW·주문)
//   4. 크리에이터·콘텐츠 효율 (영상/라이브 1건당 매출)
//   5. 전환 퍼널 (노출→클릭→장바구니→주문 + 장바구니율 추이)
//   6. 매출 발생 영상 (제품별 전체, Content ID·크리에이터·TikTok 링크) → 스레드 분할
//
// 환경변수:
//   인증(둘 중 하나):
//     GOOGLE_SERVICE_ACCOUNT  ← 서비스계정 JSON 전체(권장). 시트를 이 계정 이메일에 공유만 하면 됨
//     또는 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN (Sheets readonly 스코프 포함된 OAuth 토큰)
//   SHEET_ID                  ← 스프레드시트 ID (필수)
//   (선택) RAW_SHEET   기본 "매출raw"
//   (선택) VIDEO_SHEET 기본 "매출발생영상"
//   (선택) TOP_N       기본 10
//   SLACK_BOT_TOKEN (+ SLACK_CHANNEL, 기본 #데일리-분석) ← chat.postMessage, chat:write 권한 + 채널 초대 필요
//   (선택) CRON_SECRET ← 설정 시 Authorization: Bearer <secret> 또는 ?secret= 일치해야 실행
//
// 사용:
//   GET /api/daily-report                  → 최신일 리포트 게시
//   GET /api/daily-report?date=2026-06-13  → 특정일 리포트 게시 (수동)
//   GET /api/daily-report?dryRun=1         → 게시 없이 결과 JSON 반환(미리보기)
//   POST (Slack 슬래시 커맨드)             → body.text 를 날짜로 사용, 채널에 게시

const DEFAULT_CHANNEL = "C0BAEH36VDX"; // #데일리-분석
const DEFAULT_TOP_N = 15;
const CHUNK_LIMIT = 3800; // Slack 메시지 1건 안전 길이

// ── 매출raw 컬럼 인덱스(고정 레이아웃, 검증됨) ──────────────────
const R = {
  date: 0, name: 1, id: 2, status: 4, gmv: 5,
  sellerLive: 6, sellerVideo: 9, affiliate: 12, productCard: 19,
  orders: 20, sku: 21, items: 22, cust: 23,
  imp: 25, clk: 26, atc: 28, uimp: 31, uclk: 32, shopGmv: 50,
  affLiveG: 103, affVidG: 106, newLive: 115, newVid: 116
};
// ── 매출발생영상 컬럼 인덱스 ────────────────────────────────────
const V = { date: 0, pid: 2, pname: 3, sku: 4, price: 5, pay: 6, qty: 8, creator: 12, ctype: 13, cid: 14, std: 16, shop: 21 };

// ── 파서/포맷 헬퍼 ─────────────────────────────────────────────
function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
function parseDate(v) {
  const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return {
    key: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    ts: Date.UTC(y, mo - 1, d), label: `${y}. ${mo}. ${d}`, md: `${mo}/${d}`
  };
}
const clean = s => String(s || "")
  .replace(/\[OFFICIAL d'Alba\]\s*/ig, "")
  .replace(/\[TikTok Exclusive\]\s*/ig, "")
  .replace(/\[Tiktok Exclusive\]\s*/ig, "").trim();
const money = x => "$" + Math.round(x || 0).toLocaleString("en-US");
function modeOf(o) { let b = "-", m = 0; for (const k in o) if (o[k] > m) { m = o[k]; b = k; } return b; }
const sg = x => (x >= 0 ? "+" : "") + (x || 0).toFixed(0) + "%";
const pct = (a, b) => (b ? (a - b) / b * 100 : 0);
const ratePct = (a, b) => (b ? (a / b * 100).toFixed(2) + "%" : "0.00%");

// ── 매출raw 집계 ───────────────────────────────────────────────
function parseRaw(rows) {
  const byDate = {}, prod = {};
  for (const r of rows) {
    const d = parseDate(r[R.date]);
    if (!d) continue;
    if (!byDate[d.key]) { byDate[d.key] = { date: d, t: {} }; prod[d.key] = {}; }
    const t = byDate[d.key].t;
    for (const k of Object.keys(R)) if (k !== "date" && k !== "name" && k !== "id" && k !== "status")
      t[k] = (t[k] || 0) + num(r[R[k]]);
    const id = String(r[R.id] || "").trim();
    if (id) {
      const p = prod[d.key][id] || (prod[d.key][id] = {
        name: clean(r[R.name]), gmv: 0, sku: 0, orders: 0, items: 0, cust: 0,
        sl: 0, sv: 0, aff: 0, avid: 0, alive: 0, pc: 0, imp: 0, clk: 0, atc: 0, newVid: 0, newLive: 0
      });
      p.gmv += num(r[R.gmv]); p.sku += num(r[R.sku]);
      p.orders += num(r[R.orders]); p.items += num(r[R.items]); p.cust += num(r[R.cust]);
      p.sl += num(r[R.sellerLive]); p.sv += num(r[R.sellerVideo]);
      p.aff += num(r[R.affiliate]); p.pc += num(r[R.productCard]);
      p.avid += num(r[R.affVidG]); p.alive += num(r[R.affLiveG]);
      p.imp += num(r[R.imp]); p.clk += num(r[R.clk]); p.atc += num(r[R.atc]);
      p.newVid += num(r[R.newVid]); p.newLive += num(r[R.newLive]);
    }
  }
  return { byDate, prod };
}
function pickComparisons(byDate, targetKey) {
  const keys = Object.keys(byDate).sort();
  const target = byDate[targetKey];
  const before = keys.filter(k => byDate[k].date.ts < target.date.ts);
  const prevDay = before.length ? byDate[before[before.length - 1]] : null;
  const wowTarget = target.date.ts - 7 * 86400000;
  let prevWeek = null, best = Infinity;
  for (const k of before) {
    const diff = Math.abs(byDate[k].date.ts - wowTarget);
    if (diff < best) { best = diff; prevWeek = byDate[k]; }
  }
  return { prevDay, prevWeek };
}

// ── 광고 탭(날짜·캠페인ID·지출금액C·…·PRODUCT ID G) → 일자별 광고비 ──
// byDate[key] = { total, live(=product id 없는 행=라이브), pid:{ productId: spend } }
const AD = { date: 0, spend: 2, pid: 6 };
function parseAds(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = parseDate(r[AD.date]);
    if (!d) continue;
    const e = byDate[d.key] || (byDate[d.key] = { total: 0, live: 0, pid: {} });
    const s = num(r[AD.spend]);
    e.total += s;
    const pid = String(r[AD.pid] || "").trim();
    if (pid) e.pid[pid] = (e.pid[pid] || 0) + s;
    else e.live += s;
  }
  return byDate;
}
function nearest(map, targetKey) {
  if (!map) return null;
  if (map[targetKey]) return map[targetKey];
  const ek = Object.keys(map).filter(k => k <= targetKey).sort();
  return ek.length ? map[ek[ek.length - 1]] : null;
}
function aggregate(raw, targetKey, topN, adByDate, commCur, afByDate, liveByDate) {
  const { byDate, prod } = raw;
  if (!byDate[targetKey]) throw new Error("해당 날짜 데이터가 없습니다: " + targetKey);
  const cur = byDate[targetKey], g = cur.t;
  const { prevDay, prevWeek } = pickComparisons(byDate, targetKey);
  const p = prevDay ? prevDay.t : null, w = prevWeek ? prevWeek.t : null;
  const dd = (k) => p ? sg(pct(g[k], p[k])) : "–";
  const ww = (k) => w ? sg(pct(g[k], w[k])) : "–";

  const channels = [
    ["Affiliate Video", "affVidG"], ["Affiliate LIVE", "affLiveG"],
    ["Seller Video", "sellerVideo"], ["Seller LIVE", "sellerLive"],
    ["Product Card", "productCard"]
  ].map(([t, k]) => ({ t, v: g[k], share: g.gmv ? g[k] / g.gmv * 100 : 0, dod: dd(k), wow: ww(k) }));

  const adCur = adByDate ? adByDate[targetKey] : null;
  const afCur = nearest(afByDate, targetKey);
  const prodCur = prod[targetKey];
  const totGmv = Object.values(prodCur).reduce((s, x) => s + x.gmv, 0);
  const prodPrev = prevDay ? prod[prevDay.date.key] : {}, prodW = prevWeek ? prod[prevWeek.date.key] : {};
  const ddp = (a, b) => (b ? sg((a - b) / b * 100) : (a > 0 ? "신규" : "–"));
  const top = Object.entries(prodCur).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.gmv - a.gmv).slice(0, topN)
    .map(x => {
      const c = adCur && adCur.pid[x.id] != null ? adCur.pid[x.id] : null;
      const cm = commCur && commCur[x.id];
      const af = afCur && afCur.pid[x.id];
      const comm = af ? af.comm : null;
      const mkt = (c || 0) + (comm || 0);
      return {
        ...x, share: totGmv ? x.gmv / totGmv * 100 : 0,
        dod: ddp(x.gmv, prodPrev[x.id] && prodPrev[x.id].gmv),
        wow: ddp(x.gmv, prodW[x.id] && prodW[x.id].gmv),
        pSku: prodPrev[x.id] ? prodPrev[x.id].sku : 0,
        cost: c, roi: c ? x.gmv / c : null,
        comm, refundP: af ? af.refund : null, trueRoi: mkt ? x.gmv / mkt : null,
        stdRate: cm ? cm.std : null, adRate: cm ? cm.ad : null,
        af: af ? { videos: af.videos, lives: af.lives, crPosted: af.crPosted, crSales: af.crSales, vidSales: af.vidSales, liveSales: af.liveSales, samples: af.samples, flat: af.flat, afgmv: af.afgmv } : null
      };
    });
  const topShare = top.reduce((s, x) => s + x.gmv, 0);

  // 광고비 & 스토어 ROI (= 전체 GMV ÷ 광고비)
  const spend = k => (adByDate && adByDate[k]) ? adByDate[k].total : null;
  const cCur = spend(targetKey), cPrev = prevDay ? spend(prevDay.date.key) : null, cWeek = prevWeek ? spend(prevWeek.date.key) : null;
  const cost = (cCur != null) ? {
    cur: cCur, prev: cPrev, week: cWeek,
    live: adCur ? adCur.live : 0, product: cCur - (adCur ? adCur.live : 0),
    dod: cPrev ? sg(pct(cCur, cPrev)) : "–",
    wow: cWeek ? sg(pct(cCur, cWeek)) : "–"
  } : null;
  const roi = cost ? {
    cur: cCur ? g.gmv / cCur : 0,
    prev: cPrev ? (p ? p.gmv / cPrev : 0) : null,
    week: cWeek ? (w ? w.gmv / cWeek : 0) : null
  } : null;

  // 어필리에이트 비용·환불·크리에이터 생산성 + 통합(진짜) ROI
  let mkt = null, refund = null, creators = null;
  if (afCur) {
    const t = afCur.t, ad = cCur || 0;
    const total = ad + t.comm + t.flat;
    const afPrev = prevDay ? nearest(afByDate, prevDay.date.key) : null;
    const adPrev = cPrev || 0;
    const prevTotal = afPrev ? adPrev + afPrev.t.comm + afPrev.t.flat : null;
    mkt = {
      ad, comm: t.comm, flat: t.flat, samples: t.samples, total,
      trueRoi: total ? g.gmv / total : null,
      prevTrueRoi: prevTotal ? (p ? p.gmv / prevTotal : null) : null,
      commRate: t.afgmv ? t.comm / t.afgmv * 100 : null
    };
    refund = { amt: t.refund, rate: g.gmv ? t.refund / g.gmv * 100 : 0, net: g.gmv - t.refund };
    creators = { posted: t.crPosted, withSales: t.crSales, videos: t.videos, vidSales: t.vidSales, lives: t.lives, liveSales: t.liveSales };
  }

  // 브랜드 라이브 (세션 있는 날만) + 라이브 제품별(Seller LIVE 귀속)
  const live = (liveByDate && liveByDate[targetKey]) ? liveByDate[targetKey] : null;
  let liveProd = null;
  if (live) liveProd = Object.values(prodCur).filter(x => x.sl > 0).map(x => ({ name: x.name, sl: x.sl })).sort((a, b) => b.sl - a.sl).slice(0, 5);

  return {
    date: cur.date, g, p, w, cost, roi, mkt, refund, creators, live, liveProd,
    prevDay: prevDay && prevDay.date, prevWeek: prevWeek && prevWeek.date,
    dd, ww, channels, top, totGmv, topShare,
    metrics: [
      ["노출", "imp"], ["방문자(순클릭)", "uclk"], ["장바구니", "atc"],
      ["주문", "sku"], ["구매자", "cust"], ["판매수량", "items"]
    ]
  };
}

// ── 매출발생영상 집계 ──────────────────────────────────────────
function parseVideos(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = parseDate(r[V.date]);
    if (!d) continue;
    if (!(r[V.pid] || r[V.pname])) continue;
    if (String(r[V.pname]).trim() === "Product Name" || String(r[V.pid]).trim() === "Product ID") continue; // 헤더 잔재 제외
    (byDate[d.key] || (byDate[d.key] = [])).push(r);
  }
  return byDate;
}
function aggregateVideos(vidByDate, targetKey) {
  // 요청일 우선, 없으면 그 이전 가장 최근일
  let useKey = targetKey;
  if (!vidByDate[useKey]) {
    const earlier = Object.keys(vidByDate).filter(k => k <= targetKey).sort();
    useKey = earlier[earlier.length - 1];
  }
  if (!useKey) return null;
  const rows = vidByDate[useKey];
  const prod = {}, creators = {}, byType = {};
  let orgPay = 0, shopPay = 0, orgCnt = 0, shopCnt = 0;
  for (const r of rows) {
    const pk = r[V.pid] || r[V.pname];
    const pid = String(r[V.pid] || "").trim();
    const p = prod[pk] || (prod[pk] = { name: clean(r[V.pname]), pid, pay: 0, org: 0, shop: 0, items: {}, skus: {} });
    const pay = num(r[V.pay]);
    p.pay += pay;
    // SKU(변형)별 판매금액·수량·건수
    const skuId = String(r[V.sku] || "").trim();
    if (skuId) {
      const sk = p.skus[skuId] || (p.skus[skuId] = { sku: skuId, pay: 0, qty: 0, cnt: 0 });
      sk.pay += pay; sk.qty += num(r[V.qty]); sk.cnt++;
    }
    const ck = r[V.ctype] + "|" + r[V.cid] + "|" + r[V.creator];
    const it = p.items[ck] || (p.items[ck] = { type: r[V.ctype], cid: r[V.cid], creator: r[V.creator], pay: 0, c: 0, org: { cnt: 0, rate: {} }, shop: { cnt: 0, rate: {} } });
    it.pay += pay; it.c++;
    const sR = String(r[V.std] || "").trim(), aR = String(r[V.shop] || "").trim();
    const isShop = aR.includes("%");
    if (isShop) { it.shop.cnt++; it.shop.rate[aR] = (it.shop.rate[aR] || 0) + 1; p.shop += pay; shopPay += pay; shopCnt++; }
    else if (sR.includes("%")) { it.org.cnt++; it.org.rate[sR] = (it.org.rate[sR] || 0) + 1; p.org += pay; orgPay += pay; orgCnt++; }
    // 크리에이터 리더보드 (Video/LIVE 등 콘텐츠 귀속 매출)
    const cu = String(r[V.creator] || "").trim();
    if (cu) {
      const cr = creators[cu] || (creators[cu] = { creator: cu, pay: 0, orders: 0, org: 0, shop: 0, cids: {} });
      cr.pay += pay; cr.orders++; if (isShop) cr.shop += pay; else cr.org += pay;
      if (r[V.cid]) cr.cids[r[V.cid]] = (cr.cids[r[V.cid]] || 0) + pay;
    }
    // 콘텐츠 타입별 매출
    const tp = String(r[V.ctype] || "기타").trim() || "기타";
    byType[tp] = (byType[tp] || 0) + pay;
  }
  const plist = Object.values(prod)
    .map(p => ({ ...p, items: Object.values(p.items).sort((a, b) => b.pay - a.pay), skus: Object.values(p.skus).sort((a, b) => b.pay - a.pay) }))
    .sort((a, b) => b.pay - a.pay);
  const totalPay = rows.reduce((s, r) => s + num(r[V.pay]), 0);
  const videoPay = rows.filter(r => r[V.ctype] === "Video").reduce((s, r) => s + num(r[V.pay]), 0);
  const creatorList = Object.values(creators)
    .map(c => ({ creator: c.creator, pay: Math.round(c.pay), orders: c.orders, org: Math.round(c.org), shop: Math.round(c.shop), contents: Object.keys(c.cids).length, topCid: modeOf(Object.fromEntries(Object.entries(c.cids).map(([k, v]) => [k, v]))) }))
    .sort((a, b) => b.pay - a.pay);
  const contentMix = Object.entries(byType).map(([type, pay]) => ({ type, pay: Math.round(pay) })).sort((a, b) => b.pay - a.pay);
  return {
    dateKey: parseDate(useKey), key: useKey, plist, totalPay, videoPay,
    creatorList, contentMix,
    org: { pay: Math.round(orgPay), cnt: orgCnt }, shop: { pay: Math.round(shopPay), cnt: shopCnt }
  };
}

// ── 매출발생영상 커미션율 (제품별 대표=최빈값) ─────────────────
//   Standard commission rate(16) / Shop Ads commission rate(21)
const VC = { date: 0, pid: 2, std: 16, adrate: 21 };
function parseCommissions(rows) {
  const tmp = {};
  for (const r of rows) {
    const d = parseDate(r[VC.date]); if (!d) continue;
    const pid = String(r[VC.pid] || "").trim(); if (!pid || pid === "Product ID") continue;
    const e = tmp[d.key] || (tmp[d.key] = {});
    const p = e[pid] || (e[pid] = { std: {}, ad: {} });
    const s = String(r[VC.std] || "").trim(); if (s.includes("%")) p.std[s] = (p.std[s] || 0) + 1;
    const a = String(r[VC.adrate] || "").trim(); if (a.includes("%")) p.ad[a] = (p.ad[a] || 0) + 1;
  }
  const mode = o => { let b = null, m = 0; for (const k in o) if (o[k] > m) { m = o[k]; b = k; } return b; };
  const out = {};
  for (const dk in tmp) { out[dk] = {}; for (const pid in tmp[dk]) out[dk][pid] = { std: mode(tmp[dk][pid].std), ad: mode(tmp[dk][pid].ad) }; }
  return out;
}

// ── SKU Order 탭: 제품(PID)×SKU(옵션/변형)별 판매금액·수량·건수 ──────
//   열 위치가 바뀌어도 되도록 "헤더 이름"으로 컬럼을 찾는다.
function parseSkuOrders(rows) {
  if (!rows || rows.length < 2) return null;
  const header = (rows[0] || []).map(h => String(h || "").toLowerCase().replace(/\s+/g, " ").trim());
  const find = (...kws) => { for (let i = 0; i < header.length; i++) if (header[i] && kws.some(k => header[i].includes(k))) return i; return -1; };
  const iDate = find("date", "날짜");
  const iPid = find("product id", "상품 id", "제품 id");
  const iSkuName = find("variation", "variant", "sku name", "옵션", "option name", "속성");
  const iSkuId = find("sku id", "seller sku", "sku");
  const iAmt = find("gmv", "payment amount", "sales amount", "판매금액", "매출", "결제금액", "amount", "금액");
  const iQty = find("quantity", "qty", "수량", "판매수량", "items sold");
  const iOrd = find("orders", "order count", "주문수", "주문 수", "건수", "sku orders");
  const iOrdId = find("order id", "주문 id", "주문번호");
  const sku = iSkuName >= 0 ? iSkuName : iSkuId;
  const iName = find("product name", "상품명", "제품명");
  if (iPid < 0 || sku < 0 || iAmt < 0) return null; // 필수 열(제품ID·SKU·금액) 없으면 미사용
  const byDate = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row) continue;
    const pid = String(row[iPid] || "").trim();
    if (!pid || pid.toLowerCase() === "product id") continue;
    const d = iDate >= 0 ? parseDate(row[iDate]) : null;
    const dk = d ? d.key : "_all";
    const label = (String(row[sku] || "").trim()) || (iName >= 0 ? clean(row[iName]) : "") || "(옵션 미표기)";
    const amt = num(row[iAmt]);
    const qty = iQty >= 0 ? num(row[iQty]) : 0;
    const e = byDate[dk] || (byDate[dk] = {});
    const p = e[pid] || (e[pid] = {});
    const s = p[label] || (p[label] = { sku: label, pay: 0, qty: 0, cnt: 0 });
    s.pay += amt; s.qty += qty;
    // 판매건수: 명시적 주문수 열이 있으면 합산, 아니면(주문ID/행 단위) 1건씩
    s.cnt += (iOrd >= 0 && iOrdId < 0) ? num(row[iOrd]) : 1;
  }
  return byDate; // { dateKey|_all: { pid: { label: {sku,pay,qty,cnt} } } }
}
function skusForProduct(skuByDate, targetKey, pid) {
  if (!skuByDate) return [];
  const src = skuByDate[targetKey] || skuByDate["_all"] ||
    (() => { const ks = Object.keys(skuByDate).filter(k => k <= targetKey).sort(); return ks.length ? skuByDate[ks[ks.length - 1]] : null; })();
  const byPid = src && src[pid];
  if (!byPid) return [];
  return Object.values(byPid).sort((a, b) => b.pay - a.pay);
}

// ── 제품별 AF(어필리에이트) RAW: 커미션·플랫피·샘플·환불·크리에이터수 ──
const AF = { date: 0, pid: 2, afgmv: 4, refund: 5, crSales: 10, crPosted: 11, vidSales: 12, liveSales: 13, videos: 14, lives: 15, comm: 16, samples: 17, flat: 18 };
function parseAffiliate(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = parseDate(r[AF.date]); if (!d) continue;
    const e = byDate[d.key] || (byDate[d.key] = { t: { comm: 0, flat: 0, samples: 0, refund: 0, afgmv: 0, crPosted: 0, crSales: 0, videos: 0, vidSales: 0, lives: 0, liveSales: 0 }, pid: {} });
    const t = e.t;
    t.comm += num(r[AF.comm]); t.flat += num(r[AF.flat]); t.samples += num(r[AF.samples]); t.refund += num(r[AF.refund]); t.afgmv += num(r[AF.afgmv]);
    t.crPosted += num(r[AF.crPosted]); t.crSales += num(r[AF.crSales]); t.videos += num(r[AF.videos]); t.vidSales += num(r[AF.vidSales]); t.lives += num(r[AF.lives]); t.liveSales += num(r[AF.liveSales]);
    const pid = String(r[AF.pid] || "").trim();
    if (pid && pid !== "Product ID") {
      const p = e.pid[pid] || (e.pid[pid] = { comm: 0, refund: 0, afgmv: 0, flat: 0, samples: 0, videos: 0, lives: 0, crPosted: 0, crSales: 0, vidSales: 0, liveSales: 0 });
      p.comm += num(r[AF.comm]); p.refund += num(r[AF.refund]); p.afgmv += num(r[AF.afgmv]);
      p.flat += num(r[AF.flat]); p.samples += num(r[AF.samples]);
      p.videos += num(r[AF.videos]); p.lives += num(r[AF.lives]);
      p.crPosted += num(r[AF.crPosted]); p.crSales += num(r[AF.crSales]);
      p.vidSales += num(r[AF.vidSales]); p.liveSales += num(r[AF.liveSales]);
    }
  }
  return byDate;
}

// ── 브랜드(자사) 라이브 세션 RAW ───────────────────────────────
const LV = { date: 0, room: 5, dur: 7, gmv: 8, prod: 20, aov: 21, ord: 22, payrate: 23, viewers: 25, ctr: 27, avgview: 29 };
function durMin(s) { const m = String(s || "").match(/(\d+)\s*h\s*(\d+)\s*m/); return m ? (+m[1] * 60 + +m[2]) : 0; }
function parseLive(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = parseDate(r[LV.date]); if (!d) continue;
    if (num(r[LV.gmv]) <= 0) continue;
    (byDate[d.key] || (byDate[d.key] = [])).push({
      dur: String(r[LV.dur] || ""), min: durMin(r[LV.dur]), gmv: num(r[LV.gmv]), ord: num(r[LV.ord]),
      aov: num(r[LV.aov]), viewers: num(r[LV.viewers]), ctr: String(r[LV.ctr] || ""), payrate: String(r[LV.payrate] || ""), avgview: String(r[LV.avgview] || "")
    });
  }
  for (const k in byDate) byDate[k].sort((a, b) => b.gmv - a.gmv);
  return byDate;
}

// ── AI 인사이트 한줄평 (ANTHROPIC_API_KEY 있을 때만) ───────────
async function generateInsights(a, vid) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const g = a.g, topVid = vid && vid.plist[0];
  const ctx = {
    날짜: a.date.label,
    GMV: { 당일: Math.round(g.gmv), 전일: a.p ? Math.round(a.p.gmv) : null, 전주: a.w ? Math.round(a.w.gmv) : null, DoD: a.dd("gmv"), WoW: a.ww("gmv") },
    광고: a.cost ? { 광고비: Math.round(a.cost.cur), 제품광고비: Math.round(a.cost.product), 라이브광고비: Math.round(a.cost.live), DoD: a.cost.dod, WoW: a.cost.wow, "ROI(전체GMV/광고비)": +a.roi.cur.toFixed(2), 전일ROI: a.roi.prev != null ? +a.roi.prev.toFixed(2) : null } : null,
    크리에이터생산성: a.creators ? { 게시: a.creators.posted, 판매발생: a.creators.withSales, 영상: a.creators.videos, 판매영상: a.creators.vidSales } : null,
    브랜드라이브: (a.live && a.live.length) ? { 세션: a.live.length, GMV: Math.round(a.live.reduce((s, x) => s + x.gmv, 0)), 시청자: a.live.reduce((s, x) => s + x.viewers, 0), "GMV/시간": Math.round((a.live.reduce((s, x) => s + x.gmv, 0)) / (a.live.reduce((s, x) => s + x.min, 0) / 60 || 1)) } : null,
    채널: a.channels.map(c => ({ 채널: c.t, GMV: Math.round(c.v), 비중: +c.share.toFixed(1), DoD: c.dod, WoW: c.wow })),
    제품TOP: a.top.map(x => ({ 제품: x.name.slice(0, 40), GMV: Math.round(x.gmv), 광고비: x.cost != null ? Math.round(x.cost) : null, "ROI(GMV/광고비)": x.roi != null ? +x.roi.toFixed(1) : null, DoD: x.dod, WoW: x.wow, 주문: x.sku })),
    콘텐츠: {
      신규영상: g.newVid, 영상당매출: +(g.affVidG / (g.newVid || 1)).toFixed(2),
      전일영상당: a.p ? +(a.p.affVidG / (a.p.newVid || 1)).toFixed(2) : null,
      전주영상당: a.w ? +(a.w.affVidG / (a.w.newVid || 1)).toFixed(2) : null,
      라이브당매출: +(g.affLiveG / (g.newLive || 1)).toFixed(2),
      매출1위영상: topVid ? { 제품: topVid.name.slice(0, 30), 크리에이터: topVid.items[0] && topVid.items[0].creator, 매출: Math.round(topVid.items[0] && topVid.items[0].pay) } : null
    },
    퍼널: {
      노출: g.imp, 클릭: g.clk, CTR: ratePct(g.clk, g.imp),
      장바구니율_당일: ratePct(g.atc, g.clk), 장바구니율_전일: a.p ? ratePct(a.p.atc, a.p.clk) : null, 장바구니율_전주: a.w ? ratePct(a.w.atc, a.w.clk) : null,
      주문전환: ratePct(g.sku, g.clk)
    }
  };
  const prompt =
    "너는 d'Alba TikTok Shop 데이터 분석가다. 아래 일일 지표(JSON)를 보고 보고서 각 섹션의 핵심 인사이트를 " +
    "한국어 한 문장으로 작성하라. 규칙: (1) 반드시 수치 근거 포함, (2) 일반론·뻔한 말 금지, " +
    "(3) 하락/이상 신호엔 추정 원인이나 액션 1개 덧붙이기, (4) 각 문장 60자 내외, " +
    "(5) 모든 금액 단위는 USD 달러이며 표기는 반드시 \"$1,234\" 형식(원/천원 절대 금지).\n" +
    "출력은 JSON만: {\"overview\":\"\",\"channel\":\"\",\"product\":\"\",\"content\":\"\",\"funnel\":\"\",\"live\":\"\"}\n\n" +
    JSON.stringify(ctx);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    const txt = (data.content && data.content[0] && data.content[0].text) || "";
    const m = txt.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}

// ── Slack mrkdwn 빌더 ─────────────────────────────────────────
function buildMain(a, ins) {
  const g = a.g;
  const tip = k => (ins && ins[k]) ? `🗒 _${ins[k]}_\n` : "";
  let o = `*📊 d'Alba 데일리 매출 리포트 — ${a.date.label}*\n`;
  o += `_전일(${a.prevDay ? a.prevDay.md : "–"}) · 전주(${a.prevWeek ? a.prevWeek.md : "–"}) 대비_\n\n`;
  // 1
  o += `*1. 전체 요약*\n`;
  o += `• 총 GMV *${money(g.gmv)}*  (DoD ${a.dd("gmv")} / WoW ${a.ww("gmv")})`;
  o += a.p ? ` — 전일 ${money(a.p.gmv)} · 전주 ${a.w ? money(a.w.gmv) : "–"}\n` : `\n`;
  for (const [lbl, k] of a.metrics)
    o += `• ${lbl} ${Math.round(g[k]).toLocaleString()} (${a.dd(k)} / ${a.ww(k)})\n`;
  o += `• AOV $${(g.gmv / (g.sku || 1)).toFixed(2)} · 구매전환율(방문→구매) ${ratePct(g.cust, g.uclk)}\n`;
  if (a.cost) {
    o += `• 광고비 ${money(a.cost.cur)} (${a.cost.dod} / ${a.cost.wow}) · *ROI ${a.roi.cur.toFixed(2)}x* _(전체 GMV ÷ 광고비)_`;
    o += (a.roi.prev != null) ? ` — 전일 ${a.roi.prev.toFixed(2)}x${a.roi.week != null ? ` · 전주 ${a.roi.week.toFixed(2)}x` : ""}\n` : `\n`;
    o += `   └ 제품 광고비 ${money(a.cost.product)} · 라이브(비제품) 광고비 ${money(a.cost.live)}\n`;
  }
  o += tip("overview") + `\n`;
  // 2
  o += `*2. 채널별 매출* _(귀속 기준, 합 100%)_\n`;
  for (const c of a.channels)
    o += `• ${c.t} *${money(c.v)}* (${c.share.toFixed(1)}%) · DoD ${c.dod} / WoW ${c.wow}\n`;
  o += `   └ 오가닉 스토어탭 ${money(g.shopGmv)}\n`;
  o += tip("channel") + `\n`;
  // 3
  o += `*3. 제품별 매출 TOP ${a.top.length}* _(TOP${a.top.length} = 전체의 ${(a.totGmv ? a.topShare / a.totGmv * 100 : 0).toFixed(0)}%)_\n`;
  a.top.forEach((x, i) => {
    const c = x.cost != null ? money(x.cost) : "-";
    const r = x.roi != null ? x.roi.toFixed(1) + "x" : "-";
    o += `\`${i + 1}.\` ${x.name.slice(0, 42)} — *${money(x.gmv)}* · ${x.sku}주문 (DoD ${x.dod} / WoW ${x.wow}) · 광고 ${c} · ROI ${r}\n`;
  });
  o += tip("product") + `\n`;
  // 4
  o += `*4. 크리에이터·콘텐츠 효율*\n`;
  o += `• 신규 영상 ${g.newVid}건 · 라이브 ${g.newLive}건\n`;
  o += `• 영상 1건당 매출 *$${(g.affVidG / (g.newVid || 1)).toFixed(2)}*`;
  o += a.p ? ` (전일 $${(a.p.affVidG / (a.p.newVid || 1)).toFixed(2)}${a.w ? ` / 전주 $${(a.w.affVidG / (a.w.newVid || 1)).toFixed(2)}` : ""})\n` : `\n`;
  o += `• 라이브 1건당 $${(g.affLiveG / (g.newLive || 1)).toFixed(2)}\n`;
  if (a.creators) {
    const cv = a.creators.posted ? (a.creators.withSales / a.creators.posted * 100).toFixed(0) : "0";
    o += `• 콘텐츠 게시 크리에이터 ${a.creators.posted}명 → 판매발생 *${a.creators.withSales}명* (${cv}%)\n`;
    o += `• 영상 ${a.creators.videos}개 중 판매발생 ${a.creators.vidSales}개 · 라이브 ${a.creators.lives}개 중 ${a.creators.liveSales}개\n`;
  }
  if (a.mkt) o += `• 샘플 발송 ${a.mkt.samples}개\n`;
  o += tip("content") + `\n`;
  // 5
  o += `*5. 전환 퍼널*\n`;
  o += `노출 ${g.imp.toLocaleString()} → 클릭 ${g.clk.toLocaleString()} (CTR ${ratePct(g.clk, g.imp)}) → 장바구니 ${Math.round(g.atc)} (장바구니율 ${ratePct(g.atc, g.clk)}) → 주문 ${Math.round(g.sku)} (주문전환 ${ratePct(g.sku, g.clk)})\n`;
  if (a.w && a.p)
    o += `• 장바구니율 추이 ${a.prevWeek.md}→${a.prevDay.md}→${a.date.md}: ${ratePct(a.w.atc, a.w.clk)} → ${ratePct(a.p.atc, a.p.clk)} → ${ratePct(g.atc, g.clk)}\n`;
  o += tip("funnel");
  o += `\n🧵 _6. 제품별 매출 발생 영상(오가닉/샵애즈)은 이 메시지의 스레드 참고_\n`;
  // 7. 브랜드 라이브 (세션 있는 날만, 맨 아래)
  if (a.live && a.live.length) {
    const tg = a.live.reduce((s, x) => s + x.gmv, 0), tv = a.live.reduce((s, x) => s + x.viewers, 0),
      to = a.live.reduce((s, x) => s + x.ord, 0), tmin = a.live.reduce((s, x) => s + x.min, 0);
    o += `\n*7. 🔴 브랜드 라이브 (${a.date.label})*\n`;
    o += `전체 · ${a.live.length}세션 · ${(tmin / 60).toFixed(1)}h · GMV *${money(tg)}* · 시청자 ${tv.toLocaleString()} · 주문 ${to} · GMV/시간 *${money(tmin ? tg / (tmin / 60) : 0)}*\n`;
    for (const s of a.live)
      o += `• ${s.dur} · *${money(s.gmv)}* · ${s.ord}주문 · AOV $${s.aov.toFixed(0)} · 시청자 ${s.viewers.toLocaleString()} · CTR ${s.ctr} · 결제율 ${s.payrate} · 평균시청 ${s.avgview}분\n`;
    if (a.liveProd && a.liveProd.length) {
      o += `라이브 제품 TOP ${a.liveProd.length} _(Seller LIVE 귀속 GMV)_\n`;
      a.liveProd.forEach((p, i) => o += `${i + 1}. ${p.name.slice(0, 40)} — ${money(p.sl)}\n`);
    }
    o += tip("live");
  }
  return o;
}

function videoChunks(v, reportDate) {
  if (!v) return [];
  const note = v.key !== reportDate ? `  ⚠️ _(영상 데이터는 ${v.dateKey.label} 기준)_` : "";
  let header = `*📹 6. 매출 발생 영상 (제품별 · ${v.dateKey.label})*${note}\n> 콘텐츠 귀속 매출 ${money(v.totalPay)} · 영상 ${money(v.videoPay)} / 제품 ${v.plist.length}개 · (오가닉=스탠다드 커미션, 샵애즈=광고)\n\n`;
  const blocks = v.plist.map(pr => {
    let b = `*${money(pr.pay)} — ${pr.name.slice(0, 70)}* _(${pr.items.length}콘텐츠)_\n`;
    for (const it of pr.items) {
      const seg = [];
      if (it.org.cnt) seg.push(`오가닉(${modeOf(it.org.rate)}) ${it.org.cnt}건`);
      if (it.shop.cnt) seg.push(`샵애즈(${modeOf(it.shop.rate)}) ${it.shop.cnt}건`);
      const who = it.type === "Video"
        ? `<https://www.tiktok.com/@${it.creator}/video/${it.cid}|@${it.creator}>`
        : `@${it.creator} _(${it.type})_`;
      b += `• ${money(it.pay)} · ${who} · ${seg.join(" · ") || "-"}\n`;
    }
    return b;
  });
  const chunks = [];
  let cur = header;
  for (const b of blocks) {
    if ((cur + b).length > CHUNK_LIMIT) { chunks.push(cur.trimEnd()); cur = ""; }
    cur += b + "\n";
  }
  if (cur.trim()) chunks.push(cur.trimEnd());
  return chunks;
}

// ── Slack 전송 ─────────────────────────────────────────────────
async function slackPost(token, channel, text, thread_ts) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, thread_ts, unfurl_links: false, unfurl_media: false })
  });
  const data = await r.json();
  if (!data.ok) throw new Error("Slack 오류: " + data.error);
  return data.ts;
}
async function postReport(token, channel, mainText, chunks) {
  const parent = await slackPost(token, channel, mainText);
  for (const c of chunks) await slackPost(token, channel, c, parent);
  return { parent, threadCount: chunks.length };
}
// 같은 날짜 리포트가 채널에 이미 있으면 true (중복 방지). 권한 없으면 false로 진행.
async function alreadyPosted(token, channel, label) {
  try {
    const r = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=40`, { headers: { authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d.ok) return false;
    return (d.messages || []).some(m => (m.text || "").includes("리포트 — " + label));
  } catch (e) { return false; }
}

// 탭을 이름이 아니라 헤더 내용으로 식별 (탭 rename에 견고)
async function resolveTabs(sheets, sheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties.title" });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);
  const ranges = titles.map(t => `'${t}'!A1:BZ1`);
  const hb = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges });
  const headers = (hb.data.valueRanges || []).map(v => ((v.values && v.values[0]) || []).map(x => String(x).toLowerCase()));
  const has = (h, kw) => h.some(c => c.includes(kw));
  const find = pred => { for (let i = 0; i < titles.length; i++) if (headers[i] && pred(headers[i], titles[i])) return titles[i]; return null; };
  return {
    raw: find(h => has(h, "gmv range") && has(h, "listing status")),
    vid: find(h => has(h, "content type") && has(h, "creator username")),
    ad: find(h => has(h, "지출금액")) || (titles.includes("광고") ? "광고" : null),
    af: find(h => has(h, "samples shipped") || (has(h, "est. commission") && has(h, "creators posted content"))),
    live: find(h => has(h, "live duration") && (has(h, "room id") || has(h, "live-attributed gmv"))),
    // SKU Order 탭: 탭 이름 우선, 없으면 헤더(제품ID+SKU+금액/수량)로 인식.
    // 단, 콘텐츠 매출 탭(creator/content 열 보유)은 제외해 오탐 방지.
    skuOrder: find((h, t) => String(t).toLowerCase().trim() === "sku order")
      || find(h => has(h, "product id") && has(h, "sku") && !has(h, "creator username") && !has(h, "content type") && (has(h, "quantity") || has(h, "gmv") || has(h, "payment amount")))
  };
}

// ── 웹 대시보드용 구조화 데이터 ────────────────────────────────
function buildJson(agg, raw, adByDate, ins, vid, skuByDate) {
  const g = agg.g;
  const keys = Object.keys(raw.byDate).sort();
  const idx = keys.indexOf(agg.date.key);
  const window = keys.slice(Math.max(0, idx - 29), idx + 1); // 최대 30일 추이
  const series = window.map(k => {
    const t = raw.byDate[k].t;
    const spend = adByDate && adByDate[k] ? adByDate[k].total : 0;
    return {
      date: raw.byDate[k].date.md, gmv: Math.round(t.gmv), adSpend: Math.round(spend),
      roi: spend ? +(t.gmv / spend).toFixed(2) : null, orders: Math.round(t.sku),
      buyers: Math.round(t.cust), aov: t.sku ? +(t.gmv / t.sku).toFixed(2) : null,
      atcRate: t.clk ? +(t.atc / t.clk * 100).toFixed(1) : null,
      ctr: t.imp ? +(t.clk / t.imp * 100).toFixed(2) : null,
      conv: t.uclk ? +(t.cust / t.uclk * 100).toFixed(2) : null,
      orderConv: t.clk ? +(t.sku / t.clk * 100).toFixed(2) : null,
      affVideo: Math.round(t.affVidG), affLive: Math.round(t.affLiveG),
      productCard: Math.round(t.productCard),
      sellerVideo: Math.round(t.sellerVideo), sellerLive: Math.round(t.sellerLive)
    };
  });

  // 매출발생영상 → 제품ID별 매핑 (제품 딥다이브에 영상 목록 붙이기)
  const vidByPid = {};
  if (vid) for (const p of vid.plist) if (p.pid) vidByPid[p.pid] = p;

  // 제품별 일자 추이용 최근 14일 윈도우
  const pwin = keys.slice(Math.max(0, idx - 13), idx + 1);
  const prodSeries = (pid) => pwin.map(k => {
    const pp = raw.prod[k] && raw.prod[k][pid];
    const spend = adByDate && adByDate[k] && adByDate[k].pid ? (adByDate[k].pid[pid] || 0) : 0;
    const gmv = pp ? pp.gmv : 0;
    return {
      date: raw.byDate[k].date.md, gmv: Math.round(gmv),
      orders: pp ? Math.round(pp.sku) : 0, cost: Math.round(spend),
      roi: spend ? +(gmv / spend).toFixed(2) : null,
      imp: pp ? Math.round(pp.imp) : 0, clk: pp ? Math.round(pp.clk) : 0, atc: pp ? Math.round(pp.atc) : 0
    };
  });

  const products = agg.top.map((x, rank) => {
    const chan = [
      { name: "Affiliate Video", v: Math.round(x.avid || 0) },
      { name: "Affiliate LIVE", v: Math.round(x.alive || 0) },
      { name: "Seller Video", v: Math.round(x.sv || 0) },
      { name: "Seller LIVE", v: Math.round(x.sl || 0) },
      { name: "Product Card", v: Math.round(x.pc || 0) }
    ];
    const vp = vidByPid[x.id];
    const revVideos = vp ? vp.items.slice(0, 15).map(it => ({
      creator: it.creator, cid: it.cid, type: it.type, pay: Math.round(it.pay),
      org: it.org.cnt, orgRate: modeOf(it.org.rate), shop: it.shop.cnt, shopRate: modeOf(it.shop.rate),
      link: it.type === "Video" && it.cid ? `https://www.tiktok.com/@${it.creator}/video/${it.cid}` : null
    })) : [];
    return {
      rank: rank + 1, id: x.id, name: x.name,
      gmv: Math.round(x.gmv), share: +x.share.toFixed(1), sku: x.sku,
      orders: Math.round(x.orders || 0), items: Math.round(x.items || 0), cust: Math.round(x.cust || 0),
      aov: x.sku ? +(x.gmv / x.sku).toFixed(2) : null,
      cost: x.cost != null ? Math.round(x.cost) : null,
      roi: x.roi != null ? +x.roi.toFixed(2) : null,
      comm: x.comm != null ? Math.round(x.comm) : null,
      stdRate: x.stdRate, adRate: x.adRate,
      dod: x.dod, wow: x.wow,
      channels: chan,
      funnel: {
        imp: Math.round(x.imp || 0), clk: Math.round(x.clk || 0), atc: Math.round(x.atc || 0), sku: x.sku,
        ctr: x.imp ? +(x.clk / x.imp * 100).toFixed(2) : 0,
        atcRate: x.clk ? +(x.atc / x.clk * 100).toFixed(2) : 0,
        orderConv: x.clk ? +(x.sku / x.clk * 100).toFixed(2) : 0
      },
      series: prodSeries(x.id),
      newVid: Math.round(x.newVid || 0), newLive: Math.round(x.newLive || 0),
      af: x.af ? {
        videos: Math.round(x.af.videos), lives: Math.round(x.af.lives),
        crPosted: Math.round(x.af.crPosted), crSales: Math.round(x.af.crSales),
        vidSales: Math.round(x.af.vidSales), liveSales: Math.round(x.af.liveSales),
        samples: Math.round(x.af.samples), afgmv: Math.round(x.af.afgmv)
      } : null,
      revVideoCount: vp ? vp.items.length : 0,
      revVideoPay: vp ? Math.round(vp.pay) : 0,
      revVideos,
      // SKU(옵션)별 판매 — SKU Order 탭 우선, 없으면 매출발생영상 SKU 열
      skus: (() => {
        const fromTab = skusForProduct(skuByDate, agg.date.key, x.id);
        const src = (fromTab && fromTab.length) ? fromTab : (vp && vp.skus ? vp.skus : []);
        return src.slice(0, 12).map(s => ({ sku: s.sku, pay: Math.round(s.pay), qty: Math.round(s.qty), cnt: Math.round(s.cnt) }));
      })()
    };
  });

  return {
    date: agg.date.label,
    prevDay: agg.prevDay ? agg.prevDay.md : null,
    prevWeek: agg.prevWeek ? agg.prevWeek.md : null,
    kpis: {
      gmv: Math.round(g.gmv), gmvDoD: agg.dd("gmv"), gmvWoW: agg.ww("gmv"),
      orders: Math.round(g.sku), ordersDoD: agg.dd("sku"), ordersWoW: agg.ww("sku"),
      buyers: Math.round(g.cust), buyersDoD: agg.dd("cust"),
      items: Math.round(g.items), aov: +(g.gmv / (g.sku || 1)).toFixed(2),
      adSpend: agg.cost ? Math.round(agg.cost.cur) : null,
      adSpendDoD: agg.cost ? agg.cost.dod : null,
      adProduct: agg.cost ? Math.round(agg.cost.product) : null,
      adLive: agg.cost ? Math.round(agg.cost.live) : null,
      roi: agg.roi ? +agg.roi.cur.toFixed(2) : null,
      roiPrev: agg.roi && agg.roi.prev != null ? +agg.roi.prev.toFixed(2) : null,
      convRate: g.uclk ? +(g.cust / g.uclk * 100).toFixed(2) : 0,
      impressions: Math.round(g.imp), clicks: Math.round(g.clk), visitors: Math.round(g.uclk),
      ctr: g.imp ? +(g.clk / g.imp * 100).toFixed(2) : 0,
      shopGmv: Math.round(g.shopGmv || 0)
    },
    series,
    channels: agg.channels.map(c => ({ name: c.t, gmv: Math.round(c.v), share: +c.share.toFixed(1), dod: c.dod, wow: c.wow })),
    channelDetail: { affVideo: Math.round(g.affVidG || 0), affLive: Math.round(g.affLiveG || 0), shopTab: Math.round(g.shopGmv || 0) },
    products,
    funnel: {
      impressions: Math.round(g.imp), clicks: Math.round(g.clk), visitors: Math.round(g.uclk),
      atc: Math.round(g.atc), orders: Math.round(g.sku), buyers: Math.round(g.cust),
      ctr: g.imp ? +(g.clk / g.imp * 100).toFixed(2) : 0,
      atcRate: g.clk ? +(g.atc / g.clk * 100).toFixed(2) : 0,
      orderConv: g.clk ? +(g.sku / g.clk * 100).toFixed(2) : 0,
      ctor: g.uclk ? +(g.cust / g.uclk * 100).toFixed(2) : 0,          // 방문→구매 (CVR)
      atcToOrder: g.atc ? +(g.sku / g.atc * 100).toFixed(2) : 0        // 장바구니→주문
    },
    creators: agg.creators,
    contentPerVideo: +(g.affVidG / (g.newVid || 1)).toFixed(2),
    contentPerLive: +(g.affLiveG / (g.newLive || 1)).toFixed(2),
    newVideos: Math.round(g.newVid || 0), newLives: Math.round(g.newLive || 0),
    // 매출발생영상 기반 콘텐츠/크리에이터 분석
    content: vid ? {
      date: vid.dateKey.label, lag: vid.key !== agg.date.key,
      totalPay: Math.round(vid.totalPay),
      org: vid.org, shop: vid.shop,
      mix: vid.contentMix,
      topCreators: vid.creatorList.slice(0, 20).map(c => ({
        ...c, link: c.topCid ? `https://www.tiktok.com/@${c.creator}/video/${c.topCid}` : null
      }))
    } : null,
    live: agg.live ? { sessions: agg.live, products: agg.liveProd, gmv: Math.round(agg.live.reduce((s, x) => s + x.gmv, 0)), viewers: agg.live.reduce((s, x) => s + x.viewers, 0), orders: agg.live.reduce((s, x) => s + x.ord, 0), minutes: agg.live.reduce((s, x) => s + x.min, 0) } : null,
    insights: ins
  };
}

module.exports = async (req, res) => {
  try {
    const isSlash = req.method === "POST" && req.body && (req.body.command || req.body.response_url);
    // 실행 보호 (슬래시 커맨드는 제외)
    const secret = process.env.CRON_SECRET;
    if (secret && !isSlash) {
      const auth = req.headers["authorization"] || "";
      const given = auth.replace(/^Bearer\s+/i, "") || (req.query && req.query.secret) || "";
      if (given !== secret) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    // 슬래시 커맨드: Slack 3초 제한 → 즉시 ACK하고 실제 작업은 자기 자신을 재호출(백그라운드)로 처리
    if (isSlash) {
      const day = String((req.body && req.body.text) || "").trim();
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const qs = "date=" + encodeURIComponent(day) + "&force=1" + (secret ? "&secret=" + encodeURIComponent(secret) : "");
      try {
        const trigger = fetch(`https://${host}/api/daily-report?${qs}`).catch(() => {});
        await Promise.race([trigger, new Promise(r => setTimeout(r, 600))]); // 요청 발사 보장
      } catch (e) { /* 무시 */ }
      res.status(200).json({ response_type: "ephemeral", text: `⏳ ${day || "최신일"} 리포트 생성 중… 곧 #데일리-분석 채널에 올라갑니다.` });
      return;
    }

    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("SHEET_ID 환경변수가 필요합니다.");
    const topN = Math.max(1, parseInt(process.env.TOP_N, 10) || DEFAULT_TOP_N);

    // 날짜 파라미터 (쿼리 ?date= 또는 슬래시 커맨드 text)
    const rawDate = (req.query && req.query.date) || (req.body && req.body.text) || "";
    const wantDate = parseDate(rawDate);

    const { google } = require("googleapis");
    // 인증: GOOGLE_SERVICE_ACCOUNT(JSON) 있으면 서비스계정(권장, 시트 공유만 하면 됨),
    //       없으면 기존 OAuth refresh token 사용
    let auth;
    if (process.env.GOOGLE_SERVICE_ACCOUNT) {
      const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
      auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
      });
    } else {
      const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
      auth = oauth2;
    }
    const sheets = google.sheets({ version: "v4", auth });

    // 탭 이름이 자주 바뀌므로 헤더 내용으로 자동 인식 (env 지정 시 그 값 우선)
    let rawSheet = process.env.RAW_SHEET, vidSheet = process.env.VIDEO_SHEET, adSheet = process.env.AD_SHEET, afSheet = process.env.AF_SHEET, liveSheet = process.env.LIVE_SHEET, skuSheet = process.env.SKU_SHEET;
    if (!rawSheet || !vidSheet || !adSheet || !afSheet || !liveSheet || !skuSheet) {
      const det = await resolveTabs(sheets, sheetId);
      rawSheet = rawSheet || det.raw;
      vidSheet = vidSheet || det.vid;
      adSheet = adSheet || det.ad;
      afSheet = afSheet || det.af;
      liveSheet = liveSheet || det.live;
      skuSheet = skuSheet || det.skuOrder;
    }
    if (!rawSheet) throw new Error("제품×일자 매출 탭(헤더에 'GMV range','Listing status')을 찾지 못했습니다.");
    if (!vidSheet) throw new Error("주문/콘텐츠 매출 탭(헤더에 'Content Type','Creator Username')을 찾지 못했습니다.");

    const ranges = [`'${rawSheet}'!A:GZ`, `'${vidSheet}'!A:AE`];
    const adIdx = adSheet ? ranges.push(`'${adSheet}'!A:J`) - 1 : -1;
    const afIdx = afSheet ? ranges.push(`'${afSheet}'!A:S`) - 1 : -1;
    const liveIdx = liveSheet ? ranges.push(`'${liveSheet}'!A:AD`) - 1 : -1;
    const skuIdx = skuSheet ? ranges.push(`'${skuSheet}'!A:Z`) - 1 : -1;
    const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId: sheetId, ranges });
    const vrs = resp.data.valueRanges;
    const rawRows = (vrs[0] && vrs[0].values) || [];
    const vidRows = (vrs[1] && vrs[1].values) || [];
    const adRows = (adIdx >= 0 && vrs[adIdx] && vrs[adIdx].values) || [];
    const afRows = (afIdx >= 0 && vrs[afIdx] && vrs[afIdx].values) || [];
    const liveRows = (liveIdx >= 0 && vrs[liveIdx] && vrs[liveIdx].values) || [];
    const skuRows = (skuIdx >= 0 && vrs[skuIdx] && vrs[skuIdx].values) || [];

    const raw = parseRaw(rawRows);
    const keys = Object.keys(raw.byDate).sort();
    if (!keys.length) throw new Error("매출raw 데이터가 없습니다.");
    const targetKey = wantDate ? wantDate.key : keys[keys.length - 1];

    const commByDate = parseCommissions(vidRows);
    let commCur = commByDate[targetKey];
    if (!commCur) { const ek = Object.keys(commByDate).filter(k => k <= targetKey).sort(); commCur = ek.length ? commByDate[ek[ek.length - 1]] : null; }
    const adByDate = parseAds(adRows);
    const agg = aggregate(raw, targetKey, topN, adByDate, commCur, parseAffiliate(afRows), parseLive(liveRows));
    const vid = aggregateVideos(parseVideos(vidRows), targetKey);
    const skuByDate = parseSkuOrders(skuRows);

    // 웹 대시보드용 구조화 JSON (?format=json)
    if (req.query && req.query.format === "json") {
      const withInsights = req.query.insights === "1";
      const ins = withInsights ? await generateInsights(agg, vid) : null;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).json(buildJson(agg, raw, adByDate, ins, vid, skuByDate));
      return;
    }

    const insights = await generateInsights(agg, vid);
    const mainText = buildMain(agg, insights);
    const chunks = videoChunks(vid, targetKey);

    const dryRun = req.query && (req.query.dryRun === "1" || req.query.dryRun === "true");
    if (dryRun) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ dryRun: true, date: agg.date.label, mainText, chunks });
      return;
    }

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("SLACK_BOT_TOKEN 환경변수가 필요합니다.");
    const channel = process.env.SLACK_CHANNEL || DEFAULT_CHANNEL;

    // 중복 방지: 자동(cron)이고 같은 날짜 리포트가 이미 채널에 있으면 건너뜀
    // (수동=슬래시(force=1)/?date=/?force=1 는 항상 게시)
    const isAuto = !wantDate && !isSlash && !(req.query && req.query.force);
    if (isAuto && await alreadyPosted(token, channel, agg.date.label)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ skipped: true, reason: "이미 게시됨", date: agg.date.label });
      return;
    }

    const sent = await postReport(token, channel, mainText, chunks);

    if (isSlash) {
      res.status(200).json({ response_type: "ephemeral", text: `✅ ${agg.date.label} 리포트를 채널에 게시했습니다.` });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, date: agg.date.label, sent });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (req.method === "POST") { res.status(200).json({ response_type: "ephemeral", text: "⚠️ " + msg }); return; }
    res.status(500).json({ error: msg });
  }
};

// 테스트용 내부 노출
module.exports._internals = { num, parseDate, parseRaw, parseAds, parseCommissions, parseAffiliate, parseLive, aggregate, parseVideos, aggregateVideos, buildMain, videoChunks, generateInsights, buildJson, parseSkuOrders, skusForProduct };
