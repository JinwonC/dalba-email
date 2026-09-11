// api/ask.js — PID 선택 + 자연어 질문 → 매출 데이터 근거로 Claude가 원인 분석
//
// 사용:
//   POST /api/ask   body: { pid, question, date?, model? }
//   GET  /api/ask?pid=...&question=...&date=...
//
// 동작:
//   1) /api/daily-report?format=json[&date=] 를 self-fetch 하여 해당 제품의
//      일별 시계열(매출/방문/전환/객단가/광고비/ROI/오가닉·샵애즈/영상·샘플),
//      매출 상위 소재, 채널별 매출을 추출
//   2) 숫자는 코드가 미리 계산(파생 CVR/AOV)하여 Claude에 "정답"으로 제공
//   3) Claude가 데이터만 근거로 질문에 답변 (환각 방지)
//
// 환경변수: ANTHROPIC_API_KEY (필수), (선택) ASK_MODEL

const FOCUS = {
  "1732030444618027740": "퍼스트 본품",
  "1732090269393588956": "퍼스트 기프트세트",
  "1732057509504979676": "톤업선크림",
  "1732057536500110044": "보르피린 그라인딩크림",
  "1732268708636299996": "오버나이트 비타세트(비타라인)",
  "1729492487438964444": "글로우&리프트 세트(더블라인)",
  "1732356256385635036": "Age Less 세트",
};

function readJson(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// 같은 배포의 API 핸들러를 HTTP 없이 in-process로 실행해 JSON을 받는다
// (self-fetch의 캐시·타임아웃·abort 이슈 제거)
const dailyHandler = require("./daily-report");
const adsHandler = require("./ads-report");
function callApi(handler, query) {
  return new Promise((resolve) => {
    const req = { method: "GET", query, headers: {} };
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve(o); },
      send(o) { resolve(o); },
      end() { resolve(null); },
    };
    Promise.resolve().then(() => handler(req, res)).catch((e) => resolve({ error: String((e && e.message) || e) }));
  });
}

