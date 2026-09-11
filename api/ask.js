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

    // 1) 매출 데이터 self-fetch
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
    // 10분마다 갱신되는 캐시키 — 최신 반영하되 매번 시트 재읽기(타임아웃) 방지
    // 광고 소재(광고시트) 페치를 매출 데이터보다 먼저 시작 → 병렬 (직렬 대기 제거로 타임아웃 방지)
    const _pw = process.env.DASHBOARD_PASSWORD || "";
    const _adUrl = `${proto}://${host}/api/ads-report` + (_pw ? `?pw=${encodeURIComponent(_pw)}` : "");
    const adProm = (async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000); // 광고시트 지연 시 스킵
      try { return await (await fetch(_adUrl, { signal: ctrl.signal })).json(); }
      catch (e) { return { error: "광고 로드 지연/실패: " + e.message }; }
      finally { clearTimeout(to); }
    })();

    const cb = Math.floor(Date.now() / 600000);
    const url = `${proto}://${host}/api/daily-report?format=json&cb=${cb}` + (date ? `&date=${encodeURIComponent(date)}` : "");
    let dr;
    try { dr = await (await fetch(url)).json(); }
    catch (e) { res.status(502).json({ error: "매출 데이터 로드 실패: " + e.message }); return; }
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

    // 소재별 광고 지출·판정 (광고 시트 광고소재성과)
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
          // 이 제품 캠페인에 속하는 소재 → 최근7일 광고귀속 GMV/지출
          if (match && match(c.camp || "")) {
            const g7 = Array.isArray(c.sparkG) ? c.sparkG.slice(-7).reduce((s, x) => s + (x || 0), 0) : 0;
            prodCreatives.push({
              크리에이터: c.creator || "(미상)",
              광고귀속GMV_최근7일: Math.round(g7),
              광고비_최근7일: Math.round(c.last7 || 0),
              누적광고비: Math.round(spend),
              광고ROI: c.cum && c.cum.roi != null ? c.cum.roi : null,
              판정: c.badge || "-",
              캠페인: c.camp,
              링크: c.link || (c.id ? `https://www.tiktok.com/@${c.creator || "tiktok"}/video/${c.id}` : null),
            });
          }
        }
        prodCreatives = prodCreatives
          .sort((a, b) => (b.광고귀속GMV_최근7일 - a.광고귀속GMV_최근7일) || (b.광고비_최근7일 - a.광고비_최근7일))
          .slice(0, 12);
      }
    } catch (e) { adErr = e.message; }

    const vids = (p.revVideos || [])
      .filter((v) => v.cid)
      .sort((a, b) => (b.pay || 0) - (a.pay || 0))
      .slice(0, 12)
      .map((v) => {
        const ad = adByCid && adByCid[v.cid];
        return {
          크리에이터: v.creator,
          매출: Math.round(v.pay || 0),
          오가닉: v.org || 0,
          샵애즈: v.shop || 0,
          광고지출_누적: ad ? Math.round(ad.누적광고비) : 0,
          광고지출_최근7일: ad ? Math.round(ad.최근7일광고비) : 0,
          광고ROI: ad ? ad.광고ROI : null,
          광고판정: ad ? (ad.판정 || "-") : "광고미집행(오가닉)",
          링크: v.link || `https://www.tiktok.com/@${v.creator}/video/${v.cid}`,
        };
      });
    const channels = (p.channels || []).map((c) => ({ 채널: c.name, 매출: Math.round(c.v || 0) }));

    const ctx = {
      제품명: p.name,
      제품별칭: FOCUS[pid] || null,
      데이터_기준일: dr.date,
      일별_지표_최근40일: daily,
      매출_상위_소재_기준일: vids,
      광고소재_최근7일: prodCreatives,
      채널별_매출_기준일: channels,
      주의:
        "'매출_상위_소재_기준일'의 '매출'은 AF 매출귀속(오가닉+샵애즈)이며 최신 1~2일은 AF 탭 지연으로 비어있을 수 있음. " +
        "그 경우 '광고소재_최근7일'(광고 시트 기준, 광고귀속GMV=AF Video+프로덕트카드)을 소재 매출/지출 근거로 사용하되 '광고귀속 GMV라 AF 매출귀속과 기준이 다름'을 명시. " +
        "광고판정 배지: 🟢부스팅=증액 후보 / 🔴컷=중단 / 🟡피로 / 관찰 / ⊘게이트탈락(지출<$10). '광고미집행(오가닉)'=광고 없이 매출난 소재." +
        (adErr ? " (⚠️ 광고 소재 데이터 로드 실패: " + adErr + ")" : ""),
    };

    const sys =
      "너는 d'Alba 미국 틱톡샵 데이터 분석가다. 아래 JSON 데이터만 근거로 답한다.\n\n" +
      "[매출 영향 요소 체크리스트] — 매출 증감 질문이면 아래를 순서대로 점검하고, 관련 있는 항목만 근거로 제시한다:\n" +
      "① 결과지표 분해: 매출 = 방문 × 전환율 × 객단가. 셋 중 무엇이 주로 움직였는지 반드시 밝힌다.\n" +
      "② 전환 세부: 담기율(ATCR)·전환율 흐름(있으면).\n" +
      "③ 광고: 일별 광고비 변화·ROI. 그리고 '매출_상위_소재'의 광고지출·광고판정을 보고 — 광고를 태운 소재 vs 광고 없이 오가닉으로 큰 소재(광고미집행)를 구분하고, 부스팅/컷 판정을 짚는다.\n" +
      "④ 콘텐츠: 신규 영상 발행량, 매출 상위 소재의 편중(1~2개 소재 의존 여부), 크리에이터명. 최신일이라 '매출_상위_소재_기준일'이 비면 '광고소재_최근7일'로 대체 분석.\n" +
      "⑤ 유입 출처: 오가닉 vs 샵애즈. (값이 0이면 최신일 집계 지연 가능성으로 명시)\n" +
      "⑥ 채널: 동영상/라이브/프로덕트카드/셀러영상 중 어디서 늘고 줄었나.\n\n" +
      "[규칙]\n" +
      "- 제공된 숫자만 인용. 없는 값(조회수·팔로워·라이브 진행시간 등)은 추측 말고 '데이터에 없음'이라 밝힌다.\n" +
      "- 한국어. 첫 줄에 핵심 결론(주원인 1~2개), 그 뒤 근거를 실제 숫자·크리에이터명·광고판정으로 구체적으로. 간결하게(과한 서론 금지).\n" +
      "- 특정 날짜를 물으면 그 날과 직전/비교 구간을 일별 데이터에서 직접 찾아 비교한다.";

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
          // maxOutputTokens는 사고(thinking) 토큰까지 포함하므로 넉넉히 (답변 잘림 방지)
          generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
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
        body: JSON.stringify({ model, max_tokens: 1600, messages: [{ role: "user", content: prompt }] }),
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
        sampleAdCids: adByCid ? Object.keys(adByCid).slice(0, 3) : null,
        vidSampleCids: (p.revVideos || []).filter((v) => v.cid).slice(0, 3).map((v) => v.cid),
        matched: vids.filter((v) => v.광고지출_누적 > 0 || (v.광고판정 && v.광고판정 !== "광고미집행(오가닉)")).length,
        dashboardPwSet: !!process.env.DASHBOARD_PASSWORD,
        adsSheetSet: !!process.env.ADS_SHEET_ID,
      };
    }
    res.status(200).json(resp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
