"use strict";

// GitHub Actions 수집기. 교보·예스24 를 모으고 화면이 읽는 스냅샷을 만든다.
// 알라딘은 해외 접속을 막아서 이 러너에서는 못 받는다. 회차마다 Vercel(서울)에게
// 알라딘을 받아 달라고 부탁하고(collectRemoteRows), Vercel 이 남긴 알라딘 행이
// 바뀌었는지 보고 스냅샷에 싣는다(server.js "누가 어느 서점을 모으는가" 참고).
//
//   node scripts/collector.js --until <마감 epoch초> [--first-scope all] [--problems <파일>]
//   node scripts/collector.js --forever     마감 없이 계속 돈다(EKS 파드).
//   node scripts/collector.js --once        한 회차만 돌고 끝낸다(로컬 확인).
//
// COLLECT_DRY_RUN=1 이면 서점은 실제로 긁되 Supabase 에는 쓰지 않는다(server.js isDryRun).
// COLLECT_ALIVE_FILE 을 주면 회차마다 그 파일을 갱신한다 — 파드 liveness 검사가 본다.
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

    if (!key.startsWith("--")) {
      continue;
    }

    const next = argv[index + 1];

    // 값 없는 스위치(--once, --forever)도 받는다.
    if (next === undefined || next.startsWith("--")) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = next;
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

