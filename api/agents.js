// Vercel Serverless Function — 배포 경로: /api/agents
// 제품별 에이전트 10명 + 라이브 에이전트 1명이 하루 데이터를 분석한다.
//   GET  /api/agents?a=2026-11-12               → 에이전트 목록 + 그날 저장된 분석 결과
//   POST /api/agents?a=2026-11-12&agent=pro2x    → 그 에이전트 하나 실행 (저장된 결과가 있으면 그대로 반환, &force=1 이면 다시 실행)
// 에이전트 하나 = Claude 호출 하나. 페이지가 11개를 동시에 호출해 각각 별도 함수로 돈다.
// 데이터는 /api/why (원본 시트 + 광고 시트)를 전날·지난주 같은 요일과 비교해 두 번 읽는다.
// 결과는 Vercel Blob(agents/날짜/에이전트.json)에 저장해 다시 열 때 비용이 들지 않게 한다.
// 환경변수: ANTHROPIC_API_KEY (필수), DASHBOARD_PASSWORD (설정돼 있으면 실행 시 필요)
const SDK = require("@anthropic-ai/sdk");
const Anthropic = SDK.Anthropic || SDK.default || SDK;
const APIError = SDK.APIError;
const { put, get } = require("@vercel/blob");

const MODEL = "claude-opus-5-5";
const AGENTS = [
  { key: "grinding", name: "그라인딩", pid: "1732057536500110044" },
  { key: "pro2x", name: "PRO 2X", pid: "1729524572095485660" },
  { key: "firstgift", name: "퍼스트 기프트세트", pid: "1732090269393588956" },
  { key: "first", name: "퍼스트 본품", pid: "1732030444618027740" },
  { key: "borphyrin", name: "보르피린3종", pid: "1732356256385635036" },
  { key: "toneup", name: "톤업", pid: "1732057509504979676" },
  { key: "vita5", name: "비타 5종", pid: "1732268708636299996" },
  { key: "doubleline", name: "더블라인", pid: "1729492487438964444" },
  { key: "banban", name: "반반패드", pid: "1732397321053967068" },
  { key: "toneupholiday", name: "톤업 홀리데이 세트", pid: "1732779015968363228" },
  { key: "live", name: "라이브", live: true }
];

// ── 저장소 (lives.js와 같은 방식)
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(n => /BLOB_READ_WRITE_TOKEN$/i.test(n));
  return k ? process.env[k] : "";
}
const blobReady = () => !!(blobToken() || process.env.BLOB_STORE_ID);
const blobOpts = extra => { const o = Object.assign({}, extra || {}); const t = blobToken(); if (t) o.token = t; return o; };
const keyOf = (a, agent) => `agents/${a}/${agent}.json`;
async function load(a, agent) {
  if (!blobReady()) return null;
  try {
    const r = await get(keyOf(a, agent), blobOpts({ access: "private", useCache: false }));
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) { return null; }
}
async function save(a, agent, obj) {
  if (!blobReady()) return;
  await put(keyOf(a, agent), JSON.stringify(obj), blobOpts({ access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true }));
}

