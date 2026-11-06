"use strict";

// GitHub Actions 수집기. 교보·예스24 를 모으고 화면이 읽는 스냅샷을 만든다.
// 알라딘은 해외 접속을 막아서 PC 로컬 서버가 맡는다(server.js "누가 어느 서점을
// 모으는가" 참고). 이 수집기는 PC 가 남긴 알라딘 행이 바뀌었는지만 보고 스냅샷에 싣는다.
//
//   node scripts/collector.js --until <마감 epoch초> [--first-scope all] [--problems <파일>]
//
// 한 프로세스가 마감까지 살아 있으면서 5분마다 돈다. 회차마다 새로 띄우면 메모리가
// 비어서 매번 Supabase 에서 목록 230여 개(약 11MB)를 다시 읽게 된다.
//
// 제1 규칙은 collect.yml 과 같다: 어떤 실패도 이 순환을 끝내지 않는다. 문제는
// 모아 두었다가 마감 때 --problems 파일에 적고, 판정(실행을 빨갛게 할지)은
// 워크플로가 한다. 이 프로세스는 마감에 닿았을 때만 0 으로 끝난다.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const server = require("../server.js");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];

    if (key.startsWith("--")) {
      args[key.slice(2)] = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

// 시계의 5분 경계 + 60초(:01 :06 :11 …)에 깨운다. 교보 실시간은 매시 정각에 새
// 기준을 올리므로 정각 직후에 들여다봐야 1분 안에 잡는다. 0초로 두면 서점이 갈아
// 끼우는 순간과 겹쳐 이전 기준을 받을 수 있다. PC 의 알라딘 수집은 경계(+0초)에
// 돌므로, 그쪽이 바꾼 값도 이 회차가 바로 싣는다.
const INTERVAL_MS = server.COLLECT_INTERVAL_MINUTES * 60 * 1000;
const OFFSET_MS = 60 * 1000;

// 일간·주간·월간까지 훑는 전수 수집은 6시간에 한 번(UTC 00·06·12·18시).
const ALL_SCOPE_HOURS = new Set([0, 6, 12, 18]);

// 순위 대조 검사는 서점 페이지를 여러 장 여는 일이라 한 시간에 한 번.
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

const problems = new Set();
let staleWarn = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stamp() {
  return new Date().toISOString().slice(11, 19) + "Z";
}

// 어디서 던져진 것이든 순환을 끝내지 않는다. 기록만 한다.
process.on("unhandledRejection", (error) => {
  console.error(`${stamp()} 처리되지 않은 거부:`, error);
});

function describeResult(result) {
  if (!result.ok) {
    return `실패 — ${result.error || result.storageError || "알 수 없음"}`;
  }

  const probe = (result.probe || [])
    .map((entry) => `${entry.storeId}:${entry.ok ? (entry.changed ? "바뀜" : "같음") : "실패"}`)
    .join(" ");
  const foreign = (result.foreignChanged || []).length
    ? ` · 다른 수집기 행 ${result.foreignChanged.length}개 바뀜`
    : "";
  const action = result.skipped ? "건너뜀" : "스냅샷 다시 씀";

  return `${action}${probe ? ` · ${probe}` : ""}${foreign}`;
}

// 서점 페이지를 직접 열어 배포된 화면의 순위와 견준다. 결과로 순환을 멈추지 않는다
// — 검사가 수집을 멈추게 했다가 네 번 당했다(collect.yml 맨 위 설명).
function runRankCheck() {
  const base = String(process.env.BASE_URL || "").trim();

  if (!base) {
    console.log("--- 순위 대조 검사 건너뜀 (BASE_URL 없음)");
    return;
  }

  console.log("--- 순위 대조 검사");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "check-ranks.js"), "--base", base, "--books", "4"],
    { stdio: "inherit", timeout: CHECK_TIMEOUT_MS }
  );

  switch (result.status) {
    case 0:
      console.log("--- 검사 통과");
      staleWarn = false;
      break;
    case 3:
      console.log("--- 값이 묵었거나 묵은 값이 어긋난다. 기록만 하고 계속 수집한다.");
      staleWarn = true;
      break;
    case 1:
      console.log("--- 방금 가져온 값이 서점과 어긋난다. 기록만 하고 계속 수집한다.");
      problems.add("방금 가져온 값이 서점과 어긋난 적이 있다.");
      break;
    default:
      // 2(검사기가 배포나 서점 페이지를 못 엶)이거나 시간 초과. 수집의 문제가 아니다.
      console.log(`--- 검사기를 끝까지 돌리지 못했다(${result.status ?? "시간 초과"}). 계속 수집한다.`);
  }
}

function writeProblems() {
  if (staleWarn) {
    problems.add("마지막 검사에서 데이터가 묵어 있었다.");
  }

  if (args.problems && problems.size) {
    fs.appendFileSync(args.problems, [...problems].map((line) => `${line}\n`).join(""));
  }
}

async function main() {
  await server.ensureEnv();

  const deadline = Number(args.until) > 0 ? Number(args.until) * 1000 : Date.now() + 330 * 60 * 1000;
  let scope = args["first-scope"] === "all" ? "all" : "realtime";
  let lastAllHour = -1;
  let lastCheckHour = -1;
  let failStreak = 0;

  console.log(
    `${stamp()} 수집기 시작 — ${server.describeCollectRole()} · ${INTERVAL_MS / 60000}분 간격 · ${new Date(deadline).toISOString().slice(11, 16)}Z 까지`
  );

  for (;;) {
    const hour = new Date().getUTCHours();

    // 같은 시간에 두 번 돌지 않는다.
    if (ALL_SCOPE_HOURS.has(hour) && lastAllHour !== hour) {
      scope = "all";
      lastAllHour = hour;
    }

    try {
      const result = await server.runCollection({ scope });
      console.log(
        `${stamp()} scope=${scope.padEnd(8)} ${(result.elapsedMs / 1000 || 0).toFixed(1)}초 · ${describeResult(result)}`
      );
      failStreak = result.ok ? 0 : failStreak + 1;
    } catch (error) {
      failStreak += 1;
      console.error(`${stamp()} scope=${scope} 회차 실패:`, error);
    }

    // 연속 실패해도 멈추지 않는다. 계속 두드리다 상대가 돌아오면 그 순간 이어서
    // 모은다. 빨간 표시는 마감 때 낸다.
    if (failStreak >= 5) {
      problems.add("수집이 5회 넘게 연속 실패한 적이 있다.");
    }

    if (lastCheckHour !== hour) {
      lastCheckHour = hour;
      runRankCheck();
    }

    scope = "realtime";

    const now = Date.now();
    let next = Math.floor(now / INTERVAL_MS) * INTERVAL_MS + OFFSET_MS;

    // 회차가 길어져 경계를 지났으면 그다음 경계로 — 폴링 시각이 :01 :06 :11 … 에서
    // 벗어나지 않는다.
    while (next <= now) {
      next += INTERVAL_MS;
    }

    if (next >= deadline) {
      break;
    }

    await sleep(next - now);
  }

  console.log(`${stamp()} 수집기 마감`);
  writeProblems();
  process.exit(0);
}

main().catch((error) => {
  // 여기까지 왔으면 시작 자체가 실패한 것이다. 워크플로가 다시 띄운다.
  console.error(`${stamp()} 수집기가 시작하지 못했습니다:`, error);
  writeProblems();
  process.exit(1);
});
