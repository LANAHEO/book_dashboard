"use strict";

// Vercel 진입점. server.js의 요청 핸들러를 그대로 서버리스 함수로 내보낸다.
// server.js는 require.main 가드가 있어 여기서 불러도 리스너를 열지 않는다.
//
// require와 실행을 모두 감싸는 이유: 여기서 무엇이 터지면 Vercel은
// FUNCTION_INVOCATION_FAILED 라는 이름만 보여 주고 이유는 대시보드 로그에만 남는다.
// 원인을 응답 본문으로 돌려주면 브라우저에서 바로 읽을 수 있다.

let loadError = null;
let handleServerlessRequest = null;

try {
  ({ handleServerlessRequest } = require("../server.js"));
} catch (error) {
  loadError = error;
}

function describe(error) {
  return {
    error: "함수 실행이 실패했습니다.",
    message: String((error && error.message) || error),
    stack: String((error && error.stack) || "")
      .split("\n")
      .slice(0, 12),
    node: process.version,
    cwd: process.cwd(),
    dirname: __dirname,
    hasSupabaseUrl: Boolean(process.env.SUPABASE_URL),
    hasSupabaseKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    vercel: process.env.VERCEL || null,
    region: process.env.VERCEL_REGION || null
  };
}

function sendFailure(response, error) {
  const body = JSON.stringify(describe(error), null, 2);

  try {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(body);
  } catch (sendError) {
    // 응답조차 못 쓰는 상황이면 로그에만 남긴다.
    console.error("[api] failed to report error:", sendError);
  }
}

module.exports = async (request, response) => {
  if (loadError) {
    console.error("[api] module load failed:", loadError);
    sendFailure(response, loadError);
    return;
  }

  try {
    await handleServerlessRequest(request, response);
  } catch (error) {
    console.error("[api] request failed:", error);

    if (!response.headersSent) {
      sendFailure(response, error);
    } else {
      try {
        response.end();
      } catch (endError) {
        console.error("[api] failed to close response:", endError);
      }
    }
  }
};
