"use strict";

// Vercel 진입점. server.js의 요청 핸들러를 그대로 서버리스 함수로 내보낸다.
// server.js는 require.main 가드가 있어 여기서 불러도 리스너를 열지 않는다.
const { handleServerlessRequest } = require("../server.js");

module.exports = handleServerlessRequest;
