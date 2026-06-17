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
const DEFAULT_TOP_N = 10;
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
const V = { date: 0, pid: 2, pname: 3, pay: 6, creator: 12, ctype: 13, cid: 14 };

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
      const p = prod[d.key][id] || (prod[d.key][id] = { name: clean(r[R.name]), gmv: 0, sku: 0 });
      p.gmv += num(r[R.gmv]); p.sku += num(r[R.sku]);
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
function aggregate(raw, targetKey, topN) {
  const { byDate, prod } = raw;
  if (!byDate[targetKey]) throw new Error("해당 날짜 데이터가 없습니다: " + targetKey);
  const cur = byDate[targetKey], g = cur.t;
  const { prevDay, prevWeek } = pickComparisons(byDate, targetKey);
  const p = prevDay ? prevDay.t : null, w = prevWeek ? prevWeek.t : null;
  const dd = (k) => p ? sg(pct(g[k], p[k])) : "–";
  const ww = (k) => w ? sg(pct(g[k], w[k])) : "–";

  const channels = [
    ["Affiliate(크리에이터)", "affiliate"], ["Product Card", "productCard"],
    ["Seller Video", "sellerVideo"], ["Seller LIVE", "sellerLive"]
  ].map(([t, k]) => ({ t, v: g[k], share: g.gmv ? g[k] / g.gmv * 100 : 0, dod: dd(k), wow: ww(k) }));

  const prodCur = prod[targetKey];
  const totGmv = Object.values(prodCur).reduce((s, x) => s + x.gmv, 0);
  const prodPrev = prevDay ? prod[prevDay.date.key] : {}, prodW = prevWeek ? prod[prevWeek.date.key] : {};
  const ddp = (a, b) => (b ? sg((a - b) / b * 100) : (a > 0 ? "신규" : "–"));
  const top = Object.entries(prodCur).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.gmv - a.gmv).slice(0, topN)
    .map(x => ({
      ...x, share: totGmv ? x.gmv / totGmv * 100 : 0,
      dod: ddp(x.gmv, prodPrev[x.id] && prodPrev[x.id].gmv),
      wow: ddp(x.gmv, prodW[x.id] && prodW[x.id].gmv),
      pSku: prodPrev[x.id] ? prodPrev[x.id].sku : 0
    }));
  const topShare = top.reduce((s, x) => s + x.gmv, 0);

  return {
    date: cur.date, g, p, w,
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
  const prod = {};
  for (const r of rows) {
    const pk = r[V.pid] || r[V.pname];
    const p = prod[pk] || (prod[pk] = { name: clean(r[V.pname]), pay: 0, items: {} });
    p.pay += num(r[V.pay]);
    const ck = r[V.ctype] + "|" + r[V.cid] + "|" + r[V.creator];
    const it = p.items[ck] || (p.items[ck] = { type: r[V.ctype], cid: r[V.cid], creator: r[V.creator], pay: 0, c: 0 });
    it.pay += num(r[V.pay]); it.c++;
  }
  const plist = Object.values(prod)
    .map(p => ({ ...p, items: Object.values(p.items).sort((a, b) => b.pay - a.pay) }))
    .sort((a, b) => b.pay - a.pay);
  const totalPay = rows.reduce((s, r) => s + num(r[V.pay]), 0);
  const videoPay = rows.filter(r => r[V.ctype] === "Video").reduce((s, r) => s + num(r[V.pay]), 0);
  return { dateKey: parseDate(useKey), key: useKey, plist, totalPay, videoPay };
}