module.exports = async (req, res) => {
  try {
    const q = req.method === "POST" ? await readJson(req) : (req.query || {});
    const pid = String(q.pid || "").trim();
    const question = String(q.question || "").trim();
    const date = String(q.date || "").trim();
    if (!pid || !question) { res.status(400).json({ error: "pid·question 필요" }); return; }

    const gemKey = process.env.GEMINI_API_KEY;
    const antKey = process.env.ANTHROPIC_API_KEY;
    // 우선순위: 요청에서 provider 지정 > Gemini 키 있으면 Gemini > Anthropic
    const provider = q.provider || (gemKey ? "gemini" : (antKey ? "anthropic" : null));
    if (!provider) { res.status(500).json({ error: "API 키 미설정 (GEMINI_API_KEY 또는 ANTHROPIC_API_KEY)" }); return; }
    if (provider === "gemini" && !gemKey) { res.status(500).json({ error: "GEMINI_API_KEY 미설정" }); return; }
    if (provider === "anthropic" && !antKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY 미설정" }); return; }

    // 1) 매출 데이터 + 광고 소재 데이터를 in-process 병렬 실행 (HTTP self-fetch 없이)
    const dailyQuery = { format: "json" };
    if (date) dailyQuery.date = date;
    const adsQuery = { pw: process.env.DASHBOARD_PASSWORD || "" };
    const adProm = callApi(adsHandler, adsQuery); // 병렬 시작
    let dr = await callApi(dailyHandler, dailyQuery);
    if (!dr || dr.error) { res.status(502).json({ error: "매출 데이터 오류: " + (dr && dr.error) }); return; }

    const p = (dr.products || []).find((x) => x.id === pid);
    if (!p) { res.status(404).json({ error: "해당 제품(PID) 데이터를 찾지 못했습니다" }); return; }

    // 2) 파생 지표 미리 계산 (Claude는 계산 말고 해석만)
    const daily = (p.series || []).slice(-40).map((s) => ({
      날짜: s.date,
      매출: Math.round(s.gmv || 0),
      방문: Math.round(s.uclk || 0),
      "전환율%": s.uclk ? +((s.orders / s.uclk) * 100).toFixed(2) : 0,
      객단가: s.orders ? +(s.gmv / s.orders).toFixed(2) : 0,
      광고비: Math.round(s.cost || 0),
      ROI: +(s.roi || 0).toFixed(2),
      오가닉: Math.round(s.org || 0),
      샵애즈: Math.round(s.shop || 0),
      영상발행: s.newVid || 0,
      샘플: s.samples || 0,
    }));
    // 캠페인명 → 제품(PID) 매칭 (광고 시트엔 PID가 없어 캠페인명으로 필터)
    const CAMP = {
      "1732030444618027740": (c) => /first\(100\)/i.test(c) && !/번들|bundle|set|세트|퍼스트\+/i.test(c),
      "1732090269393588956": (c) => /번들|bundle|3번들|퍼스트\s*\+|first\(100\).*(번들|set)/i.test(c),
      "1732057509504979676": (c) => /톤업|tone.?up/i.test(c),
      "1732057536500110044": (c) => /그라인딩|보르피린|volufiline|grinding/i.test(c),
      "1732268708636299996": (c) => /비타|오버나이트|vita|overnight/i.test(c),
      "1729492487438964444": (c) => /더블|글로우|더블라인|glow|double/i.test(c),
      "1732356256385635036": (c) => /age\s*less|ageless|에이지리스|리프트\s*모어/i.test(c),
    };
    const match = CAMP[pid];

    const sumArr = (a, s, e) => (Array.isArray(a) ? a.slice(s, e).reduce((x, y) => x + (y || 0), 0) : 0);
    const pctChg = (now, prev) => (prev ? Math.round((now / prev - 1) * 100) : (now ? null : 0));
    const mkLink = (id, creator) => (id ? `https://www.tiktok.com/@${creator || "tiktok"}/video/${id}` : null);

    // AF 매출귀속(오가닉/샵애즈)을 cid로 조인 (같은 cid가 여러 행이면 합산)
    const revByCid = {};
    for (const v of (p.revVideos || [])) {
      if (!v.cid) continue;
      const r = revByCid[v.cid] || (revByCid[v.cid] = { pay: 0, org: 0, shop: 0, creator: v.creator, type: v.type });
      r.pay += v.pay || 0; r.org += v.org || 0; r.shop += v.shop || 0;
    }

    // 소재별 광고 성과 — 추세·품질지표·오가닉조인까지 깊게 (광고 시트 광고소재성과)
    let adByCid = null, adErr = null, prodCreatives = [];
    try {
      const ad = await adProm; // 위에서 병렬로 시작한 광고 페치
      const adList = ad && (ad.creatives || ad.list);
      if (ad && ad.error) { adErr = ad.error; }
      else if (Array.isArray(adList)) {
        adByCid = {};
        for (const c of adList) {
          if (c.isPC || !c.id) continue;
          const spend = (c.cum && c.cum.spend) || 0;
          const a = adByCid[c.id] || (adByCid[c.id] = { 누적광고비: 0, 최근7일광고비: 0, 광고ROI: null, 판정: null, _max: -1 });
          a.누적광고비 += spend;
          a.최근7일광고비 += c.last7 || 0;
          if (spend > a._max) { a._max = spend; a.판정 = c.badge || a.판정; if (c.cum && c.cum.roi != null) a.광고ROI = c.cum.roi; }
          // 이 제품 캠페인에 속하는 소재 → 상세 지표 구성
          if (match && match(c.camp || "")) {
            const g = c.sparkG || [], s = c.spark || [], n = g.length;
            const gmv7 = sumArr(g, n - 7, n), gmvPrev7 = sumArr(g, n - 14, n - 7);
            const sp7 = c.last7 || 0, spPrev7 = c.prev7 || 0;
            const d = c.detail || {}, cum = c.cum || {}, rv = revByCid[c.id];
            // 광고 on/off 상태 + 휴지기 + 전성기(최고 7일 롤링 ROI) 도출
            let lastSpendIdx = -1;
            for (let i = n - 1; i >= 0; i--) { if ((s[i] || 0) > 0.5) { lastSpendIdx = i; break; } }
            const 중단후경과일 = lastSpendIdx >= 0 ? (n - 1 - lastSpendIdx) : null;
            let peakRoi = null, peakGmv = 0;
            for (let i = 0; i + 7 <= n; i++) {
              const ws = sumArr(s, i, i + 7), wg = sumArr(g, i, i + 7);
              if (ws >= 20) { const r = wg / ws; if (peakRoi == null || r > peakRoi) { peakRoi = +r.toFixed(2); peakGmv = Math.round(wg); } }
            }
            const 잔존매출 = Math.round(gmv7 + (rv ? (rv.org || 0) + (rv.shop || 0) : 0));
            let 광고상태;
            if (sp7 >= 5) 광고상태 = "집행중";
            else if (spend >= 50 && 잔존매출 > 0) 광고상태 = "휴면(광고중단·잔존매출有)";
            else if (spend >= 50) 광고상태 = "휴면(광고중단)";
            else 광고상태 = "지출미미";
            prodCreatives.push({
              크리에이터: c.creator || "(미상)",
              캠페인: c.camp,
              링크: c.link || mkLink(c.id, c.creator),
              판정: c.badge || "-",
              신뢰도: c.confidence || null,
              광고상태,
              광고중단_경과일: 광고상태.startsWith("휴면") ? 중단후경과일 : null,
              누적: { 광고비: Math.round(spend), GMV: Math.round(cum.gmv || 0), ROI: cum.roi != null ? cum.roi : null, 주문: cum.orders || 0, 전환율퍼센트: cum.cvr != null ? cum.cvr : null },
              전성기_최고7일: { ROI: peakRoi, GMV: peakGmv },
              최근7일: { 광고비: Math.round(sp7), GMV: Math.round(gmv7), ROI: sp7 ? +(gmv7 / sp7).toFixed(2) : null, 잔존매출_광고AF합: 잔존매출 },
              직전7일: { 광고비: Math.round(spPrev7), GMV: Math.round(gmvPrev7), ROI: spPrev7 ? +(gmvPrev7 / spPrev7).toFixed(2) : null },
              추세: { 광고비증감퍼센트: pctChg(sp7, spPrev7), GMV증감퍼센트: pctChg(gmv7, gmvPrev7) },
              소재품질: { 훅2초율: d.v2s, 훅6초율: d.v6s, 완주50율: d.v50, 완주100율: d.v100, CTR: d.ctr, 전환율퍼센트: d.cvr },
              일별_최근10일: { 광고비: s.slice(-10).map((x) => Math.round(x || 0)), GMV: g.slice(-10).map((x) => Math.round(x || 0)) },
              AF매출귀속: rv ? { 오가닉: Math.round(rv.org), 샵애즈: Math.round(rv.shop) } : null,
            });
          }
        }
        prodCreatives = prodCreatives
          .sort((a, b) => (b.최근7일.GMV - a.최근7일.GMV) || (b.누적.광고비 - a.누적.광고비))
          .slice(0, 15);
      }
    } catch (e) { adErr = e.message; }

    // 오가닉(광고 미집행/미미) 상위 소재 — AF 매출귀속 기준, 증액 후보 발굴용
    const oganicVids = (p.revVideos || [])
      .filter((v) => v.cid && (v.pay || 0) > 0)
      .map((v) => {
        const a = adByCid && adByCid[v.cid];
        return {
          크리에이터: v.creator,
          매출: Math.round(v.pay || 0),
          오가닉: Math.round(v.org || 0),
          샵애즈: Math.round(v.shop || 0),
          누적광고비: a ? Math.round(a.누적광고비) : 0,
          링크: v.link || mkLink(v.cid, v.creator),
        };
      })
      .filter((v) => v.누적광고비 < 10)
      .sort((a, b) => b.매출 - a.매출)
      .slice(0, 10);

    const channels = (p.channels || []).map((c) => ({ 채널: c.name, 매출: Math.round(c.v || 0) }));

    // 소재 편중도 요약 (최근7일 GMV 기준)
    const g7Total = prodCreatives.reduce((s, c) => s + (c.최근7일.GMV || 0), 0);
    const g7Sorted = [...prodCreatives].sort((a, b) => b.최근7일.GMV - a.최근7일.GMV);
    const share = (n) => (g7Total ? Math.round(g7Sorted.slice(0, n).reduce((s, c) => s + c.최근7일.GMV, 0) / g7Total * 100) : null);
    const badgeCount = prodCreatives.reduce((o, c) => { o[c.판정] = (o[c.판정] || 0) + 1; return o; }, {});

    const ctx = {
      제품명: p.name,
      제품별칭: FOCUS[pid] || null,
      데이터_기준일: dr.date,
      일별_지표_최근40일: daily,
      광고소재_상세_최근GMV순: prodCreatives,
      오가닉_상위_소재_광고미집행: oganicVids,
      소재_편중도: { 광고소재수: prodCreatives.length, 최근7일GMV합: Math.round(g7Total), 상위1소재_비중퍼센트: share(1), 상위3소재_비중퍼센트: share(3), 판정분포: badgeCount },
      채널별_매출_기준일: channels,
      주의:
        "소재품질 지표(훅2초율/6초율/완주50·100율/CTR/전환율)는 광고 노출 기준 비율이며 소재가 '왜 되는지/안 되는지'의 핵심 근거다. " +
        "'광고소재_상세'의 GMV는 광고귀속(AF Video+프로덕트카드), '오가닉_상위_소재'의 매출은 AF 매출귀속(오가닉+샵애즈)로 기준이 다름을 명시. " +
        "판정(누적 라이프타임 기준): BOOST=증액 후보 / KILL=중단 / 피로=신규교체 / 관찰중 / 게이트탈락(지출<$10). 신뢰도: 판정불가(<$50)·예비(<$100)·확정. " +
        "'광고상태'는 현재 on/off(집행중/휴면/지출미미)이며 판정과 별개다. '광고중단_경과일'=마지막 지출 이후 경과일. " +
        "'전성기_최고7일'=최근30일 내 최고 7일 롤링 ROI/GMV(과거 얼마나 잘 팔렸나). '최근7일.잔존매출_광고AF합'=광고 꺼도 나오는 매출(재점화 판단 핵심). " +
        "최신 1~2일은 AF 탭 지연으로 오가닉/샵애즈가 비어있을 수 있음." +
        (adErr ? " (⚠️ 광고 소재 데이터 로드 실패: " + adErr + " — 이 경우 소재 분석은 생략하고 나머지로 답하되 실패 사실은 언급하지 말 것)" : ""),
    };

    const sys =
      "너는 d'Alba 미국 틱톡샵의 소재(크리에이터 영상) 분석 전문가다. 아래 JSON 데이터만 근거로, 소재를 '하나하나' 깊게 뜯어 분석한다. 나열은 금지 — 각 소재가 왜 되는지/안 되는지와 다음 액션까지 말한다.\n\n" +
      "[소재 분석 방법 — 소재/매출 원인 질문이면 반드시 이 깊이로]\n" +
      "1) 큰 그림: '소재_편중도'로 상위 1·3소재가 최근7일 GMV의 몇 %인지(편중 위험), 판정분포(BOOST/관찰/피로/KILL 몇 개)를 먼저 짚는다.\n" +
      "2) 소재별 해부 — 주목할 소재(BOOST·지출상위·급변·오가닉대박) 각각을 다음 순서로:\n" +
      "   · 크리에이터명 + 광고/오가닉 여부 + 링크\n" +
      "   · 누적 광고비/GMV/ROI, 그리고 최근7일 vs 직전7일 추세(‘추세’의 증감퍼센트를 인용해 늘고 있나 꺾이나 판단)\n" +
      "   · '소재품질'(훅2초·6초율, 완주50·100율, CTR, 전환율)로 왜 되는/안 되는지 해석 — 예: 훅은 좋은데 완주가 낮음→초반만 보고 이탈, CTR 낮음→썸네일/후킹 약함\n" +
      "   · '광고상태'를 반드시 본다: 집행중 / 휴면(광고중단) / 지출미미. 판정 배지는 '누적(라이프타임)' 기준이라 지금 광고가 꺼져 있는지와 별개임 — 현재 상태와 판정을 섞지 말 것.\n" +
      "   · 판정+상태 종합해 구체 액션(증액/유지/피로교체/컷/오가닉→광고확산/재점화 테스트). 신뢰도가 '예비/판정불가'면 '더 지켜보기'.\n" +
      "3) 숨은 기회·리스크: '오가닉_상위_소재'에서 광고 안 태웠는데 매출 큰 소재(→광고 증액 후보), 지출 큰데 ROI<1.5·완주 낮은 소재(→컷·교체).\n\n" +
      "[휴면 소재 재점화 판단 — 매우 중요]\n" +
      "판정이 '피로/KILL'이어도 그것만으로 '재집행 엄금'이라 단정하지 마라. 다음이면 오히려 '소량 재점화 테스트' 후보로 제시한다:\n" +
      "  · 광고상태가 '휴면(광고중단·잔존매출有)' — 즉 최근7일 광고비가 사실상 0인데 '잔존매출_광고AF합'가 계속 나오는 경우.\n" +
      "  근거: (1) 피로는 지출 과열로 붙는 판정이라 휴지기(‘광고중단_경과일’) 뒤 회복하는 경우가 많고, (2) 광고 끈 상태의 잔존/오가닉 수요는 콘텐츠가 여전히 먹힌다는 신호, (3) 현재 지출이 0이라 소액($10~30/일) 테스트 리스크가 낮다. '전성기_최고7일 ROI'가 좋았던 소재일수록 우선 재점화.\n" +
      "  제안 형식: '지금 꺼둔 상태 + 잔존매출 $X + 전성기 ROI Y → 컷 유지보다 소액 재점화 테스트 권장(며칠 관찰)'. 반대로 잔존매출도 없고 품질(완주/CVR)도 나쁘면 '컷 유지'.\n\n" +
      "[매출 증감 질문이면 추가로]\n" +
      "매출 = 방문 × 전환율 × 객단가 로 분해해 무엇이 주로 움직였는지 밝히고, 그 변화를 만든 소재·광고비·오가닉을 위 소재 분석과 연결한다.\n\n" +
      "[규칙]\n" +
      "- 제공된 숫자만 인용. 없는 값(조회수·팔로워 등)은 '데이터에 없음'.\n" +
      "- 한국어. 서론 없이 결론부터. 단, 소재 분석은 절대 얕게 넘기지 말고 소재마다 숫자·품질지표·판정근거·액션을 붙인다.\n" +
      "- 특정 날짜를 물으면 그 날과 직전 구간을 '일별_지표_최근40일'에서 직접 찾아 비교한다.\n" +
      "- 소재를 언급할 땐 크리에이터명과 링크를 함께 적어 바로 확인 가능하게 한다.";

    const prompt = sys + "\n\n[질문]\n" + question + "\n\n[데이터]\n" + JSON.stringify(ctx);

    let answer = "", model;
    if (provider === "gemini") {
      model = String(q.geminiModel || process.env.GEMINI_MODEL || "gemini-3.6-flash");
      const gurl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gemKey}`;
      const r = await fetch(gurl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // maxOutputTokens는 사고(thinking) 토큰까지 포함하므로 넉넉히 (깊은 소재 분석은 길어져 잘림 방지)
          generationConfig: { maxOutputTokens: 16384, temperature: 0.35 },
        }),
      });
      const data = await r.json();
      if (!r.ok) { res.status(502).json({ error: "Gemini API 오류(" + model + "): " + JSON.stringify(data.error || data).slice(0, 300) }); return; }
      // thinking(사고) 파트 제외, 실제 답변 텍스트만
      answer = ((data.candidates || [])[0]?.content?.parts || []).filter((b) => !b.thought).map((b) => b.text || "").join("").trim();
    } else {
      model = String(q.model || process.env.ASK_MODEL || "claude-haiku-4-5-20251001");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": antKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 3200, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await r.json();
      if (!r.ok) { res.status(502).json({ error: "Claude API 오류(" + model + "): " + JSON.stringify(data.error || data).slice(0, 300) }); return; }
      answer = (data.content || []).map((b) => b.text || "").join("").trim();
    }

    res.setHeader("cache-control", "no-store");
    const resp = { answer, provider, model, 기준일: dr.date, 제품: p.name };
    if (q.debug) {
      resp._debug = {
        adErr,
        adCidCount: adByCid ? Object.keys(adByCid).length : null,
        prodCreativeCount: prodCreatives.length,
        oganicVidCount: oganicVids.length,
        sampleCreator: prodCreatives[0] ? prodCreatives[0].크리에이터 : null,
        sampleQuality: prodCreatives[0] ? prodCreatives[0].소재품질 : null,
        dormant: prodCreatives.filter((c) => String(c.광고상태 || "").startsWith("휴면")).map((c) => ({ 크리에이터: c.크리에이터, 상태: c.광고상태, 잔존: c.최근7일.잔존매출_광고AF합, 전성기ROI: c.전성기_최고7일.ROI, 판정: c.판정 })).slice(0, 5),
        dashboardPwSet: !!process.env.DASHBOARD_PASSWORD,
        adsSheetSet: !!process.env.ADS_SHEET_ID,
      };
    }
    res.status(200).json(resp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