// ── 데이터
const addD = (k, n) => new Date(Date.parse(k + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
async function why(base, a, b) {
  const r = await fetch(`${base}/api/why?a=${a}&b=${b}&b2=${b}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}
const R = v => Math.round(v || 0);
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const pct = (x, y) => (y ? r2(x / y * 100) : null);
const roi = (g, s) => (s >= 1 ? r2(g / s) : null);
function grade(sa, ga) {
  if (sa < 3 && ga < 15) return null;
  if (sa < 1 && ga > 0) return "아주 좋음";
  const x = ga / sa; return x < 1 ? "KILL 검토" : x < 1.5 ? "주의" : x < 3 ? "좋음" : "아주 좋음";
}
function ageOf(posted, a) { if (!posted) return "오래된"; const d = (Date.parse(a) - Date.parse(posted)) / 86400000; return d <= 7 ? "신규" : d <= 30 ? "최근" : "오래된"; }
function funnel(s) {
  return { 매출: R(s.gmv), 상품노출: R(s.imp), 방문: R(s.uclk), "방문률%": pct(s.uclk, s.imp), 주문: R(s.orders), "전환율%": pct(s.orders, s.uclk), 판매개수: R(s.items), 객단가: r2(s.orders ? s.gmv / s.orders : null) };
}
const CH = s => ({ AF영상: R(s.cv), AF라이브: R(s.cl), 브랜드라이브: R(s.sl), 상품카드: R(s.pc), 셀러영상: R(s.sv) });

function productBrief(ag, d1, d7) {
  const a = d1.periods.a[0];
  const P = d1.products.find(p => p.id === ag.pid), P7 = d7.products.find(p => p.id === ag.pid);
  if (!P) return { 제품: ag.name, 데이터: "이 날 이 제품 데이터 없음" };
  const ads = side => (side ? { 광고비: R(side.spend), 광고매출: R(side.gmv), ROI: roi(side.gmv, side.spend) } : null);
  const C = d1.creatives.filter(c => c.pid === ag.pid);
  const C7 = Object.fromEntries(d7.creatives.filter(c => c.pid === ag.pid).map(c => [c.cid + c.camp, c]));
  const line = c => ({ 영상ID: c.cid, 크리에이터: c.creator ? "@" + c.creator : "미확인", 포스팅: c.posted, 나이: ageOf(c.posted, a), 광고비: [R(c.b.spend), R(c.a.spend)], 매출: [R(c.b.gmv), R(c.a.gmv)], 지난주같은요일매출: C7[c.cid + c.camp] ? R(C7[c.cid + c.camp].b.gmv) : null, 판정: grade(c.a.spend, c.a.gmv) });
  const age = {};
  for (const c of C) { const k = ageOf(c.posted, a); const e = age[k] || (age[k] = { 소재수: 0, 광고비: [0, 0], 매출: [0, 0] }); e.소재수++; e.광고비[0] += c.b.spend; e.광고비[1] += c.a.spend; e.매출[0] += c.b.gmv; e.매출[1] += c.a.gmv; }
  for (const k in age) { age[k].광고비 = age[k].광고비.map(R); age[k].매출 = age[k].매출.map(R); }
  const dg = c => c.a.gmv - c.b.gmv;
  const kill = C.filter(c => grade(c.a.spend, c.a.gmv) === "KILL 검토" && c.a.spend >= 5).sort((x, y) => y.a.spend - x.a.spend);
  const boost = C.filter(c => ["좋음", "아주 좋음"].includes(grade(c.a.spend, c.a.gmv)) && c.a.spend < 20).sort((x, y) => y.a.gmv - x.a.gmv);
  const creators = (d1.topCreators || []).filter(t => t.topProducts[0] && t.topProducts[0].pid === ag.pid).map(t => ({ 크리에이터: "@" + t.h, "30일매출": t.gmv, 최근7일: t.last7, 이전7일: t.prev7, "새영상7일": t.posts7, 마지막포스팅: t.lastPost }));
  const lv = P.live ? { 매출: [R(P.live.b.gmv), R(P.live.a.gmv)], 주문: [R(P.live.b.orders), R(P.live.a.orders)] } : null;
  const afl = d1.afLive.map(c => ({ h: c.h, b: (c.products.b || {})[ag.pid], a: (c.products.a || {})[ag.pid] })).filter(x => x.a || x.b).map(x => ({ 크리에이터: "@" + x.h, 매출: [R(x.b && x.b.pay), R(x.a && x.a.pay)] }));
  return {
    제품: ag.name, 전체제품명: P.name, 기준일: a, 비교: { 전날: d1.periods.b[0], 지난주같은요일: d7.periods.b[0] },
    "매출·퍼널 [전날, 기준일, 지난주같은요일]": { 전날: funnel(P.b), 기준일: funnel(P.a), 지난주같은요일: P7 ? funnel(P7.b) : null },
    "채널별매출 [전날, 기준일, 지난주같은요일]": { 전날: CH(P.b), 기준일: CH(P.a), 지난주같은요일: P7 ? CH(P7.b) : null },
    "가격 (AF 주문의 개당 판매가)": { 전날: P.price ? P.price.b : null, 기준일: P.price ? P.price.a : null, 지난주같은요일: P7 && P7.price ? P7.price.b : null },
    광고: { 전날: ads(P.ads && P.ads.b), 기준일: ads(P.ads && P.ads.a), 지난주같은요일: P7 && P7.ads ? ads(P7.ads.b) : null },
    "Target ROI 변경 (최근 기록, 제품명은 내부 약칭)": (d7.troi || []).filter(t => t.date >= addD(a, -14)).slice(-12),
    "광고 소재 나이별 [전날, 기준일]": age,
    "매출이 가장 오른 소재": C.filter(c => dg(c) > 0).sort((x, y) => dg(y) - dg(x)).slice(0, 6).map(line),
    "매출이 가장 빠진 소재": C.filter(c => dg(c) < 0).sort((x, y) => dg(x) - dg(y)).slice(0, 6).map(line),
    "새로 올라온 소재 (최근 7일 포스팅)": C.filter(c => ageOf(c.posted, a) === "신규").sort((x, y) => y.a.gmv - x.a.gmv).slice(0, 8).map(line),
    "KILL 검토 (기준일 ROI<1, 광고비≥$5)": { 개수: kill.length, 하루광고비합: R(kill.reduce((s, c) => s + c.a.spend, 0)), 상위: kill.slice(0, 5).map(line) },
    "부스팅 권장 (좋음 이상, 광고비<$20)": { 개수: boost.length, 상위: boost.slice(0, 5).map(line) },
    "이 제품이 주력인 TOP 크리에이터": creators.slice(0, 10),
    "브랜드 라이브에서 이 제품 [전날, 기준일]": lv,
    "AF 라이브에서 이 제품을 판 크리에이터 [전날, 기준일]": afl.slice(0, 8)
  };
}

function liveBrief(d1, d7) {
  const a = d1.periods.a[0];
  const agg = L => { const g = (L || []).filter(x => x.handle === "dalba_global"); const t = k => g.reduce((s, x) => s + (x[k] || 0), 0);
    const hrs = t("minutes") / 60; return g.length ? { 방송수: g.length, 방송시간: r2(hrs), 노출: R(t("impr")), "시간당노출": R(t("impr") / (hrs || 1)), 시청자: R(t("viewers")), "시청진입률%": pct(t("viewers"), t("impr")), 상품클릭: R(t("clicks")), "상품클릭률%": pct(t("clicks"), t("viewers")), 주문: R(t("orders")), "구매전환%": pct(t("orders"), t("clicks")), 매출: R(t("gmv")), 객단가: r2(t("gmv") / (t("orders") || 1)), 옥션매출: R(t("auction")), 방송: g.map(x => ({ 제목: x.title, 시작: x.start, 분: R(x.minutes), 매출: R(x.gmv) })) } : "방송 없음"; };
  const BL = d1.brandLive, BL7 = d7.brandLive;
  const dd = BL.daily; const last14 = dd ? dd.dates.slice(-14).map((k, i0) => { const i = dd.dates.length - 14 + i0; return { 날짜: k, 방송분: R(dd.minutes[i]), 노출: R(dd.impr[i]), 시청자: R(dd.viewers[i]), 클릭: R(dd.clicks[i]), 주문: R(dd.orders[i]), 매출: R(dd.gmv[i]) }; }) : null;
  const prods = d1.products.filter(p => p.live && (p.live.a.gmv || p.live.b.gmv)).sort((x, y) => y.live.a.gmv - x.live.a.gmv).slice(0, 12).map(p => ({ 제품: p.name.slice(0, 70), 매출: [R(p.live.b.gmv), R(p.live.a.gmv)], 주문: [R(p.live.b.orders), R(p.live.a.orders)], 판매개수: [R(p.live.b.items), R(p.live.a.items)] }));
  const nm = Object.fromEntries(d1.products.map(p => [p.id, p.name.slice(0, 50)]));
  const afl = d1.afLive.map(c => ({ c, d: ((c.a && c.a.gmv) || 0) - ((c.b && c.b.gmv) || 0) })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 15).map(({ c }) => ({
    크리에이터: "@" + c.h, "방송 [전날, 기준일]": [c.b ? `${c.b.sessions}회 ${r2(c.b.minutes / 60)}h` : "없음", c.a ? `${c.a.sessions}회 ${r2(c.a.minutes / 60)}h` : "없음"],
    "매출 [전날, 기준일]": [R(c.b && c.b.gmv), R(c.a && c.a.gmv)], 시청자: [R(c.b && c.b.viewers), R(c.a && c.a.viewers)],
    "기준일 판매 제품": Object.entries(c.products.a || {}).sort((x, y) => y[1].pay - x[1].pay).slice(0, 4).map(([pid, v]) => `${nm[pid] || pid} $${R(v.pay)} ${v.qty}개`) }));
  return {
    담당: "브랜드 라이브(dalba_global) + 어필리에이트 라이브", 기준일: a, 비교: { 전날: d1.periods.b[0], 지난주같은요일: d7.periods.b[0] },
    "스토어 라이브 매출 [전날, 기준일, 지난주같은요일]": { 브랜드라이브: [R(d1.store.b.sl), R(d1.store.a.sl), R(d7.store.b.sl)], AF라이브: [R(d1.store.b.cl), R(d1.store.a.cl), R(d7.store.b.cl)], 스토어전체: [R(d1.store.b.gmv), R(d1.store.a.gmv), R(d7.store.b.gmv)] },
    "브랜드 라이브 방송": { 전날: agg(BL.b), 기준일: agg(BL.a), 지난주같은요일: agg(BL7.b), "전날 방송이 없을 때 직전 방송": BL.b.length ? null : agg(BL.lastBeforeA) },
    "브랜드 라이브 최근 14일": last14,
    "브랜드 라이브 판매 제품 [전날, 기준일]": prods,
    "라이브 광고비 [전날, 기준일]": [R(d1.ads.b.liveSpend), R(d1.ads.a.liveSpend)],
    "AF 라이브 크리에이터 (증감 큰 순)": afl
  };
}

// ── Claude
const SYSTEM = `너는 d'Alba US 틱톡샵의 데일리 분석 에이전트다. 사용자 메시지의 JSON은 원본 시트(매출·퍼널·주문)와 광고 시트(GMV Max 캠페인·소재)에서 뽑은 하루치 데이터다. 기준일을 전날, 그리고 지난주 같은 요일과 비교해 실무자가 바로 행동할 수 있게 정리한다.

규칙
- 모든 숫자는 JSON에 있는 값만 쓴다. 계산한 값(증감, %)은 JSON 값으로 직접 계산한다. 없는 숫자를 만들지 않는다.
- 금액은 USD, "$1,234" 형식. 퍼센트는 소수 1자리.
- [전날, 기준일] 배열은 첫 값이 전날, 둘째 값이 기준일이다.
- 원인은 숫자로 확인되는 것만 단정한다. 추정이면 "추정"이라고 쓴다.
- 하루치는 흔들린다. 전날만 보고 판단하지 말고 지난주 같은 요일과 함께 본다.
- 광고 매출(GMV Max)은 해당 제품 전체 매출과 거의 같게 잡히는 지표다. ROI = 광고 매출 ÷ 광고비.
- 소재는 크리에이터 이름과 영상ID를 함께 적는다.
- 가격은 AF 주문의 개당 판매가 분포(points: 가격별 판매 개수)다. 가격대 비중이 바뀌었으면 할인·번들·쿠폰 변화로 본다.
- 데이터가 없거나 0이면 그렇다고 쓰고 그 칸은 짧게 끝낸다.
- 문장은 짧게. 각 칸 1~3문장. 한국어.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["headline", "verdict", "why", "video", "price", "ads", "live", "actions", "watch"],
  properties: {
    headline: { type: "string", description: "한 줄 결론. 매출 증감과 가장 큰 원인." },
    verdict: { type: "string", enum: ["up", "down", "flat"] },
    why: { type: "array", description: "매출이 움직인 원인, 영향 큰 순서로 최대 4개", items: { type: "object", additionalProperties: false, required: ["factor", "impact", "detail"], properties: { factor: { type: "string" }, impact: { type: "string", description: "예: +$420 또는 -12%" }, detail: { type: "string" } } } },
    video: { type: "string", description: "영상·광고 소재 변화 (신규 소재, 오른·빠진 소재). 라이브 에이전트는 방송 퍼널." },
    price: { type: "string", description: "판매가·객단가 변화" },
    ads: { type: "string", description: "광고비·ROI·Target ROI 변경" },
    live: { type: "string", description: "라이브 기여" },
    actions: { type: "array", description: "오늘 할 일 최대 3개. 대상(영상ID·크리에이터·캠페인)을 구체적으로.", items: { type: "string" } },
    watch: { type: "string", description: "주의해서 볼 신호. 없으면 빈 문자열." }
  }
};

async function runAgent(ag, brief) {
  const client = new Anthropic({ timeout: 240000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model: MODEL, max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `담당: ${ag.live ? "라이브 에이전트" : ag.name + " 에이전트"}\n\n${JSON.stringify(brief)}` }]
  });
  if (res.stop_reason === "refusal") throw new Error("분석이 거절되었습니다");
  if (res.stop_reason === "max_tokens") throw new Error("응답이 너무 길어 잘렸습니다");
  const txt = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { result: JSON.parse(txt), usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens || 0 }, model: res.model };
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const a = String(q.a || "");
  res.setHeader("Cache-Control", "no-store");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) { res.status(400).json({ error: "a=YYYY-MM-DD 날짜가 필요합니다" }); return; }
  if (req.method === "GET") {
    const saved = await Promise.all(AGENTS.map(g => load(a, g.key)));
    res.status(200).json({ date: a, agents: AGENTS.map((g, i) => ({ key: g.key, name: g.name, saved: saved[i] })), storage: blobReady() });
    return;
  }
  const ag = AGENTS.find(g => g.key === q.agent);
  if (!ag) { res.status(400).json({ error: "agent 값이 올바르지 않습니다" }); return; }
  if (!q.force) { const s = await load(a, ag.key); if (s) { res.status(200).json(s); return; } }
  const pw = process.env.DASHBOARD_PASSWORD;
  if (pw && (req.headers["x-dash-pw"] || q.pw) !== pw) { res.status(401).json({ error: "비밀번호가 필요합니다" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다" }); return; }
  try {
    const base = `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const [d1, d7] = await Promise.all([why(base, a, addD(a, -1)), why(base, a, addD(a, -7))]);
    if (!(d1.store.a.gmv > 0)) { res.status(409).json({ error: `${a} 매출 데이터가 아직 시트에 없습니다. 시트가 채워진 날짜를 고르세요.` }); return; }
    const brief = ag.live ? liveBrief(d1, d7) : productBrief(ag, d1, d7);
    const t0 = Date.now();
    const out = await runAgent(ag, brief);
    const P = !ag.live && d1.products.find(p => p.id === ag.pid);
    const kpi = ag.live
      ? { 매출: [R(d1.store.b.sl + d1.store.b.cl), R(d1.store.a.sl + d1.store.a.cl)], 브랜드라이브: [R(d1.store.b.sl), R(d1.store.a.sl)], AF라이브: [R(d1.store.b.cl), R(d1.store.a.cl)] }
      : P ? { 매출: [R(P.b.gmv), R(P.a.gmv)], 광고비: P.ads ? [R(P.ads.b.spend), R(P.ads.a.spend)] : null, ROI: P.ads ? [roi(P.ads.b.gmv, P.ads.b.spend), roi(P.ads.a.gmv, P.ads.a.spend)] : null, 판매가: P.price ? [P.price.b && P.price.b.avg, P.price.a && P.price.a.avg] : null } : null;
    const obj = { date: a, agent: ag.key, name: ag.name, kpi, ...out, ms: Date.now() - t0, at: new Date().toISOString() };
    await save(a, ag.key, obj).catch(() => {});
    res.status(200).json(obj);
  } catch (e) {
    const msg = APIError && e instanceof APIError ? `Claude API 오류 ${e.status}: ${e.message}` : String(e.message || e);
    res.status(500).json({ error: msg });
  }
};

module.exports._test = { productBrief, liveBrief, AGENTS };
