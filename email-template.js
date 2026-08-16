/*!
 * 달바 크리에이터 아웃리치 — 이메일 템플릿 엔진
 *
 * 브라우저(outreach.html 실시간 미리보기)와 서버(api/outreach-send.js 실제 발송)가
 * **같은 코드**를 쓰도록 UMD 로 작성했다. 미리보기와 실제 발송 메일이 어긋나면 안 되므로
 * 템플릿은 반드시 이 파일 한 곳에서만 만든다.
 *
 *   브라우저:  <script src="/email-template.js"></script> → window.OutreachTemplate
 *   서버:      const T = require("../email-template.js");
 *
 * 이메일 클라이언트 호환을 위해 <table> 레이아웃 + 인라인 CSS 만 쓴다.
 * (Gmail/네이버웍스 웹은 <style> 블록과 flex/grid 를 상당 부분 무시함)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OutreachTemplate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ─── 디자인 토큰 ────────────────────────────────────────────────
  const C = {
    page: "#f2ede1",      // 바깥 배경 (크림)
    card: "#ffffff",      // 본문 카드
    dark: "#1a1a1a",      // 헤더 / CTA
    onDark: "#f0e6d2",    // 헤더 위 텍스트
    gold: "#b78a22",      // 강조
    box: "#faf5e9",       // 안내 박스 배경
    boxLine: "#dcc9a0",   // 안내 박스 테두리
    text: "#1d1d1f",
    muted: "#6b6b6b",
    line: "#ececec"
  };
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const WIDTH = 600;

  // ─── 유틸 ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // 링크는 스킴을 화이트리스트로 검증 (javascript: 등 주입 차단)
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    if (!s) return "";
    if (/^(https?:|mailto:)/i.test(s)) return esc(s);
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return esc("https://" + s); // 스킴 생략 입력 보정
    return "";
  }
  function nl2br(s) { return esc(s).replace(/\r?\n/g, "<br />"); }
  function has(s) { return String(s == null ? "" : s).trim() !== ""; }

  function money(currency, amount) {
    const cur = (currency || "KRW").toUpperCase();
    const n = Number(String(amount).replace(/[^0-9.-]/g, ""));
    if (!isFinite(n) || !n) return "";
    // 참고 메일과 동일한 표기: "KRW 650,000"
    return cur + " " + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  // {{name}} {{handle}} {{brand}} … 치환 (제목·본문 커스텀 문구용)
  function fill(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) {
      return vars[k] != null && vars[k] !== "" ? String(vars[k]) : "";
    });
  }

  // ─── 조각 빌더 ─────────────────────────────────────────────────
  function sectionLabel(emoji, text) {
    return '<tr><td style="padding:30px 0 10px;font:700 11.5px/1.4 ' + FONT +
      ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
      esc(emoji) + " " + esc(text) + "</td></tr>";
  }

  function infoBox(inner, opts) {
    const o = opts || {};
    return '<tr><td style="padding:0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="background:' + C.box + ';border:1px solid ' + C.boxLine + ';border-radius:12px;">' +
      '<tr><td style="padding:' + (o.pad || "22px 24px") + ';text-align:' + (o.align || "center") + ';">' +
      inner + "</td></tr></table></td></tr>";
  }

  function para(html) {
    return '<tr><td style="padding:0 0 16px;font:400 15px/1.65 ' + FONT + ';color:' + C.text + ';">' +
      html + "</td></tr>";
  }

  // ─── 보상 블록 (유상 / 어필리에이트 / 둘 다) ────────────────────
  function rewardBlocks(d) {
    const type = d.dealType || "paid";
    const wantPaid = type === "paid" || type === "both";
    const wantAff = type === "affiliate" || type === "both";
    let out = "";

    if (wantPaid && has(d.amount)) {
      out += infoBox(
        '<div style="font:700 11.5px/1.4 ' + FONT + ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
        "💰 Cash paid to you</div>" +
        '<div style="font:800 34px/1.2 ' + FONT + ';color:' + C.text + ';padding:10px 0 6px;">' +
        esc(money(d.currency, d.amount)) + "</div>" +
        '<div style="font:400 13px/1.5 ' + FONT + ';color:' + C.muted + ';">' +
        esc(has(d.paymentNote) ? d.paymentNote : "Paid after your content goes live and is approved.") +
        "</div>"
      );
    }

    if (wantAff && has(d.commission)) {
      const rate = Number(String(d.commission).replace(/[^0-9.]/g, ""));
      out += (wantPaid && has(d.amount) ? '<tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>' : "");
      out += infoBox(
        '<div style="font:700 11.5px/1.4 ' + FONT + ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
        "📈 Affiliate commission</div>" +
        '<div style="font:800 34px/1.2 ' + FONT + ';color:' + C.text + ';padding:10px 0 6px;">' +
        esc(rate ? rate + "%" : String(d.commission)) + "</div>" +
        '<div style="font:400 13px/1.5 ' + FONT + ';color:' + C.muted + ';">' +
        "On every sale made through your TikTok Shop affiliate link — " +
        (has(d.commissionNote) ? esc(d.commissionNote) : "no cap, paid out by TikTok Shop.") +
        "</div>"
      );
    }

    // 유상 + 어필리에이트 동시 제안이면 합산 메시지로 한 번 더 각인
    if (wantPaid && wantAff && has(d.amount) && has(d.commission)) {
      out += '<tr><td style="padding:12px 4px 0;font:600 13.5px/1.6 ' + FONT + ';color:' + C.text + ';text-align:center;">' +
        // 통화 기호(₩ 등) 대신 코드 표기를 쓴다 — ₩ 의 가로 이중선이 숫자에 취소선처럼 겹쳐 보임
        "You get <span style=\"color:" + C.gold + ";\">" + esc(money(d.currency, d.amount)) + " up front</span>" +
        " <span style=\"color:" + C.muted + ";font-weight:400;\">+</span> " +
        "<span style=\"color:" + C.gold + ";\">" + esc(String(d.commission).replace(/[^0-9.]/g, "")) + "% of every sale</span>." +
        "</td></tr>";
    }
    return out;
  }

  // ─── 캠페인 상세 (요구 산출물 / 마감 / 장소) ────────────────────
  function detailRows(d) {
    const rows = [];
    if (has(d.deliverables)) rows.push(["📹 What we'd love from you", nl2br(d.deliverables)]);
    if (has(d.deadline)) rows.push(["🗓 Timeline", nl2br(d.deadline)]);
    if (has(d.location)) rows.push(["📍 Location", nl2br(d.location)]);
    if (!rows.length) return "";

    let inner = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
    rows.forEach(function (r, i) {
      inner += "<tr><td style=\"padding:" + (i ? "16px" : "0") + " 0 0;\">" +
        '<div style="font:700 12px/1.4 ' + FONT + ';color:' + C.muted + ';padding-bottom:5px;">' + esc(r[0]) + "</div>" +
        '<div style="font:400 14.5px/1.6 ' + FONT + ';color:' + C.text + ';">' + r[1] + "</div>" +
        "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("📦", "Campaign details") + infoBox(inner, { align: "left", pad: "20px 24px" });
  }

  // ─── 제품 소개 ─────────────────────────────────────────────────
  function productBlock(d) {
    if (!has(d.product) && !has(d.productDesc)) return "";
    const url = safeUrl(d.productUrl);
    const img = safeUrl(d.productImage);
    let inner = "";

    if (img) {
      inner += '<div style="padding-bottom:16px;"><img src="' + img + '" width="180" alt="' + esc(d.product) +
        '" style="width:180px;max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" /></div>';
    }
    if (has(d.product)) {
      inner += '<div style="font:700 16px/1.4 ' + FONT + ';color:' + C.text + ';padding-bottom:8px;">' + esc(d.product) + "</div>";
    }
    if (has(d.productDesc)) {
      inner += '<div style="font:400 14.5px/1.65 ' + FONT + ';color:' + C.text + ';">' + nl2br(d.productDesc) + "</div>";
    }
    if (url) {
      inner += '<div style="padding-top:14px;"><a href="' + url + '" style="font:700 14px/1.5 ' + FONT +
        ";color:" + C.gold + ';text-decoration:none;">' + esc(has(d.productUrlLabel) ? d.productUrlLabel : "See the product →") + "</a></div>";
    }
    return sectionLabel("🧴", "About " + (has(d.brand) ? d.brand : "the product")) +
      infoBox(inner, { align: img ? "center" : "left", pad: "22px 24px" });
  }

  // ─── 바이럴 영상 (이미 잘 되고 있다는 증거 — 수락률에 가장 크게 기여) ──
  // videos: ["https://...", ...] 또는 [{url, label}, ...] 둘 다 허용
  function normVideos(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[\n,]+/);
    return arr.map(function (x) {
      const o = (x && typeof x === "object") ? x : { url: x };
      return { url: safeUrl(o.url), label: has(o.label) ? o.label : "" };
    }).filter(function (o) { return o.url; }).slice(0, 4);
  }

  function videoBlock(d) {
    const vids = normVideos(d.videos);
    if (!vids.length) return "";

    let inner = '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';padding-bottom:14px;">' +
      esc(has(d.videosNote) ? d.videosNote : "Here's how this product is already performing with creators:") + "</div>" +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';

    vids.forEach(function (v, i) {
      inner += "<tr>" +
        '<td width="30" valign="top" style="padding:' + (i ? "12px" : "0") + ' 10px 0 0;font:800 15px/1.5 ' + FONT +
        ";color:" + C.gold + ';">' + "▶" + "</td>" +
        '<td valign="top" style="padding:' + (i ? "12px" : "0") + ' 0 0;">' +
        '<a href="' + v.url + '" style="font:600 14px/1.5 ' + FONT + ";color:" + C.gold +
        ';text-decoration:none;word-break:break-all;">' + (v.label ? esc(v.label) : v.url) + "</a>" +
        (v.label ? '<div style="font:400 11.5px/1.5 ' + FONT + ";color:" + C.muted +
          ';word-break:break-all;padding-top:2px;">' + v.url + "</div>" : "") +
        "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("🔥", "Videos that are already popping off") +
      infoBox(inner, { align: "left", pad: "20px 24px" });
  }

  // ─── 다음 단계 1·2·3 ───────────────────────────────────────────
  function stepsBlock(d) {
    const steps = (Array.isArray(d.steps) && d.steps.length ? d.steps : [
      "Reply to this email (or tap the button below) to let us know you're in.",
      "We'll send the full brief, the product, and your affiliate link.",
      "You create, we boost it — and you get paid."
    ]).filter(has);
    if (!steps.length) return "";

    let inner = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
    steps.forEach(function (s, i) {
      inner += "<tr>" +
        '<td width="34" valign="top" style="padding:' + (i ? "14px" : "0") + ' 12px 0 0;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td width="26" height="26" align="center" valign="middle" style="width:26px;height:26px;background:' + C.dark +
        ";border-radius:13px;font:700 12px/26px " + FONT + ';color:#fff;">' + (i + 1) + "</td>" +
        "</tr></table></td>" +
        '<td valign="top" style="padding:' + (i ? "14px" : "0") + ' 0 0;font:400 14.5px/1.6 ' + FONT + ";color:" + C.text + ';">' +
        nl2br(s) + "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("📋", "What happens next") +
      '<tr><td style="padding:0;">' + inner + "</td></tr>";
  }

  // ─── CTA 버튼 ──────────────────────────────────────────────────
  function ctaBlock(d) {
    const url = safeUrl(d.applyUrl);
    if (!url) return "";
    const label = has(d.applyLabel) ? d.applyLabel : "Count me in →";
    return '<tr><td align="center" style="padding:34px 0 6px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td align="center" style="background:' + C.dark + ';border-radius:999px;">' +
      '<a href="' + url + '" style="display:inline-block;padding:15px 46px;font:700 15px/1.2 ' + FONT +
      ';color:#ffffff;text-decoration:none;border-radius:999px;">' + esc(label) + "</a>" +
      "</td></tr></table></td></tr>";
  }

  // ─── 메일 전체 ─────────────────────────────────────────────────
  function buildHtml(d) {
    d = resolve(d);
    const creator = has(d.creatorName) ? d.creatorName : (has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "there");
    const brand = has(d.brand) ? d.brand : "d'Alba";
    const title = has(d.campaignTitle) ? d.campaignTitle : "Paid Collab Invitation";
    const survey = safeUrl(d.surveyUrl);

    let body = "";

    // 인사 + 소개
    body += '<tr><td style="padding:0 0 18px;font:800 22px/1.35 ' + FONT + ";color:" + C.gold + ';">' +
      "Hi " + esc(creator) + "! 👋</td></tr>";

    body += para(
      "We're <strong>" + esc(brand) + "</strong>" +
      (has(d.brandIntro) ? ", " + nl2br(d.brandIntro) : ", a Korean beauty brand working with creators on TikTok Shop.")
    );

    if (has(d.pitch)) body += para(nl2br(d.pitch));

    // 왜 당신인가 (개인화 한 줄 — 응답률의 핵심)
    if (has(d.whyYou)) {
      body += infoBox(
        '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';">' + nl2br(d.whyYou) + "</div>",
        { align: "left", pad: "18px 22px" }
      );
      body += '<tr><td style="height:6px;line-height:6px;">&nbsp;</td></tr>';
    }

    // 보상
    const rewards = rewardBlocks(d);
    if (rewards) body += sectionLabel("🎁", "Here's what you get") + rewards;

    // 캠페인 상세 · 제품
    body += detailRows(d);
    body += productBlock(d);
    body += videoBlock(d);

    // 설문
    if (survey) {
      body += sectionLabel("📌", "Quick creator survey") + infoBox(
        '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';padding-bottom:10px;">' +
        esc(has(d.surveyNote) ? d.surveyNote : "Tell us a bit about you and your audience — takes 3 minutes. 😊") + "</div>" +
        '<a href="' + survey + '" style="font:700 14px/1.5 ' + FONT + ";color:" + C.gold + ';text-decoration:none;word-break:break-all;">' +
        survey + "</a>",
        { align: "left", pad: "20px 24px" }
      );
    }

    // 다음 단계 · CTA
    body += stepsBlock(d);
    body += ctaBlock(d);

    if (has(d.notes)) {
      body += '<tr><td style="padding:24px 0 0;font:400 13px/1.6 ' + FONT + ";color:" + C.muted + ';">' +
        nl2br(d.notes) + "</td></tr>";
    }

    // 서명
    body += '<tr><td style="padding:30px 0 0;border-top:1px solid ' + C.line + ';"></td></tr>' +
      '<tr><td style="padding:18px 0 0;font:400 14px/1.65 ' + FONT + ";color:" + C.text + ';">' +
      "Looking forward to hearing from you!<br /><br />" +
      "<strong>" + esc(has(d.senderName) ? d.senderName : "") + "</strong>" +
      (has(d.senderTitle) ? '<br /><span style="color:' + C.muted + ';font-size:13px;">' + esc(d.senderTitle) + "</span>" : "") +
      (has(d.senderEmail) ? '<br /><a href="mailto:' + esc(d.senderEmail) + '" style="color:' + C.gold +
        ';text-decoration:none;font-size:13px;">' + esc(d.senderEmail) + "</a>" : "") +
      "</td></tr>";

    // 프리헤더 = 받은편지함 미리보기 첫 줄 (열람률에 직결)
    const preheader = has(d.preheader) ? d.preheader :
      ((has(d.amount) && (d.dealType !== "affiliate") ? money(d.currency, d.amount) + " paid collab" : "Paid collab") +
        " with " + brand + " — details inside.");

    return '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
      '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />' +
      '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
      '<meta name="x-apple-disable-message-reformatting" />' +
      "<title>" + esc(title) + "</title></head>" +
      '<body style="margin:0;padding:0;background:' + C.page + ';">' +
      '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">' +
      esc(preheader) + "</div>" +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + C.page + ';">' +
      '<tr><td align="center" style="padding:28px 12px 44px;">' +
      '<table role="presentation" width="' + WIDTH + '" cellpadding="0" cellspacing="0" border="0" ' +
      'style="width:' + WIDTH + 'px;max-width:100%;">' +

      // 헤더 (다크)
      '<tr><td style="background:' + C.dark + ';border-radius:14px;padding:34px 30px;text-align:center;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>' +
      '<td style="border:1px solid rgba(240,230,210,.45);border-radius:999px;padding:7px 18px;font:700 11px/1.2 ' + FONT +
      ";letter-spacing:.16em;color:" + C.onDark + ';">✉️ CAMPAIGN INVITATION</td>' +
      "</tr></table>" +
      '<div style="font:800 25px/1.35 ' + FONT + ";color:" + C.onDark + ';padding:18px 0 10px;">' + esc(title) + "</div>" +
      '<div style="font:600 10.5px/1.5 ' + FONT + ';letter-spacing:.18em;color:rgba(240,230,210,.62);text-transform:uppercase;">' +
      esc(brand) + " · K-Beauty Creator Partnership</div>" +
      "</td></tr>" +

      // 본문 카드
      '<tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>' +
      '<tr><td style="background:' + C.card + ';border-radius:14px;padding:34px 32px 36px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + body + "</table>" +
      "</td></tr>" +

      // 푸터
      '<tr><td style="padding:20px 10px 0;text-align:center;font:400 11.5px/1.6 ' + FONT + ";color:" + C.muted + ';">' +
      "You're receiving this because we'd love to work with you.<br />" +
      "Not interested? Just reply “no thanks” and we won't follow up." +
      "</td></tr>" +

      "</table></td></tr></table></body></html>";
  }

  // ─── 플레인 텍스트 대체본 (스팸 점수 · 접근성) ──────────────────
  function buildText(d) {
    d = resolve(d);
    const creator = has(d.creatorName) ? d.creatorName : (has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "there");
    const brand = has(d.brand) ? d.brand : "d'Alba";
    const L = [];
    L.push("Hi " + creator + "!");
    L.push("");
    L.push("We're " + brand + (has(d.brandIntro) ? ", " + d.brandIntro : ", a Korean beauty brand working with creators on TikTok Shop."));
    if (has(d.pitch)) { L.push(""); L.push(d.pitch); }
    if (has(d.whyYou)) { L.push(""); L.push(d.whyYou); }

    const type = d.dealType || "paid";
    if ((type === "paid" || type === "both") && has(d.amount)) {
      L.push(""); L.push("HERE'S WHAT YOU GET");
      L.push("- Cash paid to you: " + money(d.currency, d.amount));
    }
    if ((type === "affiliate" || type === "both") && has(d.commission)) {
      if (!((type === "both") && has(d.amount))) { L.push(""); L.push("HERE'S WHAT YOU GET"); }
      L.push("- Affiliate commission: " + String(d.commission).replace(/[^0-9.]/g, "") + "% on every sale through your link");
    }
    if (has(d.deliverables)) { L.push(""); L.push("WHAT WE'D LOVE FROM YOU"); L.push(d.deliverables); }
    if (has(d.deadline)) { L.push(""); L.push("TIMELINE: " + d.deadline); }
    if (has(d.location)) { L.push("LOCATION: " + d.location); }
    if (has(d.product) || has(d.productDesc)) {
      L.push(""); L.push("ABOUT " + (has(d.brand) ? d.brand.toUpperCase() : "THE PRODUCT"));
      if (has(d.product)) L.push(d.product);
      if (has(d.productDesc)) L.push(d.productDesc);
      if (safeUrl(d.productUrl)) L.push(String(d.productUrl).trim());
    }
    const vids = normVideos(d.videos);
    if (vids.length) {
      L.push(""); L.push("VIDEOS THAT ARE ALREADY POPPING OFF");
      vids.forEach(function (v) { L.push("- " + (v.label ? v.label + " — " : "") + v.url.replace(/&amp;/g, "&")); });
    }
    if (safeUrl(d.surveyUrl)) { L.push(""); L.push("Quick creator survey: " + String(d.surveyUrl).trim()); }
    if (safeUrl(d.applyUrl)) { L.push(""); L.push((has(d.applyLabel) ? d.applyLabel : "Count me in") + ": " + String(d.applyUrl).trim()); }
    if (has(d.notes)) { L.push(""); L.push(d.notes); }
    L.push(""); L.push("Looking forward to hearing from you!");
    if (has(d.senderName)) L.push(d.senderName);
    if (has(d.senderTitle)) L.push(d.senderTitle);
    if (has(d.senderEmail)) L.push(d.senderEmail);
    return L.join("\n");
  }

  // ─── 개인화 변수 ───────────────────────────────────────────────
  // 제목뿐 아니라 본문 문구에서도 {{name}} {{handle}} {{amount}} … 를 쓸 수 있다.
  // (대량 발송에서 한 문장만 바꿔 개인화할 때 핵심)
  const FILLABLE = [
    "subject", "campaignTitle", "brandIntro", "pitch", "whyYou",
    "deliverables", "deadline", "location", "productDesc", "notes",
    "surveyNote", "paymentNote", "commissionNote", "applyLabel", "preheader", "videosNote"
  ];

  function varsOf(d) {
    return {
      name: has(d.creatorName) ? d.creatorName : String(d.handle || "").replace(/^@/, ""),
      handle: has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "",
      brand: has(d.brand) ? d.brand : "d'Alba",
      campaign: has(d.campaignTitle) ? d.campaignTitle : "Creator Collab",
      product: d.product || "",
      amount: money(d.currency, d.amount),
      commission: has(d.commission) ? String(d.commission).replace(/[^0-9.]/g, "") + "%" : "",
      sender: d.senderName || ""
    };
  }

  // 치환을 미리 끝낸 사본을 만든다 (원본은 건드리지 않음)
  function resolve(d) {
    const src = d || {};
    const vars = varsOf(src);
    const out = Object.assign({}, src);
    FILLABLE.forEach(function (k) { if (has(out[k])) out[k] = fill(out[k], vars); });
    return out;
  }

  // ─── 제목 ──────────────────────────────────────────────────────
  const DEFAULT_SUBJECT = "[{{brand}}] 💚 Paid Collab X {{name}} — {{campaign}}";

  function buildSubject(d) {
    const raw = has(d.subject) ? d.subject : DEFAULT_SUBJECT;
    return fill(raw, varsOf(d)).replace(/\s{2,}/g, " ").replace(/\s*—\s*$/, "").trim();
  }

  // ─── 입력 검증 (서버·클라이언트 공통) ───────────────────────────
  function validate(d) {
    const errs = [];
    if (!has(d.to)) errs.push("크리에이터 이메일이 없습니다");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.to).trim())) errs.push("이메일 형식이 올바르지 않습니다: " + d.to);
    if (!has(d.campaignTitle)) errs.push("캠페인 제목이 없습니다");
    const type = d.dealType || "paid";
    if ((type === "paid" || type === "both") && !has(d.amount)) errs.push("유상 협업인데 금액이 없습니다");
    if ((type === "affiliate" || type === "both") && !has(d.commission)) errs.push("어필리에이트인데 커미션율이 없습니다");
    return errs;
  }

  function build(d) {
    return { subject: buildSubject(d), html: buildHtml(d), text: buildText(d) };
  }

  return {
    build: build,
    buildHtml: buildHtml,
    buildText: buildText,
    buildSubject: buildSubject,
    validate: validate,
    money: money,
    DEFAULT_SUBJECT: DEFAULT_SUBJECT,
    COLORS: C
  };
});