// ── AI 인사이트 한줄평 (ANTHROPIC_API_KEY 있을 때만) ───────────
async function generateInsights(a, vid) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const g = a.g, topVid = vid && vid.plist[0];
  const ctx = {
    날짜: a.date.label,
    GMV: { 당일: Math.round(g.gmv), 전일: a.p ? Math.round(a.p.gmv) : null, 전주: a.w ? Math.round(a.w.gmv) : null, DoD: a.dd("gmv"), WoW: a.ww("gmv") },
    채널: a.channels.map(c => ({ 채널: c.t, GMV: Math.round(c.v), 비중: +c.share.toFixed(1), DoD: c.dod, WoW: c.wow })),
    제품TOP: a.top.map(x => ({ 제품: x.name.slice(0, 40), GMV: Math.round(x.gmv), DoD: x.dod, WoW: x.wow, 주문: x.sku })),
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
    "(3) 하락/이상 신호엔 추정 원인이나 액션 1개 덧붙이기, (4) 각 문장 60자 내외.\n" +
    "출력은 JSON만: {\"overview\":\"\",\"channel\":\"\",\"product\":\"\",\"content\":\"\",\"funnel\":\"\"}\n\n" +
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
  o += tip("overview") + `\n`;
  // 2
  o += `*2. 채널별 매출* _(귀속 기준, 합 100%)_\n`;
  for (const c of a.channels)
    o += `• ${c.t} *${money(c.v)}* (${c.share.toFixed(1)}%) · DoD ${c.dod} / WoW ${c.wow}\n`;
  o += `   └ Affiliate 내부: Video ${money(g.affVidG)} · LIVE ${money(g.affLiveG)}  |  오가닉 스토어탭 ${money(g.shopGmv)}\n`;
  o += tip("channel") + `\n`;
  // 3
  o += `*3. 제품별 매출 TOP ${a.top.length}* _(TOP${a.top.length} = 전체의 ${(a.totGmv ? a.topShare / a.totGmv * 100 : 0).toFixed(0)}%)_\n`;
  o += "```\n#   GMV     DoD    WoW    주문  제품\n";
  a.top.forEach((x, i) => {
    o += `${String(i + 1).padStart(2)}  ${money(x.gmv).padStart(6)}  ${x.dod.padStart(5)}  ${x.wow.padStart(5)}  ${(x.sku + "(" + x.pSku + ")").padStart(6)}  ${x.name.slice(0, 30)}\n`;
  });
  o += "```\n";
  o += tip("product") + `\n`;
  // 4
  o += `*4. 크리에이터·콘텐츠 효율*\n`;
  o += `• 신규 영상 ${g.newVid}건 · 라이브 ${g.newLive}건\n`;
  o += `• 영상 1건당 매출 *$${(g.affVidG / (g.newVid || 1)).toFixed(2)}*`;
  o += a.p ? ` (전일 $${(a.p.affVidG / (a.p.newVid || 1)).toFixed(2)}${a.w ? ` / 전주 $${(a.w.affVidG / (a.w.newVid || 1)).toFixed(2)}` : ""})\n` : `\n`;
  o += `• 라이브 1건당 $${(g.affLiveG / (g.newLive || 1)).toFixed(2)}\n`;
  o += tip("content") + `\n`;
  // 5
  o += `*5. 전환 퍼널*\n`;
  o += `노출 ${g.imp.toLocaleString()} → 클릭 ${g.clk.toLocaleString()} (CTR ${ratePct(g.clk, g.imp)}) → 장바구니 ${Math.round(g.atc)} (장바구니율 ${ratePct(g.atc, g.clk)}) → 주문 ${Math.round(g.sku)} (주문전환 ${ratePct(g.sku, g.clk)})\n`;
  if (a.w && a.p)
    o += `• 장바구니율 추이 ${a.prevWeek.md}→${a.prevDay.md}→${a.date.md}: ${ratePct(a.w.atc, a.w.clk)} → ${ratePct(a.p.atc, a.p.clk)} → ${ratePct(g.atc, g.clk)}\n`;
  o += tip("funnel");
  return o;
}

function videoChunks(v, reportDate) {
  if (!v) return [];
  const note = v.key !== reportDate ? `  ⚠️ _(영상 데이터는 ${v.dateKey.label} 기준)_` : "";
  let header = `*📹 6. 매출 발생 영상 (제품별 · ${v.dateKey.label})*${note}\n> 콘텐츠 귀속 매출 ${money(v.totalPay)} · 영상 ${money(v.videoPay)} / 제품 ${v.plist.length}개\n\n`;
  const blocks = v.plist.map(pr => {
    let b = `*${money(pr.pay)} — ${pr.name.slice(0, 70)}* _(${pr.items.length}콘텐츠)_\n`;
    for (const it of pr.items) {
      if (it.type === "Video") {
        const link = `https://www.tiktok.com/@${it.creator}/video/${it.cid}`;
        b += `• ${money(it.pay)} · ${it.c}건 · <${link}|@${it.creator}> \`${it.cid}\`\n`;
      } else {
        b += `• ${money(it.pay)} · ${it.c}건 · @${it.creator} _(${it.type})_\n`;
      }
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

    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("SHEET_ID 환경변수가 필요합니다.");
    const rawSheet = process.env.RAW_SHEET || "매출raw";
    const vidSheet = process.env.VIDEO_SHEET || "매출발생영상";
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

    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: [`'${rawSheet}'!A:GZ`, `'${vidSheet}'!A:AE`]
    });
    const rawRows = (resp.data.valueRanges[0] && resp.data.valueRanges[0].values) || [];
    const vidRows = (resp.data.valueRanges[1] && resp.data.valueRanges[1].values) || [];

    const raw = parseRaw(rawRows);
    const keys = Object.keys(raw.byDate).sort();
    if (!keys.length) throw new Error("매출raw 데이터가 없습니다.");
    const targetKey = wantDate ? wantDate.key : keys[keys.length - 1];

    const agg = aggregate(raw, targetKey, topN);
    const vid = aggregateVideos(parseVideos(vidRows), targetKey);
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
module.exports._internals = { num, parseDate, parseRaw, aggregate, parseVideos, aggregateVideos, buildMain, videoChunks, generateInsights };
