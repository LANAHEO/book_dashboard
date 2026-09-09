#!/usr/bin/env node
// 화면에 뜬 순위가 서점 페이지와 같은지 확인한다.
//
// 왜 있나: 순위가 서점과 다른 일이 세 번 반복됐고, 세 번 다 원인이 달랐다.
//   1) 수집이 아예 안 돌았다 (GitHub 시크릿 미설정, 100회 연속 실패)
//   2) 수집한 값을 저장하지 않았다 (파일 캐시 가드가 Supabase 저장까지 막았다)
//   3) 카드가 엉뚱한 분야의 순위를 골라 왔다 (여러 분야 중 순위 좋은 것)
// 셋 다 화면만 봐서는 "숫자가 좀 다르네" 로만 보였다. 그래서 사람 눈이 아니라
// 이 스크립트가 대신 서점을 열어 본다.
//
// 무엇을 참으로 보나: 주간·일간·분야 순위는 하루 단위로 고정이므로 우리 값과
// 서점 페이지가 **정확히 같아야 한다** — 다르면 버그다. 실시간은 서점이 계속
// 바꾸므로 다른 게 정상이다. 그래서 실시간은 세되 실패로 치지 않는다.
//
// 쓰는 법:
//   node scripts/check-ranks.js                        # 배포된 대시보드를 본다
//   node scripts/check-ranks.js --base http://localhost:3000
//   node scripts/check-ranks.js --books 8              # 확인할 도서 수
// 고정 목록에서 불일치가 하나라도 있으면 종료 코드 1.

const DEFAULT_BASE = "https://book-dashboard-gilt.vercel.app";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const BASE = String(arg("--base", process.env.DASHBOARD_BASE_URL || DEFAULT_BASE)).replace(
  /\/+$/,
  ""
);
const BOOK_LIMIT = Number(arg("--books", 6));

// 제목은 서점마다 &amp; 같은 기호와 공백이 다르게 들어온다. 그 차이로 "불일치"를
// 만들면 진짜 불일치가 묻힌다.
const norm = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&quot;/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

async function getText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9", accept: "text/html" }
  });
  return res.text();
}

// 서점 페이지에 실제로 찍혀 있는 (순위, 제목). 우리 파서를 재사용하지 않는다 —
// 파서가 틀렸다면 파서로는 그것을 알아낼 수 없다.
function ranksOnPage(storeId, html) {
  const out = [];

  if (storeId === "aladin") {
    for (const block of html.split(/<div class="ss_book_box"[^>]*>/).slice(1)) {
      const rank = Number(
        (block.match(/<div style="text-align: center;">\s*(\d+)\.\s*<\/div>/) || [])[1]
      );
      const title = (block.match(/<a [^>]*class="bo3"[^>]*>([\s\S]*?)<\/a>/) || [])[1];
      if (rank && title) out.push({ rank, title: title.replace(/<[^>]+>/g, "").trim() });
    }
    return out;
  }

  if (storeId === "yes24") {
    for (const block of html.split(/<li class="[^"]*" data-goods-no="/).slice(1)) {
      const rank = Number((block.match(/<em class="ico rank">(\d+)<\/em>/) || [])[1]);
      const title = (block.match(/<a class="gd_name"[^>]*>([\s\S]*?)<\/a>/) || [])[1];
      if (rank && title) out.push({ rank, title: title.replace(/<[^>]+>/g, "").trim() });
    }
    return out;
  }

  // 교보는 목록을 HTML 로 내려주지 않는다(화면을 자바스크립트가 그린다).
  // 이 스크립트는 브라우저를 띄우지 않으므로 교보는 확인 대상에서 빠지고,
  // 그 사실을 결과에 적는다. 교보 링크가 그 순위 자리에 떨어지는지는
  // 헤드리스 크롬으로 따로 확인해야 한다(순위 = 페이지에서의 위치).
  return out;
}

const pageCache = new Map();

async function storeRanks(list) {
  if (pageCache.has(list.id)) return pageCache.get(list.id);

  const items = [];
  // 알라딘 50/쪽, 예스24 24/쪽. 100위까지 덮으려면 그만큼 넘긴다.
  const pages = list.storeId === "aladin" ? 2 : 5;

  for (let page = 1; page <= pages; page++) {
    const url = new URL(list.sourceUrl);
    if (list.storeId === "aladin") {
      url.searchParams.set("page", String(page));
      url.searchParams.set("cnt", "50");
    } else {
      url.searchParams.set("PageNumber", String(page));
    }

    try {
      items.push(...ranksOnPage(list.storeId, await getText(url.toString())));
    } catch (error) {
      // 한 쪽이 실패해도 나머지로 확인한다. 서점이 잠깐 흔들린 것과
      // 우리 값이 틀린 것은 다른 문제다.
      console.error(`  ! ${list.id} ${page}쪽 가져오기 실패: ${error.message}`);
    }
    if (list.storeId !== "aladin" && items.length >= 100) break;
  }

  pageCache.set(list.id, items);
  return items;
}

