// Vercel Serverless Function — 배포 경로: /api/daily-report
// 구글시트(상품별 TikTok Shop 애널리틱스, 날짜별 1행씩 누적)를 읽어
// "데일리 매출 보고서"를 만들어 Slack에 게시한다.
//
// 보고서 구성(요청 사양):
//   1) 전일 총 GMV + 전일(DoD)/전주(WoW) 대비 증감
//   2) 상품 Top N 랭킹 (GMV 기준)
//   3) 채널별 분해 (Seller LIVE / Seller Video / Affiliate(Creator) / Product Card)
//   4) 전환 퍼널 (노출 → 클릭 → 장바구니 → 주문)
//
// 환경변수:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN  (Sheets readonly 스코프 필요)
//   SHEET_ID                  ← 대상 스프레드시트 ID (필수)
//   (선택) SHEET_RANGE        ← 기본 "A:BZ" (첫 시트)
//   (선택) TOP_N              ← Top 랭킹 개수, 기본 5
//   Slack 전송(둘 중 하나):
//     SLACK_BOT_TOKEN + SLACK_CHANNEL   ← chat.postMessage
//     SLACK_WEBHOOK_URL                 ← Incoming Webhook
//   (선택) CRON_SECRET        ← 설정 시 Authorization: Bearer <secret> 또는 ?secret= 일치해야 실행
//
// 사용:
//   GET /api/daily-report            → 집계 후 Slack 게시
//   GET /api/daily-report?dryRun=1   → 게시하지 않고 집계 결과 JSON만 반환(미리보기)

const DEFAULT_SHEET_RANGE = "A:BZ";
const DEFAULT_TOP_N = 5;
const DEFAULT_CHANNEL = "C0BB70T8VUG"; // README 기준 팀 채널

