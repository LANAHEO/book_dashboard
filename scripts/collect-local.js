"use strict";

// 작업자 로컬에서 수집기를 돌려 본다. 기본값이 dry-run 이라 Supabase 에는 쓰지 않는다.
//
//   npm run collect:once     한 회차만 돌고 끝낸다. 파서를 고친 뒤 이걸로 확인한다.
//   npm run collect:dry      5분마다 계속 돈다(Ctrl+C 로 끈다).
//
// 세 서점을 모두 직접 받는다 — 로컬은 한국 IP 라 알라딘도 막히지 않는다.
// 셸에서 준 환경변수는 건드리지 않는다. 아래 값들은 .env 보다 먼저 채워지므로
// .env 에 COLLECT_DRY_RUN=0 을 적어 두어도 로컬은 dry-run 으로 돈다 — 실수로
// 저장하지 않게 일부러 그렇게 둔다. 진짜로 저장해 보려면 셸에서
// COLLECT_DRY_RUN=0 npm run collect:once 처럼 직접 준다. 그러면 지금 수집기
// (GitHub Actions)가 쓰는 값을 덮어쓰니 그 수집기를 끈 다음에만 한다.
//
// Windows 에서도 돌도록 npm 스크립트에 환경변수를 인라인으로 쓰지 않고 여기서 채운다.

const defaults = {
  COLLECT_DRY_RUN: "1",
  COLLECT_STORES: "kyobo,yes24,aladin",
  SNAPSHOT_WRITER: "1",
  // 로컬에서 Vercel 에 알라딘을 부탁하지 않는다.
  VERCEL_COLLECT_STORES: ""
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

require("./collector.js");
