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
    const url = `${proto}://${host}/api/daily-report?format=json` + (date ? `&date=${encodeURIComponent(date)}` : "");
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
    const vids = (p.revVideos || [])
      .filter((v) => v.cid)
      .sort((a, b) => (b.pay || 0) - (a.pay || 0))
      .slice(0, 12)
      .map((v) => ({
        크리에이터: v.creator,
        매출: Math.round(v.pay || 0),
        오가닉: v.org || 0,
        샵애즈: v.shop || 0,
        링크: v.link || `https://www.tiktok.com/@${v.creator}/video/${v.cid}`,
      }));
    const channels = (p.channels || []).map((c) => ({ 채널: c.name, 매출: Math.round(c.v || 0) }));

    const ctx = {
      제품명: p.name,
      제품별칭: FOCUS[pid] || null,
      데이터_기준일: dr.date,
      일별_지표_최근40일: daily,
      매출_상위_소재_기준일: vids,
      채널별_매출_기준일: channels,
      주의: "매출발생영상(소재)은 광고 지출이 아니라 매출 귀속. 광고비/ROI는 일별_지표의 광고비·ROI 참고. 소재별 광고지출 데이터는 여기 없음.",
    };

    const sys =
      "너는 d'Alba 미국 틱톡샵 데이터 분석가다. 아래 JSON 데이터만 근거로 사용자 질문에 답한다.\n" +
      "규칙:\n" +
      "1) 제공된 숫자만 인용한다. 데이터에 없는 값(조회수·팔로워·소재별 광고비 등)은 추측하지 말고 '데이터에 없음'이라 밝힌다.\n" +
      "2) 매출 증감은 반드시 '방문 × 전환율 × 객단가'로 분해해 어느 요인이 주원인인지 밝힌다.\n" +
      "3) 함께 확인: 광고비 변화와 ROI, 특정 소재(크리에이터)의 매출 기여·편중, 신규 영상 발행량, 오가닉 vs 샵애즈.\n" +
      "4) 한국어. 첫 줄에 핵심 결론, 그 뒤 근거를 실제 숫자·크리에이터명으로 구체적으로. 간결하게(과한 서론 금지).\n" +
      "5) 특정 날짜를 물으면 그 날과 비교 구간을 일별 데이터에서 직접 찾아 비교한다.";

    const prompt = sys + "\n\n[질문]\n" + question + "\n\n[데이터]\n" + JSON.stringify(ctx);

    let answer = "", model;
    if (provider === "gemini") {
      model = String(q.geminiModel || process.env.GEMINI_MODEL || "gemini-2.0-flash");
      const gurl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gemKey}`;
      const r = await fetch(gurl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1800, temperature: 0.3 } }),
      });
      const data = await r.json();
      if (!r.ok) { res.status(502).json({ error: "Gemini API 오류(" + model + "): " + JSON.stringify(data.error || data).slice(0, 300) }); return; }
      answer = ((data.candidates || [])[0]?.content?.parts || []).map((b) => b.text || "").join("").trim();
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
    res.status(200).json({ answer, provider, model, 기준일: dr.date, 제품: p.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