// 이 러너가 직접 못 받는 서점은 Vercel(서울)에게 받아 달라고 한다. 지금은 알라딘이다
// — 해외 접속을 막아 이 러너(미국)에서는 403 이지만 Vercel 에서는 받아진다.
// Vercel 은 받은 것을 목록 행으로만 남기고, 스냅샷은 이 수집기가 그 행을 읽어 만든다.
// Vercel 함수 상한(300초) 안에서 끝나야 한다. 전수 수집이 1분 남짓이다.
const REMOTE_STORES = String(process.env.VERCEL_COLLECT_STORES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const REMOTE_TIMEOUT_MS = 280 * 1000;

const problems = new Set();
let staleWarn = false;
let remoteFailStreak = 0;
let remoteSkipLogged = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 로그 시각은 한국 시간으로 날짜까지 찍는다. 파드 로그는 며칠씩 이어지고, 보는 사람이
// 서점 순위가 바뀐 시각(한국 시간)과 바로 견줄 수 있어야 한다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kst(ms = Date.now()) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

function stamp() {
  return `${kst()} KST`;
}

const STORE_LABEL = { kyobo: "교보", yes24: "예스24", aladin: "알라딘" };

// 이 회차에 서점에서 받은 목록과 Supabase 쓰기를 줄여 찍는다(server.js takeRoundStats).
//   서점  교보 3/3 · 예스24 2/2 · 알라딘 1/1        받은 목록/시도한 목록
//   저장  source_snapshots 3 · rank_history 1      (dry-run 이면 "건너뜀")
//   ✖ 실패 [교보] kyobo-realtime (교보 실시간) 4.1초 — HTTP 503 … · 대신 쓴 값: 메모리 값
function logRoundStats(stats) {
  const byStore = new Map();

  for (const entry of stats.fetched) {
    const row = byStore.get(entry.storeId) || { tried: 0, ok: 0, items: 0 };
    row.tried += 1;
    row.ok += entry.ok ? 1 : 0;
    row.items += entry.items || 0;
    byStore.set(entry.storeId, row);
  }

  const stores = [...byStore.entries()]
    .map(([id, row]) => `${STORE_LABEL[id] || id} ${row.ok}/${row.tried}(${row.items}권)`)
    .join(" · ");
  console.log(`    서점  ${stores || "받은 목록 없음(바뀐 서점 없음)"}`);

  const writes = Object.entries(stats.writes);
  if (writes.length) {
    const dry = server.isDryRun();
    const text = writes
      .map(([table, n]) => {
        const parts = [];
        if (n.ok) parts.push(`${n.ok}`);
        if (n.skipped) parts.push(`${n.skipped} 건너뜀`);
        if (n.failed) parts.push(`${n.failed} 실패`);
        return `${table} ${parts.join("/")}`;
      })
      .join(" · ");
    console.log(`    저장  ${text}${dry ? "  (dry-run)" : ""}`);
  }

  const failed = stats.fetched.filter((entry) => !entry.ok);
  for (const entry of failed) {
    console.log(
      `    ✖ 실패 [${STORE_LABEL[entry.storeId] || entry.storeId}] ${entry.id} (${entry.name}) ${(entry.ms / 1000).toFixed(1)}초 — ${entry.error} · 대신 쓴 값: ${entry.fallback}`
    );
  }

  const writeFailed = writes.reduce((sum, [, n]) => sum + n.failed, 0);
  return { failedLists: failed.length, writeFailed, tried: stats.fetched.length };
}

// 한 시간마다 지난 한 시간을 한 줄로 묶는다. 로그를 위로 넘겨 보지 않아도
// "이 시간대에 몇 번 돌았고 몇 번 실패했는지"를 바로 본다.
const hourly = { rounds: 0, failedRounds: 0, failedLists: 0, writeFailed: 0, maxMs: 0 };

function logHourly(label) {
  if (!hourly.rounds) {
    return;
  }

  console.log(
    `${stamp()} ■ 지난 1시간(${label}) 회차 ${hourly.rounds} · 실패 회차 ${hourly.failedRounds} · 실패 목록 ${hourly.failedLists} · 저장 실패 ${hourly.writeFailed} · 가장 긴 회차 ${(hourly.maxMs / 1000).toFixed(1)}초`
  );
  Object.assign(hourly, { rounds: 0, failedRounds: 0, failedLists: 0, writeFailed: 0, maxMs: 0 });
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
  const action = result.skipped
    ? "건너뜀"
    : server.isDryRun()
      ? "스냅샷 만듦(dry-run, 저장 안 함)"
      : "스냅샷 다시 씀";

  return `${action}${probe ? ` · ${probe}` : ""}${foreign}`;
}

// Vercel 에게 맡은 서점(알라딘)을 받아 달라고 한다. 실패해도 이 회차의 교보·예스24
// 수집은 그대로 한다. 연속으로 실패하면 마감 때 빨간 표시로 알린다.
async function collectRemoteRows(scope) {
  if (!REMOTE_STORES.length) {
    return;
  }

  const base = String(process.env.BASE_URL || "").trim().replace(/\/$/, "");
  const secret = String(process.env.COLLECT_SECRET || "").trim();

  if (!base || !secret) {
    if (!remoteSkipLogged) {
      remoteSkipLogged = true;
      console.log(`${stamp()} Vercel 수집 건너뜀 — BASE_URL 이나 COLLECT_SECRET 이 없다`);
      problems.add("Vercel 에 알라딘 수집을 부탁하지 못했다(BASE_URL 또는 COLLECT_SECRET 없음).");
    }
    return;
  }

  for (const store of REMOTE_STORES) {
    let line;
    let ok = false;

    try {
      const response = await fetch(
        `${base}/api/collect-rows?store=${encodeURIComponent(store)}&scope=${scope}`,
        {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
        }
      );
      const body = await response.json().catch(() => ({}));
      ok = response.ok && body.ok === true;
      const what = scope === "all" ? "전부 받음" : body.changed ? "바뀜, 다시 받음" : "같음";
      line = `HTTP ${response.status} · ${((body.elapsedMs || 0) / 1000).toFixed(1)}초 · ${ok ? what : body.error || "실패"}`;
    } catch (error) {
      line = `요청 실패 — ${error.message}`;
    }

    remoteFailStreak = ok ? 0 : remoteFailStreak + 1;
    console.log(`${stamp()} vercel:${store.padEnd(6)} scope=${scope.padEnd(8)} ${line}`);

    if (remoteFailStreak >= 5) {
      problems.add("Vercel 의 알라딘 수집이 5회 넘게 연속 실패한 적이 있다.");
    }
  }
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

// 회차가 끝날 때마다 갱신한다. 서점 요청이 어딘가에서 영영 걸려 루프가 멈추면
// 이 파일이 낡고, 파드의 liveness 검사가 컨테이너를 다시 띄운다.
function touchAliveFile() {
  const file = process.env.COLLECT_ALIVE_FILE;

  if (!file) {
    return;
  }

  try {
    fs.writeFileSync(file, `${new Date().toISOString()}\n`);
  } catch (error) {
    console.error(`${stamp()} alive 파일을 쓰지 못했다:`, error.message);
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

  const deadline = args.forever
    ? Number.POSITIVE_INFINITY
    : Number(args.until) > 0
      ? Number(args.until) * 1000
      : Date.now() + 330 * 60 * 1000;
  const until = Number.isFinite(deadline) ? `${kst(deadline).slice(11, 16)} KST 까지` : "마감 없음";
  let round = 0;
  let lastSummaryHour = new Date(Date.now() + KST_OFFSET_MS).getUTCHours();
  let scope = args["first-scope"] === "all" ? "all" : "realtime";
  let lastAllHour = -1;
  let lastCheckHour = -1;
  let failStreak = 0;

  console.log(
    `${stamp()} 수집기 시작 — ${server.describeCollectRole()} · ${args.once ? "한 회차만" : `${INTERVAL_MS / 60000}분 간격 · ${until}`}`
  );

  // 첫 회차(전수면 2분쯤)가 끝나기 전에 liveness 가 낡았다고 보지 않게 먼저 한 번 남긴다.
  touchAliveFile();

  for (;;) {
    const hour = new Date().getUTCHours();
    const kstHour = new Date(Date.now() + KST_OFFSET_MS).getUTCHours();

    if (kstHour !== lastSummaryHour) {
      logHourly(`${String(lastSummaryHour).padStart(2, "0")}시대`);
      lastSummaryHour = kstHour;
    }

    // 같은 시간에 두 번 돌지 않는다.
    if (ALL_SCOPE_HOURS.has(hour) && lastAllHour !== hour) {
      scope = "all";
      lastAllHour = hour;
    }

    round += 1;
    const roundStartedAt = Date.now();
    let roundOk = false;
    console.log(`${stamp()} ▶ 회차 #${round} 시작 scope=${scope}`);
    server.takeRoundStats(); // 회차 사이에 쌓인 것은 버리고 이 회차 것만 센다.

    // 알라딘을 먼저 받아 둔다. 그래야 바로 뒤의 스냅샷이 이번 회차의 알라딘을 싣는다.
    await collectRemoteRows(scope);

    try {
      const result = await server.runCollection({ scope });
      roundOk = Boolean(result.ok);
      console.log(
        `${stamp()} ${roundOk ? "✔" : "✖"} 회차 #${round} ${roundOk ? "끝" : "실패"} scope=${scope} ${(result.elapsedMs / 1000 || 0).toFixed(1)}초 · ${describeResult(result)}`
      );
      failStreak = roundOk ? 0 : failStreak + 1;
    } catch (error) {
      failStreak += 1;
      console.error(`${stamp()} ✖ 회차 #${round} 실패 scope=${scope}:`, error);
    }

    const counted = logRoundStats(server.takeRoundStats());
    hourly.rounds += 1;
    hourly.failedRounds += roundOk ? 0 : 1;
    hourly.failedLists += counted.failedLists;
    hourly.writeFailed += counted.writeFailed;
    hourly.maxMs = Math.max(hourly.maxMs, Date.now() - roundStartedAt);

    // 목록 하나가 실패한 것으로는 실행을 빨갛게 하지 않는다. 로그(✖ 실패 줄)와 시간 요약에만
    // 남긴다 — 서점 한 쪽의 일시적 시간 초과는 흔하고, 다음 회차가 다시 받는다.

    // 연속 실패해도 멈추지 않는다. 계속 두드리다 상대가 돌아오면 그 순간 이어서
    // 모은다. 빨간 표시는 마감 때 낸다.
    if (failStreak >= 5) {
      problems.add("수집이 5회 넘게 연속 실패한 적이 있다.");
    }

    touchAliveFile();

    if (args.once) {
      break;
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

    console.log(`    다음  ${kst(next).slice(11, 16)} KST`);
    await sleep(next - now);
  }

  logHourly("마감 전까지");
  console.log(`${stamp()} 수집기 마감 — 회차 ${round}번`);
  writeProblems();
  process.exit(args.once && failStreak > 0 ? 1 : 0);
}

main().catch((error) => {
  // 여기까지 왔으면 시작 자체가 실패한 것이다. 워크플로가 다시 띄운다.
  console.error(`${stamp()} 수집기가 시작하지 못했습니다:`, error);
  writeProblems();
  process.exit(1);
});
