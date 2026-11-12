// Vercel Serverless Function — 배포 경로: /api/handles?ids=7701404240534572302,7705143657778728206
// 광고 소재(영상 ID)의 크리에이터 핸들을 찾는다. 주문 시트에 기록이 없는 영상(광고만 집행된 영상 등)용.
// TikTok 영상 페이지의 itemStruct.author.uniqueId 를 읽고, 결과는 인스턴스 메모리에 캐시한다.
const MEM = globalThis.__handleCache || (globalThis.__handleCache = {});

async function lookup(id) {
  if (id in MEM) return MEM[id];
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://www.tiktok.com/@tiktok/video/${id}`, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await r.text();
    const i = html.indexOf('"itemStruct"');
    const m = i >= 0 ? html.slice(i, i + 200000).match(/"uniqueId":"([^"]+)"/) : null;
    const h = m ? m[1] : null;
    if (h) MEM[id] = h;
    return h;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

module.exports = async (req, res) => {
  const ids = String((req.query && req.query.ids) || "").split(",").map(s => s.trim()).filter(s => /^\d{15,25}$/.test(s)).slice(0, 40);
  const out = {};
  let i = 0;
  const worker = async () => { while (i < ids.length) { const id = ids[i++]; out[id] = await lookup(id); } };
  await Promise.all(Array.from({ length: 8 }, worker));
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(out);
};