// ── 숫자/날짜 파서 ──────────────────────────────────────────────
// "1,729.49" / "3.43%" / "" → Number (실패 시 0)
function num(v) {
  if (v == null) return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
// "2026. 1. 2" / "2026.1.2" / "2026-01-02" → {key:"2026-01-02", ts} (실패 시 null)
function parseDate(v) {
  if (!v) return null;
  const m = String(v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ts = Date.UTC(y, mo - 1, d);
  const key = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { key, ts, label: `${y}. ${mo}. ${d}` };
}

// ── 컬럼 매핑 ──────────────────────────────────────────────────
// 헤더 이름으로 컬럼 인덱스를 찾되(첫 매칭, "All/" 접두어 무시),
// 못 찾으면 알려진 고정 인덱스로 폴백. (두 헤더 변형 모두 컬럼 순서는 동일)
const FIELD_DEFS = {
  date: { fallback: 0, names: ["date"] },
  name: { fallback: 1, names: ["product name"] },
  productId: { fallback: 2, names: ["product id"] },
  status: { fallback: 4, names: ["listing status"] },
  gmv: { fallback: 5, names: ["gmv"] },
  // 시트 네이티브 채널 그룹: 아래 4개 합이 GMV와 일치한다
  //   GMV = Seller LIVE-attributed + Seller video-attributed + Creator-attributed(=Affiliate) + Seller product card
  sellerLive: { fallback: 6, names: ["seller live-attributed gmv"] },
  sellerVideo: { fallback: 9, names: ["seller video-attributed gmv"] },
  affiliate: { fallback: 12, names: ["creator-attributed gmv"] },
  productCard: { fallback: 19, names: ["seller product card gmv"] },
  skuOrders: { fallback: 21, names: ["sku orders"] },
  impressions: { fallback: 25, names: ["product impressions"] },
  clicks: { fallback: 26, names: ["product clicks"] },
  atc: { fallback: 28, names: ["add-to-cart count"] }
};
function norm(s) {
  return String(s || "").replace(/^all\//i, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function buildColMap(headerRow) {
  const map = {};
  const normed = (headerRow || []).map(norm);
  for (const [field, def] of Object.entries(FIELD_DEFS)) {
    let idx = -1;
    for (const want of def.names) {
      idx = normed.indexOf(want);
      if (idx !== -1) break;
    }
    map[field] = idx !== -1 ? idx : def.fallback;
  }
  return map;
}
function looksLikeHeader(row) {
  const joined = norm((row || []).join(" "));
  return joined.includes("product name") && joined.includes("product id");
}

// ── 포맷 헬퍼 ──────────────────────────────────────────────────
function usd(n) {
  return "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function int(n) {
  return (Math.round(n || 0)).toLocaleString("en-US");
}
function pct(n) {
  return (n * 100).toFixed(2) + "%";
}
function delta(cur, prev) {
  if (!prev) return prev === 0 && cur > 0 ? "🆕" : "–";
  const r = (cur - prev) / prev;
  const arrow = r > 0 ? "🔺" : r < 0 ? "🔻" : "▪️";
  return `${arrow} ${(r >= 0 ? "+" : "")}${(r * 100).toFixed(1)}%`;
}

// ── 시트 → 집계 ────────────────────────────────────────────────
function aggregate(rows, topN) {
  if (!rows.length) throw new Error("시트에 데이터가 없습니다.");

  // 헤더 탐지 → 컬럼 매핑
  const headerRow = rows.find(looksLikeHeader);
  const col = buildColMap(headerRow);

  // 날짜 있는 데이터 행만 추출
  const data = [];
  for (const r of rows) {
    if (looksLikeHeader(r)) continue;
    const d = parseDate(r[col.date]);
    if (!d) continue;
    data.push({ d, r });
  }
  if (!data.length) throw new Error("날짜가 있는 데이터 행을 찾지 못했습니다.");

  // 날짜별 그룹
  const byDate = new Map(); // key → {date, rows[]}
  for (const { d, r } of data) {
    if (!byDate.has(d.key)) byDate.set(d.key, { date: d, rows: [] });
    byDate.get(d.key).rows.push(r);
  }
  const dates = [...byDate.values()].sort((a, b) => a.date.ts - b.date.ts);
  const latest = dates[dates.length - 1];

  // 비교 대상: 전일(직전 날짜), 전주(latest-7d에 가장 가까운 과거 날짜)
  const prevDay = dates[dates.length - 2] || null;
  const wowTarget = latest.date.ts - 7 * 86400000;
  let prevWeek = null, best = Infinity;
  for (const g of dates) {
    if (g === latest) continue;
    const diff = Math.abs(g.date.ts - wowTarget);
    if (diff < best) { best = diff; prevWeek = g; }
  }

  const sum = (g, field) => g.rows.reduce((a, r) => a + num(r[col[field]]), 0);
  const totalGmv = g => sum(g, "gmv");

  // 채널 분해(최신일)
  const channels = {
    "Seller LIVE": sum(latest, "sellerLive"),
    "Seller Video": sum(latest, "sellerVideo"),
    "Affiliate (Creator)": sum(latest, "affiliate"),
    "Product Card": sum(latest, "productCard")
  };

  // 전환 퍼널(최신일 합계)
  const impressions = sum(latest, "impressions");
  const clicks = sum(latest, "clicks");
  const atc = sum(latest, "atc");
  const orders = sum(latest, "skuOrders");
  const funnel = {
    impressions, clicks, atc, orders,
    ctr: impressions ? clicks / impressions : 0,
    atcRate: clicks ? atc / clicks : 0,
    ctor: clicks ? orders / clicks : 0
  };

  // Top N 상품
  const top = latest.rows
    .map(r => ({
      name: String(r[col.name] || "").trim(),
      status: String(r[col.status] || "").trim(),
      gmv: num(r[col.gmv]),
      orders: num(r[col.skuOrders])
    }))
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, topN);

  return {
    latest: latest.date,
    prevDay: prevDay ? { label: prevDay.date.label, gmv: totalGmv(prevDay) } : null,
    prevWeek: prevWeek ? { label: prevWeek.date.label, gmv: totalGmv(prevWeek) } : null,
    totalGmv: totalGmv(latest),
    productCount: latest.rows.length,
    channels,
    funnel,
    top
  };
}

// ── Slack Block Kit 메시지 ─────────────────────────────────────
function buildBlocks(a) {
  const dod = a.prevDay ? delta(a.totalGmv, a.prevDay.gmv) : "–";
  const wow = a.prevWeek ? delta(a.totalGmv, a.prevWeek.gmv) : "–";

  const channelLines = Object.entries(a.channels)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => {
      const share = a.totalGmv ? (v / a.totalGmv) * 100 : 0;
      return `• ${k}: *${usd(v)}* (${share.toFixed(1)}%)`;
    })
    .join("\n");

  const f = a.funnel;
  const funnelText =
    `• 노출 *${int(f.impressions)}*\n` +
    `• 클릭 *${int(f.clicks)}*  (CTR ${pct(f.ctr)})\n` +
    `• 장바구니 *${int(f.atc)}*  (클릭→장바구니 ${pct(f.atcRate)})\n` +
    `• 주문(SKU) *${int(f.orders)}*  (클릭→주문 ${pct(f.ctor)})`;

  const medal = ["🥇", "🥈", "🥉"];
  const topText = a.top
    .map((p, i) => {
      const tag = medal[i] || `${i + 1}.`;
      const nm = p.name.length > 70 ? p.name.slice(0, 67) + "…" : p.name;
      return `${tag} *${usd(p.gmv)}* · ${int(p.orders)}주문\n   ${nm}`;
    })
    .join("\n");

  return [
    { type: "header", text: { type: "plain_text", text: `📊 d'Alba 데일리 매출 — ${a.latest.label}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*총 GMV*\n${usd(a.totalGmv)}` },
        { type: "mrkdwn", text: `*상품 수*\n${int(a.productCount)}개` },
        { type: "mrkdwn", text: `*전일 대비 (DoD)*\n${dod}${a.prevDay ? ` (${usd(a.prevDay.gmv)})` : ""}` },
        { type: "mrkdwn", text: `*전주 대비 (WoW)*\n${wow}${a.prevWeek ? ` (${usd(a.prevWeek.gmv)})` : ""}` }
      ]
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*🏆 상품 Top ${a.top.length}*\n${topText}` } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*🔀 채널별 GMV*\n${channelLines}` } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*🛒 전환 퍼널*\n${funnelText}` } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `자동 생성 · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` }]
    }
  ];
}

// ── Slack 전송 ─────────────────────────────────────────────────
async function postToSlack(blocks, fallbackText) {
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;

  if (token) {
    const channel = process.env.SLACK_CHANNEL || DEFAULT_CHANNEL;
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text: fallbackText, blocks })
    });
    const data = await r.json();
    if (!data.ok) throw new Error("Slack 오류: " + data.error);
    return { via: "bot", channel, ts: data.ts };
  }

  if (webhook) {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: fallbackText, blocks })
    });
    if (!r.ok) throw new Error("Slack webhook 오류: HTTP " + r.status);
    return { via: "webhook" };
  }

  throw new Error("Slack 설정이 없습니다. SLACK_BOT_TOKEN(+SLACK_CHANNEL) 또는 SLACK_WEBHOOK_URL 을 설정하세요.");
}

module.exports = async (req, res) => {
  try {
    // 실행 보호(설정 시): Vercel Cron 은 Authorization: Bearer <CRON_SECRET> 를 보냄
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers["authorization"] || "";
      const given = auth.replace(/^Bearer\s+/i, "") || (req.query && req.query.secret) || "";
      if (given !== secret) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("SHEET_ID 환경변수가 필요합니다.");
    const range = process.env.SHEET_RANGE || DEFAULT_SHEET_RANGE;
    const topN = Math.max(1, parseInt(process.env.TOP_N, 10) || DEFAULT_TOP_N);

    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING"
    });
    const rows = resp.data.values || [];

    const agg = aggregate(rows, topN);
    const blocks = buildBlocks(agg);
    const fallback = `📊 d'Alba 데일리 매출 ${agg.latest.label} — 총 GMV ${usd(agg.totalGmv)}`;

    const dryRun = req.query && (req.query.dryRun === "1" || req.query.dryRun === "true");
    if (dryRun) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ dryRun: true, aggregate: agg, fallback, blocks });
      return;
    }

    const sent = await postToSlack(blocks, fallback);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, sent, date: agg.latest.label, totalGmv: agg.totalGmv });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// 테스트용 내부 함수 노출 (배포 동작에는 영향 없음)
module.exports._internals = { num, parseDate, buildColMap, looksLikeHeader, aggregate, buildBlocks, usd, pct };
