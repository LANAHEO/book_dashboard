"use strict";

// .env 의 Supabase 설정을 점검합니다.
//   node scripts/check-env.js          형식만 검사
//   node scripts/check-env.js --live   REST 엔드포인트와 테이블 존재까지 확인
// 키 값은 절대 출력하지 않습니다.

const fs = require("fs");

const TABLES = ["source_snapshots", "dashboard_snapshots"];

function readEnvFile(file) {
  const env = {};
  const raw = fs.readFileSync(file, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function checkUrl(value) {
  if (!value) {
    return { ok: false, detail: "비어 있음" };
  }

  let host;
  try {
    host = new URL(value).host;
  } catch (error) {
    return { ok: false, detail: `URL 파싱 실패 (${value})` };
  }

  // 브라우저 대시보드 주소를 붙여넣는 실수가 가장 흔합니다.
  if (host === "supabase.com" || host === "app.supabase.com") {
    const ref = value.match(/\/dashboard\/project\/([a-z0-9]+)/i);
    const hint = ref ? `https://${ref[1]}.supabase.co` : "https://<project-ref>.supabase.co";
    return { ok: false, detail: `대시보드 주소입니다. API 주소로 바꾸세요 → ${hint}` };
  }

  if (!/\.supabase\.(co|in)$/.test(host)) {
    return { ok: false, detail: `Supabase 호스트가 아닙니다 (${host})` };
  }

  return { ok: true, detail: host };
}

function checkKey(value) {
  if (!value) {
    return { ok: false, detail: "비어 있음" };
  }

  // 신형 시크릿 키
  if (value.startsWith("sb_secret_")) {
    return { ok: true, detail: `신형 secret 키 (${value.length}자)` };
  }

  // 신형 publishable 키는 서버 쓰기 권한이 없습니다.
  if (value.startsWith("sb_publishable_")) {
    return {
      ok: false,
      detail: "publishable 키입니다. 서버는 secret 키(sb_secret_...)가 필요합니다"
    };
  }

  // 구형 JWT 키
  if (value.startsWith("eyJ")) {
    if (value.split(".").length !== 3) {
      return { ok: false, detail: "JWT 형태가 깨졌습니다 (점으로 구분된 3조각이 아님)" };
    }
    return { ok: true, detail: `구형 service_role JWT (${value.length}자)` };
  }

  return {
    ok: false,
    detail: `알 수 없는 키 형식 (${value.length}자). sb_secret_... 또는 eyJ... 이어야 합니다`
  };
}

async function checkLive(url, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const results = [];

  try {
    const response = await fetch(`${url}/rest/v1/`, { headers });
    results.push({
      label: "REST 접속",
      ok: response.ok,
      detail: response.ok ? "인증 통과" : `HTTP ${response.status}`
    });

    if (!response.ok) {
      return results;
    }
  } catch (error) {
    results.push({ label: "REST 접속", ok: false, detail: error.message });
    return results;
  }

  for (const table of TABLES) {
    try {
      const response = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, { headers });
      if (response.ok) {
        results.push({ label: `테이블 ${table}`, ok: true, detail: "존재함" });
        continue;
      }

      const body = await response.text();
      const missing = body.includes("PGRST205") || response.status === 404;
      results.push({
        label: `테이블 ${table}`,
        ok: false,
        detail: missing
          ? "없음 → supabase/schema.sql 을 SQL Editor에서 실행하세요"
          : `HTTP ${response.status}`
      });
    } catch (error) {
      results.push({ label: `테이블 ${table}`, ok: false, detail: error.message });
    }
  }

  return results;
}

async function main() {
  const env = readEnvFile(".env");
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const checks = [
    { label: "SUPABASE_URL", ...checkUrl(url) },
    { label: "SUPABASE_SERVICE_ROLE_KEY", ...checkKey(key) }
  ];

  if (process.argv.includes("--live") && checks.every((check) => check.ok)) {
    checks.push(...(await checkLive(url.replace(/\/$/, ""), key)));
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK  " : "FAIL"} ${check.label}: ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok).length;
  if (failed) {
    console.log(`\n${failed}개 항목이 실패했습니다.`);
    process.exitCode = 1;
  } else {
    console.log("\n모두 통과했습니다.");
  }
}

main();
