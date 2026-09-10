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
// 종료 코드:
//   0  고정 목록이 서점과 일치하고, 데이터도 제 주기 안이다
//   1  고정 목록이 서점과 어긋난다 — 버그다. 수집을 멈춰야 한다
//      (한 번 어긋난 것만으로는 판정하지 않는다. 페이지를 새로 받아 두 번 다
//       어긋나야 1이다 — 서점이 한 번 이상한 쪽을 내주는 일이 실제로 있었다)
//   2  검사 자체가 실패했다 (네트워크·파싱)
//   3  값은 맞지만 데이터가 묵었다 — 경고다. 수집을 멈추면 안 된다
//
// 3을 1과 나눠 둔 이유: 묵음은 "수집이 멈췄다"는 *증상*이다. 그걸로 수집
// 루프를 죽이면, 한 번 멈춘 수집이 스스로 되살아날 수 없는 교착이 된다.
// 실제로 그렇게 갇혔다 — 점화될 때마다 한 번 긁고 검사에서 죽었다.

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

// 서점 페이지에서 그 책을 찾아 우리 값과 맞춰 본다. 맞으면 빈 문자열,
// 어긋나면 어떻게 어긋났는지를 돌려준다.
function compare(onPage, item) {
  const hit = onPage.find((x) => norm(x.title) === norm(item.title));

  if (!hit) return `화면 ${item.rank}위인데 서점 페이지에 없음`;
  if (hit.rank === Number(item.rank)) return "";

  return `화면 ${item.rank}위 / 서점 ${hit.rank}위`;
}

const pageCache = new Map();

async function storeRanks(list, options = {}) {
  if (!options.fresh && pageCache.has(list.id)) return pageCache.get(list.id);

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
  // 고정 목록이 어긋난 건. 서점 페이지를 새로 받아 한 번 더 확인한 뒤에 판정한다.
  const suspects = [];
  // 같은 목록을 의심 건마다 다시 받지 않는다 — 서점을 두들기지 않기 위해서다.
  const refetched = new Set();
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

      const verdict = compare(onPage, item);
      const where = `${book.title} · ${item.storeName} · ${item.listName}`;

      if (!verdict) {
        if (!item.realtime) fixedOk++;
        continue;
      }

      if (item.realtime) {
        realtimeDrift.push(`${where} → ${verdict}`);
        continue;
      }

      // 고정 목록이 어긋났다. 여기서 바로 "버그"라고 부르지 않는다 — 서점이
      // 한 번 이상한 쪽을 내주는 일이 실제로 있었고(알라딘 경제경영 주간),
      // 그 한 번으로 수집 루프가 exit 1 로 죽어 몇 시간이 비었다. 우리 값은
      // 맞았고 서점 응답이 일시적이었다. 그래서 의심만 적어 두고, 아래에서
      // 페이지를 새로 받아 한 번 더 확인한 뒤에 판정한다.
      suspects.push({ where, item, list });
    }
  }

  // ── 의심 건 재확인 ──────────────────────────────────────────────────
  // 캐시를 버리고 서점 페이지를 새로 받는다. 두 번 다 어긋나야 버그다.
  if (suspects.length) {
    console.log(`\n어긋난 ${suspects.length}건 재확인 — 서점 페이지를 새로 받는다`);
  }

  for (const s of suspects) {
    const fresh = !refetched.has(s.list.id);
    refetched.add(s.list.id);
    const onPage = await storeRanks(s.list, { fresh });

    if (!onPage.length) {
      // 두 번째에는 페이지를 못 읽었다. 우리 값이 틀렸다는 근거가 못 된다.
      console.log(`  ? ${s.where} — 재확인 때 서점 페이지를 못 읽어 판정 보류`);
      skipped++;
      continue;
    }

    const verdict = compare(onPage, s.item);

    if (!verdict) {
      console.log(`  ~ ${s.where} — 처음엔 어긋났으나 재확인에서 일치 (서점 일시 응답)`);
      fixedOk++;
      continue;
    }

    fixedProblems.push(`${s.where} → ${verdict}`);
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
  // 임계값을 전 그룹 일괄로 두면 안 된다. 주간·일간·월간은 설계상 6시간마다
  // 모으므로(collectIntervals.standardHours), 60분을 들이대면 건강한 수집도
  // 6시간 중 5시간은 "묵음"으로 찍힌다. 그래서 각 그룹이 스스로 밝힌 다음
  // 갱신 예정 시각(nextRefreshAt)을 기준으로 삼는다 — 그게 이 시스템이
  // 약속한 주기다. 그 시각을 지나고도 유예를 넘겨 안 들어오면 멈춘 것이다.
  const cycle = (payload.collectIntervals && payload.collectIntervals.realtimeMinutes) || 5;
  const grace = Math.max(cycle * 4, 30);
  const lagProblems = [];

  console.log(`우리 데이터가 얼마나 묵었나 (갱신 예정 시각 + 유예 ${grace}분을 넘기면 멈춘 것으로 본다)`);
  for (const store of payload.storeStatus || []) {
    for (const group of store.groups || []) {
      // collectedAt 은 값이 바뀐 시각이라 순위가 조용하면 움직이지 않는다.
      // "수집이 돌고 있나"를 보려면 마지막으로 서점을 열어 본 시각을 봐야 한다.
      const ours = Date.parse(group.checkedAt || group.collectedAt || "");
      if (!Number.isFinite(ours)) continue;

      const age = Math.round((Date.now() - ours) / 60000);
      const where = `${store.storeId} ${group.label}`;
      const basis = group.sourceStamp ? `  (서점 기준 ${group.sourceStamp})` : "";

      // nextRefreshAt이 없으면 실시간 주기로 되돌아간다.
      const due = Date.parse(group.nextRefreshAt || "");
      const deadline = (Number.isFinite(due) ? due : ours + cycle * 60000) + grace * 60000;
      const over = Math.round((Date.now() - deadline) / 60000);

      if (over <= 0) {
        console.log(`  OK     ${where.padEnd(18)} ${age}분 전${basis}`);
      } else {
        console.log(`  묵음   ${where.padEnd(18)} ${age}분 전 — 예정보다 ${over}분 늦음${basis}`);
        lagProblems.push(`${where} ${age}분 전 (예정보다 ${over}분 늦음)`);
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
    console.log("\n데이터가 묵었다 — 값은 맞지만 수집이 늦다 (경고, 수집은 계속한다):");
    lagProblems.forEach((n) => console.log(`  ${n}`));
    process.exit(3);
  }

  console.log("\n고정 목록은 서점과 일치하고, 데이터도 제 주기 안이다.");
})().catch((error) => {
  console.error("검사 자체가 실패했습니다:", error);
  process.exit(2);
});