(async () => {
  const payload = await fetch(`${BASE}/api/dashboard`).then((r) => r.json());
  const lists = new Map(
    (payload.sections || []).flatMap((s) => s.lists || []).map((l) => [l.id, l])
  );

  const stamp = payload.generatedAt || "?";
  console.log(`대상: ${BASE}`);
  console.log(`스냅샷: ${stamp}`);
  console.log("");

  const fixedProblems = [];
  const realtimeDrift = [];
  let fixedOk = 0;
  let skipped = 0;

  for (const book of (payload.focusBooks || []).slice(0, BOOK_LIMIT)) {
    for (const item of book.appearances || []) {
      const list = lists.get(item.listId);
      if (!list || !list.sourceUrl || item.storeId === "kyobo") {
        skipped++;
        continue;
      }

      const onPage = await storeRanks(list);
      if (!onPage.length) {
        skipped++;
        continue;
      }

      const hit = onPage.find((x) => norm(x.title) === norm(item.title));
      const where = `${book.title} · ${item.storeName} · ${item.listName}`;

      if (!hit) {
        // 그 페이지에 아예 없다. 실시간이면 우리 수집 뒤에 밀려난 것일 수 있다.
        const note = `${where} → 화면 ${item.rank}위인데 서점 페이지에 없음`;
        if (item.realtime) realtimeDrift.push(note);
        else fixedProblems.push(note);
        continue;
      }

      if (hit.rank === Number(item.rank)) {
        if (!item.realtime) fixedOk++;
        continue;
      }

      const note = `${where} → 화면 ${item.rank}위 / 서점 ${hit.rank}위`;
      if (item.realtime) realtimeDrift.push(note);
      else fixedProblems.push(note);
    }
  }

  // ── 우리 데이터가 얼마나 묵었나 ─────────────────────────────────────
  // 처음에는 "서점이 밝힌 기준 시각"과 "우리 수집 시각"의 차이를 5분 안에
  // 두려고 했다. 그건 이 값으로는 지킬 수 없다 — 교보는 매시 정각 기준을
  // 한 시간 동안 그대로 내주므로, 17:55 에 아무리 신선하게 가져와도 기준은
  // 17:00 이고 차이는 55분으로 적힌다. 정각 직후 5분만 통과하고 나머지
  // 55분은 실패로 찍혀서, 이 검사가 매시간 수집 루프를 죽였다.
  //
  // 지킬 수 있고 뜻이 있는 것은 이쪽이다: 우리가 마지막으로 가져온 시각이
  // 지금으로부터 한 수집 주기 안에 있는가. 그래야 화면 숫자가 서점이 지금
  // 내주는 값과 같다. 기준 시각 차이는 참고로만 적는다.
  // 임계값을 주기의 몇 배로 잡으면 오탐이 난다. 순위가 지난번과 같으면
  // /api/collect 가 스냅샷을 다시 쓰지 않고 끝내므로(정상 동작), 아무 일도
  // 없던 20분 뒤에도 collectedAt 은 20분 전이다. 값이 맞는데 실패로 찍힌다.
  //
  // 이 검사가 잡아야 하는 것은 "몇 분 늦었나"가 아니라 "수집이 멈췄나"다.
  // 멈추면 시간 단위로 벌어지므로 한 시간을 경계로 둔다.
  const cycle = (payload.collectIntervals && payload.collectIntervals.realtimeMinutes) || 5;
  const staleLimit = Math.max(cycle * 12, 60);
  const lagProblems = [];

  console.log(
    `우리 데이터가 얼마나 묵었나 (수집 주기 ${cycle}분 · ${staleLimit}분 넘으면 수집이 멈춘 것으로 본다)`
  );
  for (const store of payload.storeStatus || []) {
    for (const group of store.groups || []) {
      const ours = Date.parse(group.collectedAt || "");
      if (!Number.isFinite(ours)) continue;

      const age = Math.round((Date.now() - ours) / 60000);
      const where = `${store.storeId} ${group.label}`;
      const basis = group.sourceStamp ? `  (서점 기준 ${group.sourceStamp})` : "";

      if (age <= staleLimit) {
        console.log(`  OK     ${where.padEnd(18)} ${age}분 전${basis}`);
      } else {
        console.log(`  묵음   ${where.padEnd(18)} ${age}분 전 — ${staleLimit}분 초과${basis}`);
        lagProblems.push(`${where} ${age}분 전`);
      }
    }
  }
  console.log("");

  console.log(`고정 목록(주간·일간·분야) 일치 ${fixedOk}건 · 불일치 ${fixedProblems.length}건`);
  console.log(`실시간 시차 ${realtimeDrift.length}건 (서점이 계속 바꾸는 값이라 정상)`);
  console.log(`확인 못 함 ${skipped}건 (교보는 목록을 HTML로 주지 않음)`);

  if (realtimeDrift.length) {
    console.log("\n실시간 시차 (참고):");
    realtimeDrift.slice(0, 5).forEach((n) => console.log(`  ${n}`));
    if (realtimeDrift.length > 5) console.log(`  … ${realtimeDrift.length - 5}건 더`);
  }

  if (fixedProblems.length) {
    console.log("\n고정 목록 불일치 — 이건 버그다:");
    fixedProblems.forEach((n) => console.log(`  ${n}`));
    process.exit(1);
  }

  if (lagProblems.length) {
    console.log("\n데이터가 묵었다 — 수집이 돌고 있는지 봐야 한다:");
    lagProblems.forEach((n) => console.log(`  ${n}`));
    process.exit(1);
  }

  console.log("\n고정 목록은 서점과 일치하고, 데이터도 한 주기 안이다.");
})().catch((error) => {
  console.error("검사 자체가 실패했습니다:", error);
  process.exit(2);
});
