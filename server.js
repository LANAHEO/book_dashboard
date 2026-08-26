"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

// 환경변수 값에 BOM(U+FEFF)이나 앞뒤 공백·줄바꿈이 함께 따라오는 일이 있다. Windows에서
// UTF-8 BOM으로 저장된 파일에서 복사해 붙여넣으면 그렇게 된다. 눈으로는 값이 멀쩡해
// 보이는데 URL은 파싱이 깨지고, 키는 헤더에 넣는 순간
// "Cannot convert argument to a ByteString ... value of 65279" 으로 터진다.
// 실제로 이 배포가 그 상태였고, 값이 보이는 대로가 아니어서 원인 찾기가 오래 걸렸다.
const UTF8_BOM = String.fromCharCode(0xfeff);

function cleanEnvValue(value) {
  const text = String(value == null ? "" : value);

  return (text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text).trim();
}

async function loadEnvFile() {
  try {
    const raw = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    // BOM으로 저장된 .env는 첫 줄의 키 이름이 BOM으로 시작해 그 변수만 조용히 사라진다.
    const body = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;

    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const index = trimmed.indexOf("=");
      if (index <= 0) {
        continue;
      }

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    // .env is optional until Supabase keys are configured.
  }
}

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const SOURCE_CACHE_DIR = path.join(__dirname, ".cache", "rankings");
// Vercel 함수의 파일 시스템은 읽기 전용이고, 써진다 해도 호출마다 사라진다.
// 그 환경에서는 파일 캐시를 건너뛰고 Supabase만 쓴다.
const FILE_CACHE_ENABLED = !process.env.VERCEL;
const DASHBOARD_SNAPSHOT_ID = "latest";

// 서점 실시간은 약 1시간, 일·주간은 더 느리게 바뀌므로 수집 주기를 맞춤.
const REALTIME_REFRESH_MS = 60 * 60 * 1000;
const STANDARD_REFRESH_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
// 지난 날짜의 순위는 다시 바뀌지 않으므로 한 번 받으면 오래 들고 있는다.
// 오늘·이번 달은 아직 집계가 끝나지 않았으니 STANDARD_REFRESH_MS를 쓴다.
const HISTORY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7";
const KYOBO_API_KEY =
  "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..x7JMnrhPjxKEljN6." +
  "_uV_zR5yMFoizFJ-exMkbYdExhGnI9L-C6mJOkHGw_XH2cq-vTBomkyhSFPhzL1e_" +
  "KDxiKL12lmOLwTW76XGFYk21Rv9Wwg0KHzk1v0pk2k_N6GBrrlkIxhB01ASoKU42w" +
  "Fghx0O.LovE487VgIlkk_1NZcEp_w";
const STANDARD_LIMIT = 20;
const RANK_LIMIT = 100;
const HOST_CONCURRENCY = 4;
// 예스24는 한 페이지에 24권, 알라딘은 50권만 내려준다.
const YES24_PAGES_FOR_100 = 5;
const ALADIN_PAGES_FOR_100 = 2;
const PERIOD_LABELS = {
  realtime: "실시간",
  daily: "일간",
  weekly: "주간",
  monthly: "월간"
};
// 서점이 순위를 실제로 어떤 기준으로 집계하는지. 우리 수집 주기와 다른 값이며,
// 이걸 보여 주지 않으면 "최근 업데이트 12:29"가 순위가 12:29 기준이라는 뜻으로
// 읽힌다. 교보는 API 스탬프(실시간 12:00 정각, 일간 전일, 주간 수~화, 월간 전월)로,
// 예스24는 페이지 문구로 확인했다. 알라딘은 어느 페이지에도 기준을 적지 않는다.
const STORE_CADENCE = {
  kyobo: {
    realtime: "매시 정각 기준",
    daily: "전일 판매 집계",
    weekly: "수~화 1주 집계",
    monthly: "전월 집계"
  },
  yes24: {
    realtime: "1시간 단위 업데이트",
    daily: "전일 판매 집계",
    // 과거 주를 조회할 수 있는 주별 목록으로 옮겼다. 종합 목록의 "최근 7일을 매일
    // 재집계"가 아니라 월~일로 끊은 고정 주다 — 표시도 그에 맞춰 바꿨다.
    weekly: "월~일 1주 집계"
  },
  // 알라딘은 어느 페이지에도 집계 기준을 적지 않아 관측으로 확인했다.
  // 두 번의 정시 경계(12시, 14시)에서 상위 20위 지문이 바뀌었고, 그 사이
  // 13~18분 구간은 완전히 고정이었다. 서점이 공표한 값이 아니라 관측값이므로
  // 화면에도 "관측"이라고 밝힌다.
  aladin: {
    realtime: "시간 단위로 관측됨"
  }
};

function getStoreCadence(storeId, period, realtime) {
  const table = STORE_CADENCE[storeId];

  if (!table) {
    return "";
  }

  return table[period || (realtime ? "realtime" : "")] || "";
}

const YES24_PERIOD_PATHS = {
  realtime: "realtimebestseller",
  daily: "daybestseller",
  // 주별 목록만 과거 주를 조회할 수 있다(saleYear·weekNo). 종합 베스트셀러
  // 경로(bestseller)는 날짜 파라미터를 받지 않는다.
  weekly: "weekbestseller"
};
const ALADIN_PERIOD_TYPES = {
  realtime: "NowBest",
  daily: "DailyBest",
  weekly: "Bestseller"
};
const WATCH_PUBLISHER_NAME = "상상스퀘어";
const WATCH_PUBLISHER_KEY = normalizePublisherKey(WATCH_PUBLISHER_NAME);
// 알라딘 출판사 검색으로 신간 목록을 받아 순위권 밖 도서까지 추적한다.
// 아래 목록은 수집과 저장된 캐시가 모두 실패했을 때만 쓰는 최소 목록이다.
const FOCUS_BOOK_TITLES = [
  "인생을 위한 최소한의 생각",
  "AI, 신의 탄생 인간의 종말",
  "스페이스X 일론 머스크"
];
const FOCUS_CATALOG_ID = "publisher-catalog";
const FOCUS_CATALOG_LIMIT = 20;
const FOCUS_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FOCUS_CATALOG_RETRY_MS = 10 * 60 * 1000;

// 일간·주간은 분야 코드로 직접 조회하지만, 교보문고는 분야별 실시간을 제공하지
// 않아 실시간만 전체 TOP 100을 분류 코드 앞 두 자리로 나눠서 만든다.
// 교보 베스트셀러 페이지(국내도서)의 분야 선택기를 그대로 옮긴 것이다. 27개.
// 코드는 /bestseller/online/{period}/domestic/{code} 경로에 들어가는 값이고,
// 화면의 분야를 하나씩 눌러 URL에서 읽어 확인했다. 이름도 그 페이지 표기 그대로다.
// 서점이 분야를 바꾸면 여기도 바뀌어야 한다 — 확인은 그 페이지에서 한다.
const KYOBO_CATEGORIES = [
  { name: "소설", code: "01" },
  { name: "시/에세이", code: "03" },
  { name: "인문", code: "05" },
  { name: "가정/육아", code: "07" },
  { name: "요리", code: "08" },
  { name: "건강", code: "09" },
  { name: "취미/실용/스포츠", code: "11" },
  { name: "경제/경영", code: "13" },
  { name: "자기계발", code: "15" },
  { name: "정치/사회", code: "17" },
  { name: "역사/문화", code: "19" },
  { name: "종교", code: "21" },
  { name: "예술/대중문화", code: "23" },
  { name: "중/고등참고서", code: "25" },
  { name: "기술/공학", code: "26" },
  { name: "외국어", code: "27" },
  { name: "과학", code: "29" },
  { name: "취업/수험서", code: "31" },
  { name: "여행", code: "32" },
  { name: "컴퓨터/IT", code: "33" },
  { name: "잡지", code: "35" },
  { name: "청소년", code: "38" },
  { name: "초등참고서", code: "39" },
  { name: "유아(0~7세)", code: "41" },
  { name: "어린이(초등)", code: "42" },
  { name: "만화", code: "47" },
  { name: "한국소개도서", code: "53" }
];
const KYOBO_CATEGORY_NOTE =
  "교보문고는 분야별 실시간 순위를 제공하지 않습니다. 전체 실시간 TOP 100에 든 책을 분야로 나눈 목록이며, 순위는 종합 순위 기준입니다.";
const KYOBO_REALTIME_SNAPSHOT_TTL_MS = 60 * 1000;

// 예스24 국내도서 분야 27개. categoryNumber는 베스트셀러 페이지의
// Product/Category/Display/001001XXX 링크에서 읽었고, 이름도 그 표기 그대로다
// (예: "경제 경영" — 붙여 쓰지 않는다).
const YES24_CATEGORIES = [
  { name: "가정 살림", categoryNumber: "001001001" },
  { name: "자연과학", categoryNumber: "001001002" },
  { name: "IT 모바일", categoryNumber: "001001003" },
  { name: "국어 외국어 사전", categoryNumber: "001001004" },
  { name: "청소년", categoryNumber: "001001005" },
  { name: "예술", categoryNumber: "001001007" },
  { name: "만화", categoryNumber: "001001008" },
  { name: "여행", categoryNumber: "001001009" },
  { name: "역사", categoryNumber: "001001010" },
  { name: "건강 취미", categoryNumber: "001001011" },
  { name: "대학교재", categoryNumber: "001001014" },
  { name: "수험서 자격증", categoryNumber: "001001015" },
  { name: "어린이", categoryNumber: "001001016" },
  { name: "인문", categoryNumber: "001001019" },
  { name: "인물", categoryNumber: "001001020" },
  { name: "종교", categoryNumber: "001001021" },
  { name: "사회 정치", categoryNumber: "001001022" },
  { name: "전집", categoryNumber: "001001023" },
  { name: "잡지", categoryNumber: "001001024" },
  { name: "경제 경영", categoryNumber: "001001025" },
  { name: "자기계발", categoryNumber: "001001026" },
  { name: "유아", categoryNumber: "001001027" },
  { name: "초등참고서", categoryNumber: "001001044" },
  { name: "소설/시/희곡", categoryNumber: "001001046" },
  { name: "에세이", categoryNumber: "001001047" },
  { name: "중등참고서", categoryNumber: "001001049" },
  { name: "고등참고서", categoryNumber: "001001050" }
];

// 알라딘 베스트셀러 페이지의 분야 30개. CID는 그 페이지의 wbest.aspx 링크에서
// 읽었다. "종합"(CID=0)은 이미 종합 목록으로 따로 수집하므로 넣지 않는다.
const ALADIN_CATEGORIES = [
  { name: "건강/취미", cid: "55890" },
  { name: "경제경영", cid: "170" },
  { name: "고전", cid: "2105" },
  { name: "과학", cid: "987" },
  { name: "달력/기타", cid: "4395" },
  { name: "대학교재/전문서적", cid: "8257" },
  { name: "만화/라이트노벨", cid: "2551" },
  { name: "사회과학", cid: "798" },
  { name: "소설/시/희곡", cid: "1" },
  { name: "수험서/자격증", cid: "1383" },
  { name: "어린이", cid: "1108" },
  { name: "에세이", cid: "55889" },
  { name: "여행", cid: "1196" },
  { name: "역사", cid: "74" },
  { name: "예술/대중문화", cid: "517" },
  { name: "외국어", cid: "1322" },
  { name: "요리/살림", cid: "1230" },
  { name: "유아", cid: "13789" },
  { name: "인문학", cid: "656" },
  { name: "자기계발", cid: "336" },
  { name: "잡지", cid: "2913" },
  { name: "장르소설", cid: "112011" },
  { name: "전집/중고전집", cid: "17195" },
  { name: "종교/역학", cid: "1237" },
  { name: "좋은부모", cid: "2030" },
  { name: "청소년", cid: "1137" },
  { name: "컴퓨터/모바일", cid: "351" },
  { name: "초등학교참고서", cid: "50246" },
  { name: "중학교참고서", cid: "76000" },
  { name: "고등학교참고서", cid: "76001" }
];

const cache = new Map();

const STORES = [
  {
    id: "kyobo",
    name: "교보문고",
    accent: "#2d8b57",
    softAccent: "rgba(45, 139, 87, 0.12)"
  },
  {
    id: "yes24",
    name: "예스24",
    accent: "#2156c9",
    softAccent: "rgba(33, 86, 201, 0.12)"
  },
  {
    id: "aladin",
    name: "알라딘",
    accent: "#a33c3c",
    softAccent: "rgba(163, 60, 60, 0.12)"
  }
];

// 서점끼리 같은 분야를 짝지은 표. 실시간·일간·주간처럼 세 서점을 나란히 보려면
// "이 분야"가 세 서점에서 각각 무엇인지 알아야 하는데, 서점마다 이름도 쪼갠
// 방식도 다르다 — 교보 "시/에세이"는 예스24·알라딘에서 "에세이"이고, 교보
// "중/고등참고서" 하나가 다른 두 서점에서는 중등·고등으로 갈린다(그래서 교보 25는
// 두 묶음에 함께 쓴다).
//
// 한 서점에만 있는 분야도 버리지 않는다. 빈 칸으로 두면 그 서점 자리만 비고
// 나머지는 그대로 보인다 — 알라딘 장르소설, 교보 한국소개도서가 그런 경우다.
const CATEGORY_GROUPS = [
  { key: "novel", label: "소설", kyobo: "01", yes24: "001001046", aladin: "1" },
  { key: "essay", label: "시·에세이", kyobo: "03", yes24: "001001047", aladin: "55889" },
  { key: "humanities", label: "인문", kyobo: "05", yes24: "001001019", aladin: "656" },
  { key: "economy", label: "경제·경영", kyobo: "13", yes24: "001001025", aladin: "170" },
  { key: "self", label: "자기계발", kyobo: "15", yes24: "001001026", aladin: "336" },
  { key: "society", label: "정치·사회", kyobo: "17", yes24: "001001022", aladin: "798" },
  { key: "history", label: "역사", kyobo: "19", yes24: "001001010", aladin: "74" },
  { key: "religion", label: "종교", kyobo: "21", yes24: "001001021", aladin: "1237" },
  { key: "art", label: "예술·대중문화", kyobo: "23", yes24: "001001007", aladin: "517" },
  { key: "science", label: "과학", kyobo: "29", yes24: "001001002", aladin: "987" },
  { key: "language", label: "외국어", kyobo: "27", yes24: "001001004", aladin: "1322" },
  { key: "it", label: "컴퓨터·IT", kyobo: "33", yes24: "001001003", aladin: "351" },
  { key: "travel", label: "여행", kyobo: "32", yes24: "001001009", aladin: "1196" },
  { key: "health", label: "건강·취미", kyobo: "09", yes24: "001001011", aladin: "55890" },
  { key: "home", label: "가정·육아", kyobo: "07", yes24: "001001001", aladin: "2030" },
  { key: "cooking", label: "요리", kyobo: "08", yes24: "", aladin: "1230" },
  { key: "magazine", label: "잡지", kyobo: "35", yes24: "001001024", aladin: "2913" },
  { key: "teen", label: "청소년", kyobo: "38", yes24: "001001005", aladin: "1137" },
  { key: "kids", label: "어린이", kyobo: "42", yes24: "001001016", aladin: "1108" },
  { key: "baby", label: "유아", kyobo: "41", yes24: "001001027", aladin: "13789" },
  { key: "comic", label: "만화", kyobo: "47", yes24: "001001008", aladin: "2551" },
  { key: "exam", label: "수험서·자격증", kyobo: "31", yes24: "001001015", aladin: "1383" },
  { key: "college", label: "대학교재", kyobo: "", yes24: "001001014", aladin: "8257" },
  { key: "elementary", label: "초등참고서", kyobo: "39", yes24: "001001044", aladin: "50246" },
  { key: "middle", label: "중등참고서", kyobo: "25", yes24: "001001049", aladin: "76000" },
  { key: "high", label: "고등참고서", kyobo: "25", yes24: "001001050", aladin: "76001" },
  { key: "sports", label: "취미·실용·스포츠", kyobo: "11", yes24: "", aladin: "" },
  { key: "tech", label: "기술·공학", kyobo: "26", yes24: "", aladin: "" },
  { key: "korea", label: "한국소개도서", kyobo: "53", yes24: "", aladin: "" },
  { key: "people", label: "인물", kyobo: "", yes24: "001001020", aladin: "" },
  { key: "collection", label: "전집", kyobo: "", yes24: "001001023", aladin: "17195" },
  { key: "genre", label: "장르소설", kyobo: "", yes24: "", aladin: "112011" },
  { key: "classic", label: "고전", kyobo: "", yes24: "", aladin: "2105" },
  { key: "etc", label: "달력·기타", kyobo: "", yes24: "", aladin: "4395" }
];

// 서점 분야 코드 → 묶음 키. 한 코드가 두 묶음에 쓰일 수 있어(교보 25) 배열로 둔다.
const CATEGORY_GROUP_BY_CODE = CATEGORY_GROUPS.reduce((map, group) => {
  for (const storeId of ["kyobo", "yes24", "aladin"]) {
    const code = group[storeId];

    if (!code) {
      continue;
    }

    const mapKey = `${storeId}:${code}`;
    map[mapKey] = map[mapKey] || [];
    map[mapKey].push(group.key);
  }

  return map;
}, {});

function categoryGroupKeys(storeId, code) {
  return CATEGORY_GROUP_BY_CODE[`${storeId}:${code}`] || [];
}

function makeCategorySource(options) {
  const { storeId, period, categoryName, id, sourceUrl, load } = options;
  const realtime = period === "realtime";

  return {
    id,
    storeId,
    name: `${categoryName} ${PERIOD_LABELS[period]}`,
    typeLabel: PERIOD_LABELS[period],
    categoryName,
    period,
    group: "category",
    groupKeys: categoryGroupKeys(storeId, options.categoryCode || ""),
    realtime,
    ttlMs: realtime ? REALTIME_REFRESH_MS : STANDARD_REFRESH_MS,
    paginate: options.paginate !== false,
    derived: options.derived === true,
    note: options.note || "",
    sourceUrl,
    load
  };
}

const KYOBO_CATEGORY_SOURCES = KYOBO_CATEGORIES.flatMap((category) => [
  makeCategorySource({
    storeId: "kyobo",
    period: "realtime",
    categoryName: category.name,
    categoryCode: category.code,
    id: `kyobo-realtime-${category.code}`,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/realtime",
    paginate: false,
    derived: true,
    note: KYOBO_CATEGORY_NOTE,
    load: () => fetchKyoboRealtimeList(category.code)
  }),
  makeCategorySource({
    storeId: "kyobo",
    period: "daily",
    categoryName: category.name,
    categoryCode: category.code,
    id: `kyobo-daily-${category.code}`,
    sourceUrl: `https://store.kyobobook.co.kr/bestseller/online/daily/domestic/${category.code}`,
    load: () => fetchKyoboCategoryList("001", category.code)
  }),
  makeCategorySource({
    storeId: "kyobo",
    period: "weekly",
    categoryName: category.name,
    categoryCode: category.code,
    id: `kyobo-weekly-${category.code}`,
    sourceUrl: `https://store.kyobobook.co.kr/bestseller/online/weekly/domestic/${category.code}`,
    load: () => fetchKyoboCategoryList("002", category.code)
  })
]);

const YES24_CATEGORY_SOURCES = YES24_CATEGORIES.flatMap((category) =>
  ["realtime", "daily", "weekly"].map((period) => {
    const sourceUrl = makeYes24Url(period, category.categoryNumber);

    return makeCategorySource({
      storeId: "yes24",
      period,
      categoryName: category.name,
      categoryCode: category.categoryNumber,
      id: `yes24-${period}-${category.categoryNumber}`,
      sourceUrl,
      load: () =>
        fetchYes24List(sourceUrl, {
          limit: RANK_LIMIT,
          // 실시간 페이지만 한 번에 100권을 내려준다.
          pages: period === "realtime" ? 1 : YES24_PAGES_FOR_100
        })
    });
  })
);

// 알라딘이 실제로 내주지 않는 분야×기간 조합. 없는 조합을 계속 부르면 수집이
// 매번 오류 2건으로 끝나고, 그러면 진짜 고장과 구분이 안 된다. 직접 확인했다 —
// 장르소설 실시간과 전집/중고전집 일간은 목록 자체가 없고(잡히는 항목 1개는 광고),
// 같은 분야의 주간은 74권으로 멀쩡하다. 서점이 다시 열면 여기서 지우면 된다.
const ALADIN_MISSING_CATEGORY_PERIODS = new Set(["realtime:112011", "daily:17195"]);

const ALADIN_CATEGORY_SOURCES = ALADIN_CATEGORIES.flatMap((category) =>
  ["realtime", "daily", "weekly"]
    .filter(
      (period) => !ALADIN_MISSING_CATEGORY_PERIODS.has(`${period}:${category.cid}`)
    )
    .map((period) => {
    const sourceUrl = makeAladinUrl(period, category.cid);

    return makeCategorySource({
      storeId: "aladin",
      period,
      categoryName: category.name,
      categoryCode: category.cid,
      id: `aladin-${period}-${category.cid}`,
      sourceUrl,
      load: () =>
        fetchAladinList(sourceUrl, {
          limit: RANK_LIMIT,
          // 알라딘 분야 실시간(NowBest)은 30권이 끝이다. 수집해 보니 30개 분야
          // 전부 최대 30권이었다 — 둘째 쪽은 빈 응답인데, 분야가 30개라
          // 그 헛걸음이 그대로 수집 시간이 된다.
          pages: period === "realtime" ? 1 : ALADIN_PAGES_FOR_100
        })
    });
  })
);

const SOURCES = [
  {
    id: "kyobo-total-weekly",
    storeId: "kyobo",
    name: "종합 주간 베스트",
    typeLabel: "주간",
    period: "weekly",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/total/weekly",
    load: () =>
      fetchKyoboList("total", {
        page: 1,
        per: RANK_LIMIT,
        period: "002",
        bsslBksClstCode: "A"
      })
  },
  {
    id: "kyobo-online-daily",
    storeId: "kyobo",
    name: "온라인 베스트 일간",
    typeLabel: "일간",
    period: "daily",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/daily",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: RANK_LIMIT,
        period: "001",
        dsplDvsnCode: "001",
        dsplTrgtDvsnCode: "002",
        saleCmdtDsplDvsnCode: "TOT"
      })
  },
  {
    id: "kyobo-online-weekly",
    storeId: "kyobo",
    name: "온라인 베스트 주간",
    typeLabel: "주간",
    period: "weekly",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/weekly",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: RANK_LIMIT,
        period: "002",
        dsplDvsnCode: "001",
        dsplTrgtDvsnCode: "002",
        saleCmdtDsplDvsnCode: "TOT"
      })
  },
  {
    id: "kyobo-online-monthly",
    storeId: "kyobo",
    name: "온라인 베스트 월간",
    typeLabel: "월간",
    period: "monthly",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/monthly",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: RANK_LIMIT,
        period: "003",
        dsplDvsnCode: "001",
        dsplTrgtDvsnCode: "002",
        saleCmdtDsplDvsnCode: "TOT"
      })
  },
  {
    id: "kyobo-realtime",
    storeId: "kyobo",
    name: "실시간 베스트 TOP 100",
    typeLabel: "TOP 100",
    group: "overall-realtime",
    realtime: true,
    ttlMs: REALTIME_REFRESH_MS,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/realtime",
    load: () => fetchKyoboRealtimeList()
  },
  ...KYOBO_CATEGORY_SOURCES,
  {
    id: "yes24-realtime",
    storeId: "yes24",
    name: "실시간 베스트 TOP 100",
    typeLabel: "TOP 100",
    group: "overall-realtime",
    realtime: true,
    ttlMs: REALTIME_REFRESH_MS,
    sourceUrl: makeYes24Url("realtime", "001"),
    load: () => fetchYes24List(makeYes24Url("realtime", "001"), { limit: RANK_LIMIT })
  },
  {
    id: "yes24-bestseller",
    storeId: "yes24",
    name: "국내도서 종합 주간",
    typeLabel: "주간",
    period: "weekly",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: makeYes24Url("weekly", "001"),
    load: () =>
      fetchYes24List(makeYes24Url("weekly", "001"), {
        limit: RANK_LIMIT,
        pages: YES24_PAGES_FOR_100
      })
  },
  {
    id: "yes24-day",
    storeId: "yes24",
    name: "일별 베스트셀러",
    typeLabel: "일간",
    period: "daily",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: makeYes24Url("daily", "001"),
    load: () =>
      fetchYes24List(makeYes24Url("daily", "001"), {
        limit: RANK_LIMIT,
        pages: YES24_PAGES_FOR_100
      })
  },
  ...YES24_CATEGORY_SOURCES,
  {
    id: "aladin-now",
    storeId: "aladin",
    name: "지금 베스트 TOP 100",
    typeLabel: "TOP 100",
    group: "overall-realtime",
    realtime: true,
    ttlMs: REALTIME_REFRESH_MS,
    sourceUrl: makeAladinUrl("realtime"),
    load: () =>
      fetchAladinList(makeAladinUrl("realtime"), {
        limit: RANK_LIMIT,
        pages: ALADIN_PAGES_FOR_100
      })
  },
  {
    id: "aladin-daily",
    storeId: "aladin",
    name: "일간 베스트",
    typeLabel: "일간",
    period: "daily",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: makeAladinUrl("daily"),
    load: () =>
      fetchAladinList(makeAladinUrl("daily"), {
        limit: RANK_LIMIT,
        pages: ALADIN_PAGES_FOR_100
      })
  },
  {
    id: "aladin-weekly",
    storeId: "aladin",
    name: "주간 베스트",
    typeLabel: "주간",
    period: "weekly",
    group: "standard",
    realtime: false,
    ttlMs: STANDARD_REFRESH_MS,
    sourceUrl: makeAladinUrl("weekly"),
    load: () =>
      fetchAladinList(makeAladinUrl("weekly"), {
        limit: RANK_LIMIT,
        pages: ALADIN_PAGES_FOR_100
      })
  },
  ...ALADIN_CATEGORY_SOURCES
];

const sourceById = new Map(SOURCES.map((source) => [source.id, source]));

function getSourceCachePath(id) {
  return path.join(SOURCE_CACHE_DIR, `${id}.json`);
}

function getSupabaseConfig() {
  const url = cleanEnvValue(process.env.SUPABASE_URL).replace(/\/$/, "");
  const key = cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) {
    return null;
  }

  return { url, key };
}

async function supabaseRequest(pathname, options = {}) {
  const config = getSupabaseConfig();
  if (!config) {
    return null;
  }

  const response = await fetch(`${config.url}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase ${response.status}: ${body.slice(0, 200)}`);
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const SUPABASE_PROBE_TTL_MS = 30000;
let supabaseProbe = null;

// getSupabaseConfig only tells us the keys are present. This asks Supabase
// whether they actually work, so /api/health cannot report a dead link as ready.
// SUPABASE_URL에 브라우저 대시보드 주소를 붙여넣는 실수가 가장 흔하다. 그 주소는
// Vercel에 호스팅돼 있어서 /rest/v1/... 요청이 Supabase의 404가 아니라 Vercel의 404
// HTML로 돌아온다. 그러면 supabaseError에 "<!DOCTYPE html ... data-dpl-id" 조각만 찍혀
// 정작 고칠 값이 안 보인다 — 실제로 프로덕션이 그 상태였다. scripts/check-env.js가 로컬
// .env에만 하던 검사를 돌고 있는 서버에서도 해서, /api/health가 바꿀 값을 그대로 알려 준다.
const SUPABASE_API_HOST_SUFFIXES = [".supabase.co", ".supabase.in"];
const SUPABASE_DASHBOARD_HOSTS = ["supabase.com", "app.supabase.com"];
const SUPABASE_DASHBOARD_PATH = "/dashboard/project/";

function describeSupabaseUrlProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return `SUPABASE_URL을 URL로 읽을 수 없습니다 (${url})`;
  }

  if (SUPABASE_DASHBOARD_HOSTS.includes(parsed.host)) {
    const at = parsed.pathname.indexOf(SUPABASE_DASHBOARD_PATH);
    const ref =
      at === -1
        ? ""
        : parsed.pathname.slice(at + SUPABASE_DASHBOARD_PATH.length).split("/")[0];
    const hint = ref ? `https://${ref}.supabase.co` : "https://<project-ref>.supabase.co";

    return `SUPABASE_URL이 대시보드 주소입니다. API 주소로 바꾸세요 → ${hint}`;
  }

  if (!SUPABASE_API_HOST_SUFFIXES.some((suffix) => parsed.host.endsWith(suffix))) {
    return `SUPABASE_URL이 Supabase 호스트가 아닙니다 (${parsed.host})`;
  }

  return "";
}

async function probeSupabase() {
  const config = getSupabaseConfig();
  if (!config) {
    return { reachable: false, error: "not configured" };
  }

  // 형식이 틀린 주소는 쏘아 볼 필요가 없다. 응답 본문을 잘라 붙이는 대신
  // 무엇을 어떻게 바꿔야 하는지 그대로 돌려준다.
  const urlProblem = describeSupabaseUrlProblem(config.url);
  if (urlProblem) {
    return { reachable: false, error: urlProblem };
  }

  if (supabaseProbe && Date.now() - supabaseProbe.at < SUPABASE_PROBE_TTL_MS) {
    return supabaseProbe.result;
  }

  let result;
  try {
    await supabaseRequest("dashboard_snapshots?select=id&limit=1");
    result = { reachable: true, error: null };
  } catch (error) {
    const message = String(error.message || error);
    result = {
      reachable: false,
      error: message.includes("PGRST205")
        ? "table missing — run supabase/schema.sql"
        : message.slice(0, 120)
    };
  }

  supabaseProbe = { at: Date.now(), result };
  return result;
}

async function writeSupabaseSource(id, payload, expiresAt) {
  if (!getSupabaseConfig()) {
    return false;
  }

  await supabaseRequest("source_snapshots?on_conflict=id", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id,
      payload,
      expires_at: new Date(expiresAt).toISOString(),
      updated_at: new Date().toISOString()
    })
  });

  return true;
}

async function readSupabaseSource(id) {
  if (!getSupabaseConfig()) {
    return null;
  }

  const rows = await supabaseRequest(
    `source_snapshots?id=eq.${encodeURIComponent(id)}&select=payload,expires_at&limit=1`
  );

  if (!Array.isArray(rows) || !rows[0] || !rows[0].payload) {
    return null;
  }

  return {
    payload: rows[0].payload,
    expiresAt: rows[0].expires_at ? Date.parse(rows[0].expires_at) : 0
  };
}

async function writeDashboardSnapshot(payload) {
  if (!FILE_CACHE_ENABLED) {
    return;
  }

  try {
    await fs.mkdir(SOURCE_CACHE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SOURCE_CACHE_DIR, "dashboard-latest.json"),
      JSON.stringify({
        payload,
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
  } catch (error) {
    console.error("[cache] failed to persist dashboard snapshot:", error);
  }

  if (!getSupabaseConfig()) {
    return false;
  }

  await supabaseRequest("dashboard_snapshots?on_conflict=id", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id: DASHBOARD_SNAPSHOT_ID,
      payload,
      updated_at: new Date().toISOString()
    })
  });

  return true;
}

async function readLocalDashboardSnapshot() {
  try {
    const raw = await fs.readFile(
      path.join(SOURCE_CACHE_DIR, "dashboard-latest.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.payload || !Array.isArray(parsed.payload.sections)) {
      return null;
    }

    return {
      payload: parsed.payload,
      updatedAt: parsed.updatedAt || parsed.payload.generatedAt || ""
    };
  } catch (error) {
    return null;
  }
}

async function readDashboardSnapshot() {
  if (getSupabaseConfig()) {
    try {
      const rows = await supabaseRequest(
        `dashboard_snapshots?id=eq.${encodeURIComponent(DASHBOARD_SNAPSHOT_ID)}&select=payload,updated_at&limit=1`
      );

      if (Array.isArray(rows) && rows[0] && rows[0].payload) {
        return {
          payload: rows[0].payload,
          updatedAt: rows[0].updated_at || "",
          source: "supabase"
        };
      }
    } catch (error) {
      console.error("[supabase] dashboard read failed:", error);
    }
  }

  const local = await readLocalDashboardSnapshot();
  if (!local) {
    return null;
  }

  return { ...local, source: "file" };
}

function rankHistoryKey(bookKey, storeId, listId) {
  return `${bookKey} ${storeId} ${listId}`;
}

// The newest timestamp already on file. Read this BEFORE inserting the current
// collection, otherwise "previous" resolves to the collection being written.
async function readPreviousCollectedAt() {
  const rows = await supabaseRequest(
    "rank_history?select=collected_at&order=collected_at.desc&limit=1"
  );

  return Array.isArray(rows) && rows[0] ? rows[0].collected_at || "" : "";
}

// One request for the whole previous collection. Looking each appearance up
// individually would be ~63 round trips per rebuild.
async function readRankHistoryAt(collectedAt) {
  if (!collectedAt) {
    return [];
  }

  // Explicit limit: PostgREST applies a server-side max-rows cap when one is
  // configured, and a silent truncation here would mark the missing entries NEW
  // and report them as dropouts at the same time. Ask for far more than a
  // collection can hold so a short read is a real signal, not a default.
  const rows = await supabaseRequest(
    `rank_history?collected_at=eq.${encodeURIComponent(collectedAt)}` +
      "&select=book_key,store_id,list_id,rank,title&limit=5000"
  );

  return Array.isArray(rows) ? rows : [];
}

async function writeRankHistory(rows) {
  if (!rows.length) {
    return;
  }

  // ignore-duplicates makes a retried collection idempotent against the
  // (book_key, store_id, list_id, collected_at) unique index.
  await supabaseRequest("rank_history?on_conflict=book_key,store_id,list_id,collected_at", {
    method: "POST",
    headers: {
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify(rows)
  });
}

function collectRankHistoryRows(focusBooks, collectedAt) {
  const rows = [];

  focusBooks.forEach((book) => {
    book.appearances.forEach((appearance) => {
      if (!book.bookKey || !appearance.rank) {
        return;
      }

      rows.push({
        book_key: book.bookKey,
        store_item_id: appearance.storeItemId || null,
        title: appearance.title || book.title,
        store_id: appearance.storeId,
        list_id: appearance.listId,
        rank: appearance.rank,
        collected_at: collectedAt
      });
    });
  });

  return rows;
}

// Enriches each appearance with its move since the previous collection, and
// records entries that were ranked last time but are absent now -- a book
// falling out of the charts is the signal you most want and it has no
// appearance left to hang a badge on.
function applyRankDeltas(focusBooks, previousRows, nameLookup) {
  const previousByKey = new Map(
    previousRows.map((row) => [rankHistoryKey(row.book_key, row.store_id, row.list_id), row])
  );
  const seen = new Set();

  focusBooks.forEach((book) => {
    book.appearances.forEach((appearance) => {
      // Match collectRankHistoryRows: an appearance we never store cannot have a
      // previous row, so annotating it would pin a permanent NEW badge on it.
      // Leaving it out of `seen` also means a rank we used to have and lost now
      // reads as a dropout, which is what it is.
      if (!book.bookKey || !appearance.rank) {
        return;
      }

      const key = rankHistoryKey(book.bookKey, appearance.storeId, appearance.listId);
      seen.add(key);

      const previous = previousByKey.get(key);
      if (!previous || !previous.rank) {
        appearance.isNew = true;
        return;
      }

      appearance.previousRank = previous.rank;
      // Positive means the book climbed: rank 12 -> 9 is +3.
      appearance.rankDelta = previous.rank - appearance.rank;
    });
  });

  const droppedByBook = new Map();
  previousByKey.forEach((row, key) => {
    if (seen.has(key)) {
      return;
    }

    const list = droppedByBook.get(row.book_key) || [];
    list.push({
      storeId: row.store_id,
      storeName: nameLookup.stores.get(row.store_id) || row.store_id,
      listId: row.list_id,
      listName: nameLookup.lists.get(row.list_id) || row.list_id,
      previousRank: row.rank
    });
    droppedByBook.set(row.book_key, list);
  });

  focusBooks.forEach((book) => {
    const dropped = droppedByBook.get(book.bookKey);
    if (dropped && dropped.length) {
      book.droppedOut = dropped.sort((a, b) => a.previousRank - b.previousRank);
      droppedByBook.delete(book.bookKey);
    }
  });

  // Whatever is left has no book in the current focus list to hang it on, which
  // means the book_key itself changed between collections -- a store retitled the
  // edition, so the same book now reads as NEW under one key while the old key's
  // dropout goes unreported. Log it so we learn how often that actually happens
  // before deciding whether to join on store_item_id instead.
  if (droppedByBook.size) {
    droppedByBook.forEach((entries, bookKey) => {
      console.warn(
        `[history] dropout not shown, book_key absent from focus list: ${bookKey} (${entries.length} listing(s))`
      );
    });
  }
}

function buildNameLookup(sections) {
  const stores = new Map();
  const lists = new Map();

  sections.forEach((section) => {
    stores.set(section.id, section.name);
    getSourceLists(section).forEach((list) => {
      lists.set(list.id, list.name);
    });
  });

  return { stores, lists };
}

async function writePersistedSource(id, payload, expiresAt) {
  if (!FILE_CACHE_ENABLED) {
    return;
  }

  try {
    await fs.mkdir(SOURCE_CACHE_DIR, { recursive: true });
    await fs.writeFile(
      getSourceCachePath(id),
      JSON.stringify({ payload, expiresAt }),
      "utf8"
    );
  } catch (error) {
    console.error(`[cache] failed to persist ${id}:`, error);
  }

  try {
    await writeSupabaseSource(id, payload, expiresAt);
  } catch (error) {
    console.error(`[supabase] failed to persist ${id}:`, error);
  }
}

async function readPersistedSource(id) {
  try {
    const fromSupabase = await readSupabaseSource(id);
    if (fromSupabase && fromSupabase.payload && Array.isArray(fromSupabase.payload.items)) {
      return fromSupabase;
    }
  } catch (error) {
    console.error(`[supabase] failed to read ${id}:`, error);
  }

  try {
    const raw = await fs.readFile(getSourceCachePath(id), "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed || !parsed.payload || !Array.isArray(parsed.payload.items)) {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function makeYes24Url(period, categoryNumber) {
  return `https://www.yes24.com/product/category/${YES24_PERIOD_PATHS[period]}?categoryNumber=${categoryNumber}`;
}

function makeYes24PageUrl(url, page) {
  if (page <= 1) {
    return url;
  }

  const pageUrl = new URL(url);
  pageUrl.searchParams.set("pageNumber", String(page));
  return pageUrl.toString();
}

function makeAladinUrl(period, cid = "") {
  const url = new URL("https://www.aladin.co.kr/shop/common/wbest.aspx");
  url.searchParams.set("BranchType", "1");
  url.searchParams.set("BestType", ALADIN_PERIOD_TYPES[period]);

  if (cid) {
    url.searchParams.set("CID", cid);
  }

  return url.toString();
}

// 서점이 빈 페이지를 200으로 돌려주는 일이 있다. 그대로 두면 "항목이 적은 성공"이
// 되어 loadSource가 직전 캐시로 물러나지 못하고, 1쪽이 비면 51위부터 시작하는
// 반쪽 목록이 그대로 화면에 올라간다. 실제로 알라딘 실시간에서 상위권이 통째로
// 사라진 적이 있다. 첫 쪽이 비면 수집 실패로 처리해 캐시를 지킨다.
function assertFirstPageParsed(storeLabel, url, perPage) {
  if (perPage.length && perPage[0].length === 0) {
    throw new Error(`${storeLabel} 첫 페이지에서 목록을 찾지 못했습니다: ${url}`);
  }
}

// 1위부터 시작하지 않으면 이유를 정확히 적는다. 비도서가 걸러진 것과 페이지가
// 통째로 비어 온 것은 원인이 다른데 예전에는 둘 다 "비도서 제외"로 나왔다.
function describeRankGap(items, perPage) {
  // 1위부터 시작하면 빠진 것이 없다. 뒤쪽 페이지가 비는 것은 분야별 실시간처럼
  // 목록 자체가 짧을 때 정상이므로, 그것만으로 경고를 띄우면 오탐이 된다.
  if (!items.length || items[0].rank <= 1) {
    return "";
  }

  // 이제 카테고리로 항목을 버리지 않으므로, 1위부터 시작하지 않는다면 남는 원인은
  // 페이지를 못 읽은 것뿐이다.
  return `일부 페이지를 읽지 못해 ${items[0].rank}위부터 표시합니다.`;
}

// 교보는 한 쪽에 담을 권수를 per로 정한다(page와 함께 보내야 먹는다). 우리는 언제나
// page=1로 1위부터 담고, per만 그 책이 들어갈 만큼 키운다.
//
// 1위부터 담는 이유: 쪽 번호로 20권씩 끊으면 우리가 저장한 순위와 교보의 지금 순위가
// 어긋나 그 책이 그 쪽에 아예 없는 일이 생긴다 — 실측 일간 11%, 주간 10%, 실시간 39%.
// 그러면 스크롤할 대상이 없어 "눌렀는데 안 넘어간다"가 된다. 1위부터 담으면 순위가
// 흔들려도 100위 안에 있는 한 그 책은 페이지에 남는다.
//
// per를 100으로 고정하지 않는 이유: 교보 목록은 클라이언트 렌더링이라 다 그려진 뒤에야
// 텍스트 조각이 걸린다. 그릴 권수가 그대로 대기 시간이 된다. 실시간 33위 실측으로
// per=100은 9.5초, per=60은 5.5초, per=40은 3.7초였다.
const KYOBO_PAGE_STEP = 20;
const KYOBO_MIN_PAGE_SIZE = 40;
const KYOBO_MAX_PAGE_SIZE = 100;

function makeKyoboPageUrl(url, rank) {
  const pageUrl = new URL(url);

  // 분야별 주간처럼 교보가 101위 이상을 주는 목록이 있다. 한 쪽에 100권까지만
  // 담기니 그때는 그 순위가 있는 쪽으로 넘긴다.
  if (rank > KYOBO_MAX_PAGE_SIZE) {
    pageUrl.searchParams.set("page", String(Math.ceil(rank / KYOBO_MAX_PAGE_SIZE)));
    pageUrl.searchParams.set("per", String(KYOBO_MAX_PAGE_SIZE));
    return pageUrl.toString();
  }

  const fitted = Math.ceil(rank / KYOBO_PAGE_STEP) * KYOBO_PAGE_STEP;
  const per = Math.min(KYOBO_MAX_PAGE_SIZE, Math.max(KYOBO_MIN_PAGE_SIZE, fitted));

  pageUrl.searchParams.set("page", "1");
  pageUrl.searchParams.set("per", String(per));
  return pageUrl.toString();
}

function makeAladinPageUrl(url, page) {
  if (page <= 1) {
    return url;
  }

  const pageUrl = new URL(url);
  pageUrl.searchParams.set("SortOrder", "1");
  pageUrl.searchParams.set("cnt", "100");
  pageUrl.searchParams.set("page", String(page));
  return pageUrl.toString();
}

function extractStoreItemId(storeId, link) {
  const value = String(link || "");

  if (storeId === "yes24") {
    return (value.match(/\/goods\/(\d+)/i) || value.match(/goodsNo=(\d+)/i) || [])[1] || "";
  }

  if (storeId === "aladin") {
    return (value.match(/[?&]ItemId=(\d+)/i) || [])[1] || "";
  }

  if (storeId === "kyobo") {
    return (value.match(/\/detail\/([A-Z0-9]+)/i) || [])[1] || "";
  }

  return "";
}

function textFragmentAnchor(title) {
  const text = String(title || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  // 목록에서 말줄임되는 긴 제목도 앞부분만으로 매칭되게 한다.
  //
  // 다만 단어 중간에서 자르면 안 된다. 텍스트 조각은 단어 경계에서만 일치를
  // 인정하므로 "Buy Sell Hold"를 "Buy Sell Ho"로 끊으면 제목이 화면에 그대로
  // 있어도 매칭이 실패해 스크롤이 일어나지 않는다. 32자 안의 마지막 공백까지만
  // 쓰고, 공백이 없으면(붙여 쓴 긴 제목) 자르지 않고 전체를 쓴다.
  const snippet = text.length > 32 ? trimToWordBoundary(text, 32) : text;
  return `#:~:text=${encodeURIComponent(snippet)}`;
}

function trimToWordBoundary(text, limit) {
  const head = text.slice(0, limit);
  const lastSpace = head.lastIndexOf(" ");

  return lastSpace > 0 ? head.slice(0, lastSpace) : text;
}

function appendRankAnchor(storeId, pageUrl, link, title) {
  if (!pageUrl) {
    return "";
  }

  const base = pageUrl.split("#")[0];

  // 텍스트 조각(#:~:text=제목)은 여기서 붙이지 않고 화면이 붙인다.
  // 제목을 퍼센트 인코딩한 조각이 항목마다 100바이트를 넘어서, 분야를 전 서점
  // 전체로 늘린 뒤 이 조각만 2.2MB였다. 그 때문에 응답이 12MB를 넘겨 Vercel CDN이
  // 캐시를 포기했고(x-vercel-cache: MISS) 매 방문이 다시 5초가 됐다.
  // 제목은 이미 항목에 들어 있으니 조각은 브라우저에서 만들면 된다 —
  // public/app.js 의 rankHref()가 같은 규칙(32자, 단어 경계)으로 붙인다.
  //
  // 상품 id 앵커(ordChk, addInputShop)는 카드 하단이라 제목이 화면 밖으로 밀린다.
  // 제목을 모르는 경우에만 최후 수단으로 쓴다.

  const itemId = extractStoreItemId(storeId, link);

  if (storeId === "yes24" && itemId) {
    return `${base}#ordChk_${itemId}`;
  }

  if (storeId === "aladin" && itemId) {
    return `${base}#addInputShop_${itemId}`;
  }

  return base;
}

// 순위 내역 클릭 시 해당 서점의 목록 페이지 + 그 도서 제목 위치로 연다.
// 예스24는 24권, 알라딘은 50권 단위로 쪽을 넘기고, 교보는 1위부터 그 책까지를
// 한 쪽에 담는다. 예스24·알라딘은 서버 렌더링이라 스크롤이 즉시 걸리고, 교보는
// 목록을 그린 뒤에야 걸려서 2~4초가 든다(appendRankAnchor 참고).
function buildRankListUrl(storeId, sourceUrl, rank, link = "", title = "") {
  if (!sourceUrl) {
    return "";
  }

  const rankValue = Number(rank);
  let pageUrl = sourceUrl;

  try {
    if (Number.isFinite(rankValue) && rankValue >= 1) {
      if (storeId === "yes24" && !sourceUrl.includes("realtimebestseller")) {
        pageUrl = makeYes24PageUrl(sourceUrl, Math.ceil(rankValue / 24));
      } else if (storeId === "aladin") {
        pageUrl = makeAladinPageUrl(sourceUrl, Math.ceil(rankValue / 50));
      } else if (storeId === "kyobo") {
        pageUrl = makeKyoboPageUrl(sourceUrl, rankValue);
      }
    }
  } catch (error) {
    pageUrl = sourceUrl;
  }

  return appendRankAnchor(storeId, pageUrl, link, title);
}

function createHeaders(extra = {}) {
  return {
    "user-agent": USER_AGENT,
    "accept-language": ACCEPT_LANGUAGE,
    ...extra
  };
}

// 목록이 많아 한 번에 수십 건이 나가면 서점 쪽에서 차단당하므로
// 도메인마다 동시 요청 수를 제한한다.
//
// 알라딘만 8로 올려 뒀다. 요청 하나가 2.3초씩 걸리는데 분야가 30개라 4로는
// 알라딘 혼자 수집 시간의 절반을 먹었다. 16개 분야로 재보니 동시 4에서 10.7초,
// 8에서 5.4초였고 요청당 지연(2351ms → 2463ms)도 오류(0건)도 늘지 않았다.
// 12까지 올려도 4.9초라 더 나아지지 않아 8에서 멈췄다.
const HOST_CONCURRENCY_BY_HOST = {
  "www.aladin.co.kr": 8
};

function hostConcurrency(host) {
  return HOST_CONCURRENCY_BY_HOST[host] || HOST_CONCURRENCY;
}

const hostQueues = new Map();

function getHostQueue(host) {
  if (!hostQueues.has(host)) {
    hostQueues.set(host, { active: 0, waiting: [] });
  }

  return hostQueues.get(host);
}

function acquireHostSlot(host) {
  const queue = getHostQueue(host);

  if (queue.active < hostConcurrency(host)) {
    queue.active += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    queue.waiting.push(resolve);
  });
}

function releaseHostSlot(host) {
  const queue = getHostQueue(host);
  const next = queue.waiting.shift();

  if (next) {
    next();
    return;
  }

  queue.active -= 1;
}

async function fetchText(url, headers = {}) {
  const host = new URL(url).host;
  await acquireHostSlot(host);

  try {
    const response = await fetch(url, {
      headers: createHeaders(headers),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 180)}`
      );
    }

    return text;
  } finally {
    releaseHostSlot(host);
  }
}

async function fetchJson(url, headers = {}) {
  const text = await fetchText(url, headers);

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON parse failed for ${url}`);
  }
}

function decodeHtmlEntities(value) {
  if (!value) {
    return "";
  }

  const namedEntities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    middot: "·",
    hellip: "...",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"'
  };

  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&([a-zA-Z]+);/g, (match, name) => namedEntities[name] || match);
}

function stripTags(html) {
  if (!html) {
    return "";
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s*[|ㅣ]+\s*/g, " · ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n+\s*/g, " · ")
    .replace(/\s*·\s*/g, " · ")
    .replace(/(?:·\s*){2,}/g, "· ")
    .replace(/^·\s*|\s*·$/g, "")
    .trim();
}

function extract(text, pattern, group = 1) {
  const match = text.match(pattern);
  return match ? match[group] || "" : "";
}

function toNumber(value) {
  const numeric = Number.parseInt(String(value || "").replace(/[^\d-]/g, ""), 10);
  return Number.isNaN(numeric) ? 0 : numeric;
}

function formatCompactDate(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).trim();

  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}.${normalized.slice(6, 8)}`;
  }

  return normalized;
}

// 서점이 날짜를 받고 돌려주는 형식이 YYYYMMDD라, 조각난 연·월·일을 그 형식으로 붙인다.
function toCompactDate(year, month, day) {
  return `${year}${String(Number(month)).padStart(2, "0")}${String(Number(day)).padStart(2, "0")}`;
}

function normalizePublishedAt(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  const compact = text.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  const separated = text.match(
    /(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})(?:\s*(?:[.\-/]|월)\s*(\d{1,2}))?/
  );

  if (!separated) {
    return "";
  }

  const month = Number(separated[2]);
  const day = Number(separated[3] || 1);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return "";
  }

  return `${separated[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatKyoboStamp(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).trim();

  if (/^\d{7}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)} ${normalized.slice(6, 7)}주`;
  }

  if (/^\d{16}$/.test(normalized)) {
    return `${formatCompactDate(normalized.slice(0, 8))} ~ ${formatCompactDate(normalized.slice(8, 16))}`;
  }

  if (/^\d{6}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}`;
  }

  if (/^\d{10}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}.${normalized.slice(6, 8)} ${normalized.slice(8, 10)}:00`;
  }

  if (/^\d{12}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}.${normalized.slice(6, 8)} ${normalized.slice(8, 10)}:${normalized.slice(10, 12)}`;
  }

  return formatCompactDate(normalized);
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }

  return new Intl.NumberFormat("ko-KR").format(Number(value));
}

function makeMeta(parts) {
  return parts
    .map((part) =>
      String(part || "")
        .replace(/^·\s*|\s*·$/g, "")
        .trim()
    )
    .filter(Boolean)
    .join(" · ");
}

function normalizeUrl(url, base) {
  if (!url) {
    return "";
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  try {
    return new URL(url, base).toString();
  } catch (error) {
    return url;
  }
}

function buildKyoboImageUrl(item) {
  const directImage = normalizeUrl(item.imgPath, "https://contents.kyobobook.co.kr");
  if (directImage) {
    return directImage;
  }

  const productCode = String(item.cmdtCode || "").trim();
  if (!productCode) {
    return "";
  }

  return `https://contents.kyobobook.co.kr/sih/fit-in/300x0/pdt/${productCode}.jpg`;
}

function dedupeByRank(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.rank}:${item.title}`;
    if (!item.rank || !item.title || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizePublisherKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isWatchedPublisher(value) {
  const key = normalizePublisherKey(value);
  return key ? key.includes(WATCH_PUBLISHER_KEY) : false;
}

function normalizeTitleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

// 서점마다 부제나 판형이 붙어 제목이 조금씩 다르므로, 신간 목록의 제목 중
// 가장 길게 일치하는 것을 골라 같은 책으로 묶는다.
function findCatalogKey(itemTitle, catalogKeys) {
  const itemKey = normalizeTitleKey(itemTitle);

  if (!itemKey) {
    return "";
  }

  return (
    catalogKeys
      .filter((key) => itemKey === key || (key.length >= 3 && itemKey.includes(key)))
      .sort((a, b) => b.length - a.length)[0] || ""
  );
}

function mapKyoboItem(item) {
  const publishedAt = formatCompactDate(item.rlseDate || item.ppbkRlseDate);
  const price = item.sapr ? `${formatNumber(item.sapr)}원` : "";
  const discount = item.dscnRate ? `${item.dscnRate}% 할인` : "";
  const previousRank = item.frmrRnkn > 0 ? `전회 ${item.frmrRnkn}위` : "";
  const publisher = String(item.pbcmName || "").trim();

  return {
    rank: toNumber(item.prstRnkn || item.rowNum),
    title: String(item.cmdtName || "").trim(),
    meta: makeMeta([item.chrcName, publisher, publishedAt]),
    secondary: makeMeta([price, discount, previousRank]),
    publisher,
    publishedAt: normalizePublishedAt(item.rlseDate || item.ppbkRlseDate),
    link: item.saleCmdtid
      ? `https://product.kyobobook.co.kr/detail/${item.saleCmdtid}`
      : "",
    image: buildKyoboImageUrl(item)
  };
}

async function fetchKyoboData(type, params) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      query.append(key, String(value));
    }
  });

  const url = `https://store.kyobobook.co.kr/api/gw/best/best-seller/${type}?${query.toString()}`;
  const payload = await fetchJson(url, {
    accept: "application/json",
    "x-api-gw-key": KYOBO_API_KEY
  });

  return payload.data || {};
}

async function fetchKyoboList(type, params, options = {}) {
  const limit = options.limit || params.per || STANDARD_LIMIT;
  const data = await fetchKyoboData(type, params);

  return {
    items: dedupeByRank((data.bestSeller || []).map(mapKyoboItem)).slice(0, limit),
    sourceStamp: formatKyoboStamp(data.ymw)
  };
}

// 실시간 종합 목록과 그 분야별 목록이 모두 같은 응답을 쓰므로,
// 갱신 주기마다 한 번만 호출하고 결과를 나눠 쓴다.
let kyoboRealtimeSnapshot = null;

async function requestKyoboRealtimeSnapshot() {
  const data = await fetchKyoboData("realtime", { page: 1, per: RANK_LIMIT });

  return {
    sourceStamp: formatKyoboStamp(data.ymw),
    entries: (data.bestSeller || []).map((entry) => ({
      item: mapKyoboItem(entry),
      categoryCode: String(entry.saleCmdtClstCode || "").slice(0, 2)
    }))
  };
}

function loadKyoboRealtimeSnapshot() {
  const now = Date.now();

  if (kyoboRealtimeSnapshot && kyoboRealtimeSnapshot.expiresAt > now) {
    return kyoboRealtimeSnapshot.promise;
  }

  const entry = { expiresAt: now + KYOBO_REALTIME_SNAPSHOT_TTL_MS };
  entry.promise = requestKyoboRealtimeSnapshot().catch((error) => {
    if (kyoboRealtimeSnapshot === entry) {
      kyoboRealtimeSnapshot = null;
    }

    throw error;
  });
  kyoboRealtimeSnapshot = entry;

  return entry.promise;
}

function fetchKyoboCategoryList(period, categoryCode) {
  return fetchKyoboList(
    "online",
    {
      page: 1,
      per: RANK_LIMIT,
      period,
      dsplDvsnCode: "001",
      dsplTrgtDvsnCode: "004",
      saleCmdtClstCode: categoryCode
    },
    { limit: RANK_LIMIT }
  );
}

async function fetchKyoboRealtimeList(categoryCode = "") {
  const snapshot = await loadKyoboRealtimeSnapshot();
  const entries = categoryCode
    ? snapshot.entries.filter((entry) => entry.categoryCode === categoryCode)
    : snapshot.entries;

  return {
    items: dedupeByRank(entries.map((entry) => entry.item)).slice(0, RANK_LIMIT),
    sourceStamp: snapshot.sourceStamp
  };
}

function mapYes24Block(block) {
  const rank = toNumber(extract(block, /<em class="ico rank">(\d+)<\/em>/));
  const category = stripTags(extract(block, /<span class="gd_res">([\s\S]*?)<\/span>/));
  const title = stripTags(extract(block, /<a class="gd_name"[^>]*>([\s\S]*?)<\/a>/));

  // 서점 화면에 올라간 그대로를 보여 준다. 예전에는 "[도서]"가 아닌 항목을 버려서
  // 만화·잡지가 사라졌고, 그 자리 순위가 통째로 비어 우리 책의 상대 위치까지
  // 어긋났다(실시간 100위 중 75개만 표시됨). 카테고리는 버리지 말고 메타로 남긴다.
  if (!rank || !title) {
    return null;
  }

  const link = normalizeUrl(
    extract(block, /<a class="gd_name" href="([^"]+)"/),
    "https://www.yes24.com"
  );
  const author = stripTags(
    extract(block, /<span class="authPub info_auth"[^>]*>([\s\S]*?)<\/span>/)
  );
  const publisher = stripTags(
    extract(block, /<span class="authPub info_pub"[^>]*>([\s\S]*?)<\/span>/)
  );
  const publishedAt = stripTags(
    extract(block, /<span class="authPub info_date">([\s\S]*?)<\/span>/)
  );
  const salePrice = toNumber(
    extract(block, /<strong class="txt_num"><em class="yes_b">([\d,]+)<\/em>원<\/strong>/)
  );

  return {
    rank,
    title,
    meta: makeMeta([author, publisher, publishedAt]),
    secondary: salePrice ? `${formatNumber(salePrice)}원` : "",
    publisher,
    // 예스24 목록은 "2025년 10월"처럼 월까지만 주는 경우가 있다. 없는 일자를
    // 1일로 채우면 교보가 준 실제 일자를 덮어쓸 수 있다.
    publishedAt: normalizePublishedAtLoose(publishedAt),
    link,
    image: normalizeUrl(
      extract(block, /<img[^>]+data-original="([^"]+)"/) ||
        extract(block, /<img[^>]+src="([^"]+)"/),
      "https://image.yes24.com"
    )
  };
}

async function fetchYes24List(url, options = {}) {
  const limit = options.limit || STANDARD_LIMIT;
  const pages = options.pages || 1;
  const htmlPages = await Promise.all(
    Array.from({ length: pages }, (_, index) =>
      fetchText(makeYes24PageUrl(url, index + 1), {
        accept: "text/html,application/xhtml+xml"
      })
    )
  );
  const perPage = htmlPages.map((html) =>
    html.split(/<li class="[^"]*" data-goods-no="/).slice(1)
  );
  assertFirstPageParsed("예스24", url, perPage);

  const items = dedupeByRank(perPage.flat().map(mapYes24Block).filter(Boolean)).slice(0, limit);
  let sourceStamp = parseYes24Stamp(htmlPages[0]);

  // 주별 목록은 실시간·일별과 달리 "기준" 문구를 적지 않는다. 주 범위는 주 선택
  // 목록에만 있어서 한 번 더 물어본다. 여기가 실패해도 순위는 멀쩡하므로
  // 스탬프만 비워 두고 넘어간다.
  if (!sourceStamp && url.includes(YES24_PERIOD_PATHS.weekly)) {
    sourceStamp = await resolveYes24WeekStamp(url).catch((error) => {
      console.error("[yes24] 주 범위 확인 실패:", error);
      return "";
    });
  }

  return {
    items,
    sourceStamp,
    warning: describeRankGap(items, perPage)
  };
}

// 예스24는 순위 기준을 페이지에 직접 적는다. 실시간은 "2026.08.12 11:00 기준",
// 주간(종합)은 "2026.08.05 ~ 2026.08.11 기준". 그대로 가져와야 우리 수집 시각과
// 서점의 집계 기준을 구분해 보여 줄 수 있다.
function parseYes24Stamp(html) {
  if (!html) {
    return "";
  }

  const text = stripTags(html);

  const range = text.match(
    /(20\d{2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2})\s*~\s*(20\d{2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2})\s*기준/
  );
  if (range) {
    return `${range[1].replace(/\s+/g, "")} ~ ${range[2].replace(/\s+/g, "")}`;
  }

  const stamp = text.match(
    /(20\d{2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2})\s*(\d{1,2}:\d{2})?\s*기준/
  );
  if (stamp) {
    return [stamp[1].replace(/\s+/g, ""), stamp[2] || ""].filter(Boolean).join(" ");
  }

  return "";
}

// 주별 목록의 주 선택 상자를 내려주는 AJAX 응답. option의 value가 주번호,
// 라벨이 그 주의 날짜 범위다. 주 범위는 분야와 무관하게 같으므로 국내도서(001)
// 하나만 물어본다.
function makeYes24WeekScopeUrl(saleYear) {
  return (
    "https://www.yes24.com/product/category/BestSellerContents?categoryNumber=001" +
    `&bestType=WEEK_BESTSELLER&type=week&saleYear=${saleYear}&weekNo=0&pageNumber=1&pageSize=24`
  );
}

// 주번호는 연도별로 1부터 다시 세지 않고 계속 누적된다(1181 = 2026.08.10~16).
// 그래서 날짜로 계산할 수 없고 이 목록에서 찾아야 한다.
async function fetchYes24Weeks(saleYear) {
  const html = await fetchText(makeYes24WeekScopeUrl(saleYear), {
    accept: "text/html,application/xhtml+xml"
  });
  const optionsHtml = extract(
    html,
    /<select[^>]*id="scope_week"[^>]*>([\s\S]*?)<\/select>/i
  );

  return [...optionsHtml.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)]
    .map((match) => {
      const weekNo = toNumber(extract(match[1], /value="(\d+)"/));
      const range = stripTags(match[2]).match(
        /(\d{1,2})월\s*(\d{1,2})일\s*~\s*(\d{1,2})월\s*(\d{1,2})일/
      );

      if (!weekNo || !range) {
        return null;
      }

      // 라벨에는 연도가 없다. 목록에는 saleYear 안에서 끝나는 주만 담기므로
      // (2026 목록의 마지막이 "12월 29일 ~ 01월 04일") 종료일이 saleYear이고,
      // 시작 월이 종료 월보다 크면 시작일만 전년이다.
      const endYear = Number(saleYear);
      const startYear = Number(range[1]) > Number(range[3]) ? endYear - 1 : endYear;

      return {
        weekNo,
        saleYear: endYear,
        // 서점이 현재 기준으로 선택해 둔 주. 날짜를 안 줄 때 쓰는 값이다.
        selected: /\sselected/i.test(match[1]),
        start: toCompactDate(startYear, range[1], range[2]),
        end: toCompactDate(endYear, range[3], range[4])
      };
    })
    .filter(Boolean);
}

// 주간 목록이 6개(종합 + 분야 5)라 갱신마다 같은 응답을 여섯 번 받게 된다.
// 교보 실시간 스냅샷과 같은 방식으로 한 번만 받아 나눠 쓴다.
const yes24WeekCache = new Map();

function loadYes24Weeks(saleYear) {
  const now = Date.now();
  const cached = yes24WeekCache.get(saleYear);

  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const entry = { expiresAt: now + STANDARD_REFRESH_MS };
  entry.promise = fetchYes24Weeks(saleYear).catch((error) => {
    if (yes24WeekCache.get(saleYear) === entry) {
      yes24WeekCache.delete(saleYear);
    }

    throw error;
  });
  yes24WeekCache.set(saleYear, entry);

  return entry.promise;
}

function formatYes24WeekStamp(week) {
  if (!week) {
    return "";
  }

  return `${formatCompactDate(week.start)} ~ ${formatCompactDate(week.end)}`;
}

// 목록 URL에 주번호가 있으면 그 주가, 없으면 서점이 골라 둔 주가 기준이다.
async function resolveYes24WeekStamp(url) {
  const target = new URL(url);
  const weekNo = toNumber(target.searchParams.get("weekNo"));
  const saleYear =
    toNumber(target.searchParams.get("saleYear")) || new Date().getFullYear();
  const weeks = await loadYes24Weeks(saleYear);

  return formatYes24WeekStamp(
    weekNo
      ? weeks.find((week) => week.weekNo === weekNo)
      : weeks.find((week) => week.selected)
  );
}

function parseAladinPublisher(authorLine) {
  const text = stripTags(authorLine);
  if (!text) {
    return "";
  }

  const parts = text
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length >= 2 ? parts[1] : "";
}

function mapAladinBlock(block) {
  const rank = toNumber(
    extract(block, /<div style="text-align: center;">\s*(\d+)\.\s*<\/div>/)
  );
  const category = stripTags(
    extract(block, /<span class="tit_category">([\s\S]*?)<\/span>/)
  );
  const title = stripTags(
    extract(block, /<a [^>]*class="bo3"[^>]*>([\s\S]*?)<\/a>/)
  );

  // 예스24와 같은 이유로 카테고리 제외를 걷어냈다. 알라딘 순위에는 굿즈·음반이
  // 섞여 있지만, 그것도 서점이 그 순위에 올려 둔 것이다. 빼 버리면 우리 순위가
  // 서점 화면과 어긋난다.
  if (!rank || !title) {
    return null;
  }

  const lines = [...block.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  const authorLine =
    lines.find(
      (line) => /\|\s*\d{4}년/.test(line) || /PublisherSearch=/.test(line)
    ) ||
    "";
  const priceLine =
    lines.find((line) => line.includes('class="ss_p2"') || line.includes("원 →")) || "";
  const statsLine =
    lines.find((line) => line.includes("sales_point") || line.includes("세일즈포인트")) ||
    "";
  const price = stripTags(
    extract(priceLine, /<span class="ss_p2"[^>]*><em>([\s\S]*?)<\/em><\/span>/)
  );
  const salesPoint = stripTags(
    extract(statsLine, /<span class="sales_point">\s*([^<]+)\s*<\/span>/)
  );
  const publisher = parseAladinPublisher(authorLine);

  return {
    rank,
    title,
    meta: stripTags(authorLine),
    secondary: makeMeta([
      price,
      salesPoint ? `세일즈포인트 ${salesPoint}` : ""
    ]),
    publisher,
    // 알라딘 목록도 월까지만 주는 경우가 있다 — 위 예스24와 같은 이유.
    publishedAt: normalizePublishedAtLoose(stripTags(authorLine)),
    link: normalizeUrl(
      extract(block, /<a href="([^"]+)" class="bo3">/),
      "https://www.aladin.co.kr"
    ),
    image: normalizeUrl(
      extract(block, /<img[^>]+src="([^"]+)"[^>]+class="[^"]*i_cover[^"]*"/i) ||
        extract(block, /<img[^>]+class="[^"]*i_cover[^"]*"[^>]+src="([^"]+)"/i) ||
        extract(block, /class="front_cover i_cover"[^>]*src="([^"]+)"/) ||
        extract(block, /<img src="([^"]+)" class="front_cover/i),
      "https://image.aladin.co.kr"
    )
  };
}

async function fetchAladinList(url, options = {}) {
  const limit = options.limit || STANDARD_LIMIT;
  const pages = options.pages || 1;
  const htmlPages = await Promise.all(
    Array.from({ length: pages }, (_, index) =>
      fetchText(makeAladinPageUrl(url, index + 1), {
        accept: "text/html,application/xhtml+xml"
      })
    )
  );
  const perPage = htmlPages.map((html) => html.split(/<div class="ss_book_box"[^>]*>/).slice(1));
  assertFirstPageParsed("알라딘", url, perPage);

  const blocks = perPage.flat();
  const items = dedupeByRank(blocks.map(mapAladinBlock).filter(Boolean)).slice(0, limit);

  return {
    items,
    sourceStamp: "",
    warning: describeRankGap(items, perPage)
  };
}

// 알라딘 출판사 검색 결과는 "2026년 8월"까지만 준다. normalizePublishedAt은
// 없는 일자를 1일로 채우므로, 그대로 쓰면 "2026.08.01" 같은 없는 날짜를 만든다.
// 월까지만 아는 경우는 YYYY-MM으로 남겨 정밀도를 속이지 않는다.
function normalizePublishedAtLoose(value) {
  const text = String(value || "").trim();

  if (!text) {
    return "";
  }

  const hasDay = /(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})/.test(text) ||
    /\b\d{8}\b/.test(text);

  if (hasDay) {
    return normalizePublishedAt(text);
  }

  const monthOnly = text.match(/(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})/);
  if (!monthOnly) {
    return "";
  }

  const month = Number(monthOnly[2]);
  if (month < 1 || month > 12) {
    return "";
  }

  return `${monthOnly[1]}-${String(month).padStart(2, "0")}`;
}

function hasFullDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

// 상품 페이지에는 schema.org datePublished가 있어 정확한 일자를 준다.
async function fetchAladinPublishedAt(link) {
  const itemId = extractStoreItemId("aladin", link);

  if (!itemId) {
    return "";
  }

  const html = await fetchText(
    `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${itemId}`,
    { accept: "text/html,application/xhtml+xml" }
  );

  return normalizePublishedAt(extract(html, /datePublished"?\s*content="([^"]+)"/i));
}

// 순위권 밖 도서는 교보 베스트셀러 API에 없으므로 상품 링크를 검색으로 찾는다.
// 검색 결과에는 pid와 제목이 붙어 있어(data-kbbfn-*) 동명 도서·다른 판본을
// 집지 않도록 제목을 대조할 수 있다.
async function fetchKyoboProductLink(title) {
  const key = normalizeTitleKey(title);

  if (!key) {
    return "";
  }

  const html = await fetchText(
    `https://search.kyobobook.co.kr/search?keyword=${encodeURIComponent(title)}&target=total`,
    { accept: "text/html,application/xhtml+xml" }
  );

  const pattern = /data-kbbfn-pid="([^"]+)"[^>]*(?:[^>]*>)?[\s\S]{0,400}?data-kbbfn-title="([^"]+)"/g;
  let match;

  while ((match = pattern.exec(html))) {
    const candidate = normalizeTitleKey(match[2]);

    if (candidate && (candidate === key || candidate.includes(key) || key.includes(candidate))) {
      return `https://product.kyobobook.co.kr/detail/${match[1]}`;
    }
  }

  return "";
}

// 카탈로그 한 권을 정확한 출간일 + 교보 링크로 채운다. 개별 실패는 삼킨다 —
// 보강이 안 되면 검색 페이지에서 얻은 월 단위 값으로 남는다.
async function enrichCatalogBook(book) {
  const [published, kyoboLink] = await Promise.all([
    fetchAladinPublishedAt(book.link).catch(() => ""),
    fetchKyoboProductLink(book.title).catch(() => "")
  ]);

  return {
    ...book,
    publishedAt: hasFullDate(published) ? published : book.publishedAt,
    kyoboLink: kyoboLink || book.kyoboLink || ""
  };
}

function makePublisherCatalogUrl() {
  const url = new URL("https://www.aladin.co.kr/search/wsearchresult.aspx");
  url.searchParams.set("SearchTarget", "Book");
  url.searchParams.set("KeyPublisher", WATCH_PUBLISHER_NAME);
  url.searchParams.set("SortOrder", "5");
  url.searchParams.set("ViewRowCount", "50");
  url.searchParams.set("ViewType", "Detail");
  return url.toString();
}

function mapPublisherCatalogBlock(block) {
  const title = stripTags(extract(block, /<a [^>]*class="bo3"[^>]*>([\s\S]*?)<\/a>/));
  const publisherLine = block.match(
    /PublisherSearch=[^"']*"[^>]*>([\s\S]*?)<\/A>\s*\|\s*([^<]+)/i
  );

  if (!title || !publisherLine || !isWatchedPublisher(stripTags(publisherLine[1]))) {
    return null;
  }

  return {
    title,
    publishedAt: normalizePublishedAtLoose(stripTags(publisherLine[2])),
    link: normalizeUrl(
      extract(block, /<a href="([^"]*wproduct\.aspx\?ItemId=\d+)"/),
      "https://www.aladin.co.kr"
    ),
    kyoboLink: ""
  };
}

async function fetchPublisherCatalog() {
  const html = await fetchText(makePublisherCatalogUrl(), {
    accept: "text/html,application/xhtml+xml"
  });
  const blocks = html.split(/<div class="ss_book_box"[^>]*>/).slice(1);
  const seen = new Set();
  const books = blocks
    .map(mapPublisherCatalogBlock)
    .filter(Boolean)
    .filter((book) => {
      const key = normalizeTitleKey(book.title);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });

  if (!books.length) {
    throw new Error(`${WATCH_PUBLISHER_NAME} 도서 목록을 찾지 못했습니다.`);
  }

  const shortlist = books
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, FOCUS_CATALOG_LIMIT);

  // 보강은 6시간 TTL 뒤에서만 돌고, fetchText가 호스트당 4개로 조절하므로
  // 한 번에 몰아 보내도 서점에 부담이 되지 않는다.
  return Promise.all(shortlist.map((book) => enrichCatalogBook(book)));
}

let publisherCatalogCache = null;

async function loadPublisherCatalog() {
  const now = Date.now();

  if (publisherCatalogCache && publisherCatalogCache.expiresAt > now) {
    return publisherCatalogCache.books;
  }

  try {
    const books = await fetchPublisherCatalog();
    publisherCatalogCache = { books, expiresAt: now + FOCUS_CATALOG_TTL_MS };
    await writePersistedSource(
      FOCUS_CATALOG_ID,
      { items: books },
      publisherCatalogCache.expiresAt
    );
    return books;
  } catch (error) {
    console.error("[catalog] 신간 목록 수집 실패:", error);
    const retryAt = now + FOCUS_CATALOG_RETRY_MS;

    if (publisherCatalogCache) {
      publisherCatalogCache = { ...publisherCatalogCache, expiresAt: retryAt };
      return publisherCatalogCache.books;
    }

    const persisted = await readPersistedSource(FOCUS_CATALOG_ID);
    const books = persisted
      ? persisted.payload.items
      : FOCUS_BOOK_TITLES.map((title) => ({ title, publishedAt: "", link: "" }));

    publisherCatalogCache = { books, expiresAt: retryAt };
    return books;
  }
}

// 목록의 모든 책에 "그 책이 실제로 놓인 순위 페이지 위치" 링크를 붙인다. 상품 상세로
// 보내면 몇 위였는지가 사라지므로, 순위를 확인하러 온 사람에겐 목록 위치가 맞다.
// 서점 파서는 sourceUrl을 모르기 때문에 목록 단위인 여기서 계산한다.
function attachListUrls(definition, items) {
  if (!definition.sourceUrl) {
    return items;
  }

  return items.map((item) => ({
    ...item,
    listUrl: buildRankListUrl(
      definition.storeId,
      definition.sourceUrl,
      item.rank,
      item.link,
      item.title
    )
  }));
}

function buildPayload(definition, result, options = {}) {
  const now = new Date();
  const items = attachListUrls(definition, result.items);

  return {
    id: definition.id,
    storeId: definition.storeId,
    name: definition.name,
    typeLabel: definition.typeLabel,
    group: definition.group || (definition.realtime ? "overall-realtime" : "standard"),
    categoryName: definition.categoryName || "",
    // 서점끼리 같은 분야를 짝지어 나란히 보여 주려면 화면도 이 키를 알아야 한다.
    groupKeys: definition.groupKeys || [],
    period: definition.period || "",
    periodLabel: definition.period ? PERIOD_LABELS[definition.period] : "",
    realtime: definition.realtime,
    paginate: definition.paginate !== false,
    derived: definition.derived === true,
    note: definition.note || "",
    sourceUrl: definition.sourceUrl,
    updatedAt: now.toISOString(),
    nextRefreshAt: new Date(now.getTime() + definition.ttlMs).toISOString(),
    sourceStamp: result.sourceStamp || "",
    cadence: getStoreCadence(definition.storeId, definition.period, definition.realtime),
    itemCount: items.length,
    items,
    warning: options.warning || result.warning || "",
    error: options.error || "",
    stale: Boolean(options.stale)
  };
}

// 다른 목록에서 파생된 목록은 같은 책을 같은 순위로 다시 담고 있으므로 집계에서 제외한다.
function getSourceLists(section) {
  return section.lists.filter((list) => !list.derived);
}

function buildFocusBooks(sections, catalog = []) {
  const booksByTitle = new Map(
    catalog.map((book) => [
      normalizeTitleKey(book.title),
      {
        title: book.title,
        publishedAt: book.publishedAt || "",
        link: book.link || "",
        kyoboLink: book.kyoboLink || "",
        appearances: []
      }
    ])
  );
  const catalogKeys = [...booksByTitle.keys()];

  sections.forEach((section) => {
    getSourceLists(section).forEach((list) => {
      list.items
        .filter((item) => isWatchedPublisher(item.publisher))
        .forEach((item) => {
          const key =
            findCatalogKey(item.title, catalogKeys) || normalizeTitleKey(item.title);

          if (!booksByTitle.has(key)) {
            booksByTitle.set(key, {
              title: item.title,
              publishedAt: "",
              link: "",
              kyoboLink: "",
              appearances: []
            });
          }

          booksByTitle.get(key).appearances.push({
            storeId: section.id,
            storeName: section.name,
            listId: list.id,
            listName: list.name,
            // buildPayload가 이미 항목마다 계산해 둔 값을 쓴다.
            listUrl: item.listUrl || "",
            group: list.group || "",
            categoryName: list.categoryName || "",
            realtime: Boolean(list.realtime),
            rank: item.rank,
            title: item.title,
            link: item.link,
            // The store's own product id is the most stable identity we have;
            // normalized titles shift when a store retitles an edition.
            storeItemId: extractStoreItemId(section.id, item.link),
            image: item.image,
            publisher: item.publisher || "",
            publishedAt: item.publishedAt || ""
          });
        });
    });
  });

  return [...booksByTitle.entries()]
    .map(([bookKey, book]) => {
      const appearances = book.appearances;
      const realtimeAppearances = appearances.filter((item) => item.realtime);
      const rankBasis = realtimeAppearances.length ? realtimeAppearances : appearances;
      const bestRank = rankBasis.length
        ? Math.min(...rankBasis.map((item) => item.rank).filter(Boolean))
        : null;
      // 서점 값 중 최댓값을 쓰면 재쇄·개정판 날짜가 초판을 덮는다. 출판사
      // 카탈로그에서 정확한 일자를 얻었으면 그게 이 책의 출간일이다.
      // 없을 때만 서점이 준 일자 중 가장 이른 것을 쓴다 — 늦은 값은
      // 재쇄일 가능성이 높다. 월까지만 아는 값은 마지막 수단으로 남긴다.
      const storeDates = appearances.map((item) => item.publishedAt).filter(Boolean);
      const storeFullDates = storeDates.filter(hasFullDate).sort();
      const latestPublishedAt = hasFullDate(book.publishedAt)
        ? book.publishedAt
        : storeFullDates[0] || [book.publishedAt, ...storeDates].filter(Boolean).sort()[0] || "";

      appearances.sort((a, b) => {
        if (a.realtime !== b.realtime) {
          return a.realtime ? -1 : 1;
        }

        return (a.rank || 9999) - (b.rank || 9999);
      });

      return {
        bookKey,
        title: book.title,
        // 제목 클릭은 교보 상품 페이지로 보낸다. 카탈로그 보강에서 찾은 링크가
        // 1순위, 없으면 교보 순위에서 얻은 링크, 그다음이 다른 서점이다.
        link:
          book.kyoboLink ||
          appearances.find((item) => item.storeId === "kyobo" && item.link)?.link ||
          book.link ||
          appearances.find((item) => item.link)?.link ||
          "",
        bestRank,
        latestPublishedAt,
        appearanceCount: appearances.length,
        appearances
      };
    })
    .sort((a, b) => {
      // 순위에 든 도서를 앞으로 모으고, 출간 최신순은 그 안에서만 적용한다.
      const rankedOrder =
        Number(b.appearanceCount > 0) - Number(a.appearanceCount > 0);

      if (rankedOrder !== 0) {
        return rankedOrder;
      }

      const publishedOrder = String(b.latestPublishedAt || "").localeCompare(
        String(a.latestPublishedAt || "")
      );

      if (publishedOrder !== 0) {
        return publishedOrder;
      }

      if (a.bestRank !== b.bestRank) {
        return (a.bestRank || 9999) - (b.bestRank || 9999);
      }

      return a.title.localeCompare(b.title, "ko");
    });
}

// 화면이 분야 하나를 열 때 쓰는 경로. 메모리 캐시 → 저장된 스냅샷 순으로 보고,
// 둘 다 없을 때만 서점을 새로 긁는다. 서버리스는 요청마다 프로세스가 새로 뜨므로
// 저장된 스냅샷을 먼저 보지 않으면 분야를 누를 때마다 서점을 다시 긁게 된다.
async function loadListForClient(id) {
  const cached = cache.get(id);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return { ...cached.payload, cacheState: "hit" };
  }

  const persisted = await readPersistedSource(id);

  if (persisted) {
    cache.set(id, persisted);
    return {
      ...persisted.payload,
      cacheState: persisted.expiresAt > now ? "persisted" : "persisted-stale"
    };
  }

  return loadSource(id);
}

async function loadSource(id, options = {}) {
  const definition = sourceById.get(id);

  if (!definition) {
    throw new Error(`Unknown source: ${id}`);
  }

  const force = Boolean(options.force);
  const cached = cache.get(id);
  const now = Date.now();

  if (!force && cached && cached.expiresAt > now) {
    return {
      ...cached.payload,
      cacheState: "hit"
    };
  }

  try {
    const result = await definition.load();
    const payload = buildPayload(definition, result);
    cache.set(id, {
      payload,
      expiresAt: now + definition.ttlMs
    });
    await writePersistedSource(id, payload, now + definition.ttlMs);
    return {
      ...payload,
      cacheState: force ? "refreshed" : "miss"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (cached) {
      return {
        ...cached.payload,
        warning: `새 수집에 실패해 최근 캐시를 보여줍니다. ${message}`,
        stale: true,
        cacheState: "stale"
      };
    }

    const persisted = await readPersistedSource(id);

    if (persisted) {
      cache.set(id, persisted);
      return {
        ...persisted.payload,
        warning: `새 수집에 실패해 저장된 최근 순위를 보여줍니다. ${message}`,
        stale: true,
        cacheState: "persisted"
      };
    }

    return {
      ...buildPayload(definition, { items: [], sourceStamp: "" }, { error: message }),
      cacheState: "error"
    };
  }
}

// 화면 상단에 "우리 갱신 주기"만 적혀 있으면, 그 숫자가 순위의 집계 기준인지 우리가
// 긁어온 시각인지 구분되지 않는다. 둘은 다른 값이다 — 교보 일간은 전일 판매를 집계하고
// 우리는 6시간마다 그걸 가져온다. 그래서 서점·기간마다 세 가지를 따로 내려준다.
//   collectedAt  우리가 서점에서 가져온 시각
//   sourceStamp  서점이 스스로 밝힌 그 순위의 기준 시점
//   cadence      서점이 무엇을 단위로 집계하는지
const STATUS_PERIOD_ORDER = ["realtime", "daily", "weekly", "monthly"];

function buildStoreStatus(sections) {
  return sections.map((section) => {
    const groups = [];

    for (const list of section.lists) {
      // 파생 목록은 같은 수집을 다시 담고 있어 시각이 중복된다.
      if (list.derived) {
        continue;
      }

      const key = list.realtime ? "realtime" : list.period || "";

      if (!key || groups.some((group) => group.key === key)) {
        continue;
      }

      groups.push({
        key,
        label: PERIOD_LABELS[key] || list.typeLabel || key,
        collectedAt: list.updatedAt || "",
        nextRefreshAt: list.nextRefreshAt || "",
        sourceStamp: list.sourceStamp || "",
        cadence: list.cadence || "",
        stale: Boolean(list.stale),
        error: list.error || ""
      });
    }

    groups.sort(
      (a, b) => STATUS_PERIOD_ORDER.indexOf(a.key) - STATUS_PERIOD_ORDER.indexOf(b.key)
    );

    return {
      storeId: section.id,
      storeName: section.name,
      accent: section.accent || "",
      groups
    };
  });
}

// 분야별 목록은 항목을 빼고 내려보낸다. 화면은 지금 보고 있는 분야만 필요하고,
// 그건 /api/list 가 따로 준다. 항목을 다 담으면 분야별만 7.8MB(응답의 95%)라
// 응답이 10MB를 넘겨 Vercel CDN이 캐시를 포기하고 매 방문이 4~5초가 된다.
//
// 상상스퀘어 추적은 여기서 항목을 빼기 전에 이미 끝나 있다(buildFocusBooks) —
// 그래서 100위까지 훑는 정확도는 그대로다.
function stripCategoryItems(sections) {
  return sections.map((section) => ({
    ...section,
    lists: section.lists.map((list) => {
      if (list.group !== "category") {
        return list;
      }

      const { items, ...rest } = list;

      return { ...rest, items: [], itemsDeferred: true };
    })
  }));
}

async function buildDashboard(forceIds = []) {
  const [lists, catalog] = await Promise.all([
    Promise.all(
      SOURCES.map((source) =>
        loadSource(source.id, {
          force: forceIds.includes(source.id)
        })
      )
    ),
    loadPublisherCatalog()
  ]);

  const sections = STORES.map((store) => ({
    ...store,
    lists: lists.filter((list) => list.storeId === store.id)
  }));

  const generatedAt = new Date().toISOString();
  const focusBooks = buildFocusBooks(sections, catalog);

  // Deltas are baked into the snapshot rather than computed in the browser, so
  // a cold start serves them without waiting for a collection. History failures
  // must never take the dashboard down with them.
  let historyBaseline = "";
  try {
    historyBaseline = await recordRankHistory(focusBooks, sections, generatedAt);
  } catch (error) {
    console.error("[history] rank history step failed:", error);
  }

  const payload = {
    generatedAt,
    assetVersion: await getAssetVersion(),
    sections: stripCategoryItems(sections),
    focusBooks,
    storeStatus: buildStoreStatus(sections),
    categoryGroups: CATEGORY_GROUPS.map(({ key, label }) => ({ key, label })),
    deltaBaselineAt: historyBaseline,
    // 화면이 수집 주기를 직접 적어 두면 서버 값을 바꿀 때 같이 안 고쳐져 거짓말이 된다.
    // 실제로 그런 일이 있었다 — 배지가 "실시간 5분 / 일반 10분"으로 남아 있었다.
    collectIntervals: {
      realtimeMinutes: REALTIME_REFRESH_MS / 60000,
      standardHours: STANDARD_REFRESH_MS / 3600000
    }
  };

  try {
    await writeDashboardSnapshot(payload);
  } catch (error) {
    console.error("[supabase] failed to persist dashboard snapshot:", error);
  }

  return payload;
}

// Returns the timestamp the deltas are measured against ("" when there is no
// earlier collection yet, which is how the UI knows to stay silent).
async function recordRankHistory(focusBooks, sections, generatedAt) {
  if (!getSupabaseConfig()) {
    return "";
  }

  const previousCollectedAt = await readPreviousCollectedAt();
  const previousRows = await readRankHistoryAt(previousCollectedAt);

  if (previousRows.length) {
    applyRankDeltas(focusBooks, previousRows, buildNameLookup(sections));
  }

  await writeRankHistory(collectRankHistoryRows(focusBooks, generatedAt));

  return previousRows.length ? previousCollectedAt : "";
}

// 아래는 과거 날짜 조회 전용이다. 수집 스케줄러와 대시보드 스냅샷은 건드리지
// 않는다 — 여기서 받은 목록은 source_snapshots에만 남는다.

const HISTORY_DATE_FORMATS =
  "하루는 YYYY-MM-DD(또는 YYYYMMDD), 그 달의 몇째 주는 YYYY-MM-W3(또는 YYYYMMW) 형식입니다.";

// 400(요청이 틀림)과 502(서점이 못 줌)를 구분해야 해서 상태 코드를 달아 던진다.
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function withQuery(url, params) {
  const target = new URL(url);

  Object.entries(params).forEach(([key, value]) => {
    target.searchParams.set(key, String(value));
  });

  return target.toString();
}

// 날짜의 뜻만 읽는다. 서점이 요구하는 파라미터 문자열은 buildHistoryRequest가 만든다.
function parseHistoryDate(value) {
  const text = String(value || "").trim();

  if (!text) {
    return { error: `date 파라미터가 필요합니다. ${HISTORY_DATE_FORMATS}` };
  }

  const today = new Date();
  const day = text.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);

  if (day) {
    const [year, month, date] = day.slice(1).map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, date));

    // 2026-02-31 같은 없는 날짜를 Date는 조용히 다음 달로 넘긴다.
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== date
    ) {
      return { error: `없는 날짜입니다: ${text}` };
    }

    const compact = toCompactDate(year, month, date);
    const todayCompact = toCompactDate(
      today.getFullYear(),
      today.getMonth() + 1,
      today.getDate()
    );

    if (compact > todayCompact) {
      return { error: `아직 오지 않은 날짜입니다: ${text}` };
    }

    return {
      kind: "day",
      key: `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
      compact,
      current: compact === todayCompact
    };
  }

  const week = text.match(/^(\d{4})-?(\d{2})-?[Ww]?([1-5])$/);

  if (!week) {
    return { error: `날짜 형식을 알 수 없습니다: ${text}. ${HISTORY_DATE_FORMATS}` };
  }

  const [year, month, weekOfMonth] = week.slice(1).map(Number);

  if (month < 1 || month > 12) {
    return { error: `없는 달입니다: ${text}` };
  }

  const yearMonth = `${year}${String(month).padStart(2, "0")}`;
  const thisMonth = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}`;

  if (yearMonth > thisMonth) {
    return { error: `아직 오지 않은 달입니다: ${text}` };
  }

  return {
    kind: "week",
    key: `${year}-${String(month).padStart(2, "0")}-W${weekOfMonth}`,
    // 교보 종합 주간이 쓰는 7자리(YYYYMMW).
    compact: `${yearMonth}${weekOfMonth}`,
    year,
    month,
    week: weekOfMonth,
    // 이번 달은 아직 주가 끝나지 않았을 수 있어 오래 캐시하지 않는다.
    current: yearMonth === thisMonth
  };
}

// 주번호는 누적 절대값이라 계산할 수 없다. 그 날짜를 품은 주를 서점의 주 목록에서
// 찾는다. 연말 주는 다음 해 목록에 들어 있어(2025.12.29 ~ 2026.01.04) 한 번 더 본다.
async function findYes24Week(compactDay) {
  const year = Number(compactDay.slice(0, 4));
  const thisYear = new Date().getFullYear();

  for (const saleYear of [year, year + 1].filter((value) => value <= thisYear)) {
    const weeks = await loadYes24Weeks(saleYear);
    const week = weeks.find(
      (entry) => entry.start <= compactDay && compactDay <= entry.end
    );

    if (week) {
      return week;
    }
  }

  return null;
}

// 서점·기간마다 날짜 파라미터의 이름과 자릿수가 다르다. 교보는 자릿수가 하나만
// 틀려도 200에 빈 목록을 주므로(종합 주간 7자리, 나머지 8자리) 조합별 규칙을
// 여기 한곳에만 둔다. 지원하지 않는 조합은 error를 담아 돌려준다.
async function buildHistoryRequest(storeId, period, parsed) {
  // 일간 차트는 완료된 하루를 집계한다 — 교보·예스24 모두 전일 기준이다. 오늘을
  // 넘기면 예스24는 pageNumber를 무시하고 첫 쪽만 반복해서 24건짜리 목록을 200으로
  // 돌려준다. 반쪽을 성공으로 넘기지 않도록 여기서 막는다.
  if (period === "daily" && parsed.kind === "day" && parsed.current) {
    return {
      error:
        "일간 순위는 완료된 하루만 조회합니다. 서점의 일간 집계는 전일 기준이라 오늘 날짜는 목록이 확정되지 않습니다. 어제 이전 날짜를 지정해 주세요."
    };
  }

  if (storeId === "kyobo" && period === "daily") {
    if (parsed.kind !== "day") {
      return { error: `교보문고 일간은 하루 단위로만 조회합니다. ${HISTORY_DATE_FORMATS}` };
    }

    return {
      baseId: "kyobo-online-daily",
      query: { ymw: parsed.compact },
      load: () =>
        fetchKyoboList("online", {
          page: 1,
          per: RANK_LIMIT,
          period: "001",
          dsplDvsnCode: "001",
          dsplTrgtDvsnCode: "002",
          saleCmdtDsplDvsnCode: "TOT",
          ymw: parsed.compact
        })
    };
  }

  // 교보는 주간 차트가 둘이고 날짜 형식으로 갈린다. 하루를 주면 온라인 주간이
  // 그 날이 든 주로 스냅하고(응답 ymw는 16자리 범위), 몇째 주를 주면 종합 주간이
  // 7자리 그대로 받는다.
  if (storeId === "kyobo" && period === "weekly" && parsed.kind === "week") {
    return {
      baseId: "kyobo-total-weekly",
      query: { ymw: parsed.compact },
      load: () =>
        fetchKyoboList("total", {
          page: 1,
          per: RANK_LIMIT,
          period: "002",
          bsslBksClstCode: "A",
          ymw: parsed.compact
        })
    };
  }

  if (storeId === "kyobo" && period === "weekly") {
    return {
      baseId: "kyobo-online-weekly",
      query: { ymw: parsed.compact },
      load: () =>
        fetchKyoboList("online", {
          page: 1,
          per: RANK_LIMIT,
          period: "002",
          dsplDvsnCode: "001",
          dsplTrgtDvsnCode: "002",
          saleCmdtDsplDvsnCode: "TOT",
          ymw: parsed.compact
        })
    };
  }

  if (storeId === "yes24" && period === "daily") {
    if (parsed.kind !== "day") {
      return { error: `예스24 일별은 하루 단위로만 조회합니다. ${HISTORY_DATE_FORMATS}` };
    }

    return {
      baseId: "yes24-day",
      query: { saleDts: parsed.key },
      load: (sourceUrl) =>
        fetchYes24List(sourceUrl, { limit: RANK_LIMIT, pages: YES24_PAGES_FOR_100 })
    };
  }

  if (storeId === "yes24" && period === "weekly") {
    if (parsed.kind !== "day") {
      return {
        error: `예스24 주별은 그 주에 든 하루로 조회합니다. ${HISTORY_DATE_FORMATS}`
      };
    }

    const week = await findYes24Week(parsed.compact);

    if (!week) {
      return {
        error: `예스24 주별 목록에서 ${parsed.key}이 든 주를 찾지 못했습니다. 서점은 끝난 주까지만 목록에 올립니다.`
      };
    }

    return {
      baseId: "yes24-bestseller",
      query: { saleYear: week.saleYear, weekNo: week.weekNo },
      load: (sourceUrl) =>
        fetchYes24List(sourceUrl, { limit: RANK_LIMIT, pages: YES24_PAGES_FOR_100 })
    };
  }

  if (storeId === "aladin" && period === "weekly") {
    if (parsed.kind !== "week") {
      return {
        error: `알라딘 주간은 그 달의 몇째 주로 조회합니다. ${HISTORY_DATE_FORMATS}`
      };
    }

    return {
      baseId: "aladin-weekly",
      query: { Year: parsed.year, Month: parsed.month, Week: parsed.week },
      load: (sourceUrl) =>
        fetchAladinList(sourceUrl, { limit: RANK_LIMIT, pages: ALADIN_PAGES_FOR_100 })
    };
  }

  // 알라딘 일간에는 날짜를 받는 페이지가 없다. 주간만 소급 조회된다.
  if (storeId === "aladin" && period === "daily") {
    return {
      error: "알라딘 일간은 날짜 조회를 지원하지 않습니다. 알라딘은 주간만 소급 조회됩니다."
    };
  }

  return { error: `지원하지 않는 조합입니다: store=${storeId} period=${period}` };
}

// 조회 전용. 같은 날짜를 다시 물으면 서점을 긁지 않고 캐시에서 돌려준다.
async function loadHistoricalRanking(storeId, period, date) {
  if (!STORES.some((store) => store.id === storeId)) {
    throw httpError(
      400,
      `store가 잘못됐습니다: ${storeId || "(없음)"}. kyobo·yes24·aladin 중 하나여야 합니다.`
    );
  }

  if (period !== "daily" && period !== "weekly") {
    throw httpError(
      400,
      `period가 잘못됐습니다: ${period || "(없음)"}. daily 또는 weekly여야 합니다.`
    );
  }

  const parsed = parseHistoryDate(date);

  if (parsed.error) {
    throw httpError(400, parsed.error);
  }

  const request = await buildHistoryRequest(storeId, period, parsed);

  if (request.error) {
    throw httpError(400, request.error);
  }

  const base = sourceById.get(request.baseId);
  const sourceUrl = withQuery(base.sourceUrl, request.query);
  const definition = {
    ...base,
    // 파일 캐시가 이 id를 파일명으로 쓰므로 콜론은 넣을 수 없다(Windows).
    id: `hist-${storeId}-${period}-${parsed.key}`,
    sourceUrl,
    ttlMs: parsed.current ? STANDARD_REFRESH_MS : HISTORY_CACHE_TTL_MS,
    load: () => request.load(sourceUrl)
  };
  const now = Date.now();
  const cached = cache.get(definition.id);

  if (cached && cached.expiresAt > now) {
    return { ...cached.payload, cacheState: "hit" };
  }

  const persisted = await readPersistedSource(definition.id);

  if (persisted && persisted.expiresAt > now) {
    cache.set(definition.id, persisted);
    return { ...persisted.payload, cacheState: "persisted" };
  }

  const result = await definition.load();

  // 첫 쪽을 못 읽은 경우는 파서가 이미 던진다. 여기 걸리는 건 서점이 그 날짜의
  // 목록을 아예 갖고 있지 않은 경우다 — 교보는 소급 범위를 벗어나거나 자릿수가
  // 맞지 않으면 200에 빈 목록을 준다.
  if (!result.items.length) {
    throw httpError(
      400,
      `${base.name}에 ${parsed.key} 순위가 없습니다. 서점이 그 날짜의 목록을 제공하지 않습니다.`
    );
  }

  const payload = buildPayload(definition, result);
  cache.set(definition.id, { payload, expiresAt: now + definition.ttlMs });
  await writePersistedSource(definition.id, payload, now + definition.ttlMs);

  return { ...payload, cacheState: "miss" };
}

function getForcedSourceIds(refreshParam) {
  if (!refreshParam) {
    return [];
  }

  if (refreshParam === "all") {
    return SOURCES.map((source) => source.id);
  }

  if (refreshParam === "realtime") {
    return SOURCES.filter((source) => source.realtime).map((source) => source.id);
  }

  if (sourceById.has(refreshParam)) {
    return [refreshParam];
  }

  return [];
}

// 스냅샷은 수집이 돌 때만 바뀌므로(실시간 60분, 일반 6시간) CDN이 들고 있어도 된다.
// no-store로 막아 두면 방문할 때마다 함수를 깨우고 Supabase까지 다녀와서 2.6초가 든다.
// max-age=0으로 브라우저는 매번 확인하게 두고, s-maxage로 CDN이 60초간 그대로 내주며,
// stale-while-revalidate 덕에 그 뒤로도 먼저 보여 주고 뒤에서 새로 받는다.
const SNAPSHOT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=600";

function jsonResponse(response, statusCode, payload, cacheControl = "no-store") {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheControl
  });
  response.end(JSON.stringify(payload));
}

function getMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

const ASSET_FILES = ["index.html", "app.js", "styles.css"];

// 대시보드는 탭을 켜둔 채로 데이터만 자동 갱신하기 때문에, 프런트엔드 파일이
// 바뀌어도 열린 탭은 예전 코드를 계속 쓴다. 버전을 payload에 실어 보내서
// 클라이언트가 스스로 새로고침하게 한다.
async function getAssetVersion() {
  const stamps = await Promise.all(
    ASSET_FILES.map(async (name) => {
      try {
        const info = await fs.stat(path.join(PUBLIC_DIR, name));
        return `${name}:${Math.round(info.mtimeMs)}`;
      } catch (error) {
        return `${name}:0`;
      }
    })
  );

  return stamps.join("|");
}

async function serveStatic(response, requestPath) {
  let normalizedPath = requestPath;

  if (requestPath === "/" || requestPath === "/main" || requestPath === "/main/") {
    normalizedPath = "/index.html";
  } else if (requestPath === "/landing" || requestPath === "/landing/") {
    normalizedPath = "/landing/index.html";
  }

  const resolvedPath = path.resolve(PUBLIC_DIR, `.${normalizedPath}`);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    jsonResponse(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await fs.readFile(resolvedPath);
    response.writeHead(200, {
      "content-type": getMimeType(resolvedPath),
      "cache-control": "no-cache"
    });
    response.end(file);
  } catch (error) {
    jsonResponse(response, 404, { error: "Not found" });
  }
}

async function refreshRealtimeSources() {
  const realtimeIds = SOURCES.filter((source) => source.realtime).map((source) => source.id);
  await Promise.all(
    realtimeIds.map((id) =>
      loadSource(id, { force: true }).catch((error) => {
        console.error(`[scheduler] ${id}:`, error);
      })
    )
  );
}

async function refreshStandardSources() {
  const standardIds = SOURCES.filter((source) => !source.realtime).map((source) => source.id);
  await Promise.all(
    standardIds.map((id) =>
      loadSource(id, { force: true }).catch((error) => {
        console.error(`[scheduler] ${id}:`, error);
      })
    )
  );
}

let snapshotRebuild = null;
let snapshotRebuildForced = null;

// Refreshing sources is not enough: the snapshot every visitor reads is only
// written by buildDashboard, so without this the dashboard stays frozen at the
// last forced refresh while the source rows keep moving underneath it.
//
// Every path that rebuilds goes through here, including manual refreshes, so
// overlapping requests collapse instead of each writing its own collection --
// two collections seconds apart leave every delta reading zero and make the
// baseline "10 seconds ago" instead of the collection interval.
//
// A caller only joins the in-flight rebuild when that rebuild already forces
// every source the caller asked for. Otherwise it waits and runs its own:
// joining a weaker rebuild would silently drop an explicit refresh request.
function rebuildDashboardSnapshot(reason, forceIds = []) {
  const covered =
    snapshotRebuild &&
    forceIds.every((id) => snapshotRebuildForced && snapshotRebuildForced.has(id));

  if (covered) {
    return snapshotRebuild;
  }

  const previous = snapshotRebuild;
  const forcedSet = new Set(forceIds);

  const run = (async () => {
    if (previous) {
      await previous;
    }

    try {
      const payload = await buildDashboard(forceIds);
      console.log(`[scheduler] dashboard snapshot rebuilt (${reason})`);
      return payload;
    } catch (error) {
      // Swallow rather than reject: the scheduler call sites are fire-and-forget
      // and an unhandled rejection would take the process down. Callers that
      // need the payload check for null.
      console.error(`[scheduler] snapshot rebuild failed (${reason}):`, error);
      return null;
    } finally {
      if (snapshotRebuild === run) {
        snapshotRebuild = null;
        snapshotRebuildForced = null;
      }
    }
  })();

  snapshotRebuild = run;
  snapshotRebuildForced = forcedSet;

  return run;
}

function startSourceSchedulers() {
  // Rebuild once both passes are done so the first snapshot carries realtime
  // and standard lists together.
  setTimeout(() => {
    Promise.allSettled([refreshRealtimeSources(), refreshStandardSources()]).then(() =>
      rebuildDashboardSnapshot("startup")
    );
  }, 1000);

  setInterval(() => {
    refreshRealtimeSources()
      .catch((error) => {
        console.error("[scheduler] realtime refresh failed:", error);
      })
      // Rebuild even when some sources failed -- partial data beats a stale snapshot.
      .then(() => rebuildDashboardSnapshot("realtime"));
  }, REALTIME_REFRESH_MS);

  setInterval(() => {
    refreshStandardSources()
      .catch((error) => {
        console.error("[scheduler] standard refresh failed:", error);
      })
      .then(() => rebuildDashboardSnapshot("standard"));
  }, STANDARD_REFRESH_MS);
}

// 요청 처리를 함수로 떼어 둔다. 상시 서버(로컬·Render)는 createServer로 감싸 쓰고,
// Vercel은 api/index.js가 이걸 그대로 서버리스 핸들러로 내보낸다.
async function handleRequest(request, response) {
  if (!request.url) {
    jsonResponse(response, 400, { error: "Bad request" });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method !== "GET") {
    jsonResponse(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/api/dashboard") {
    const refreshParam = url.searchParams.get("refresh");
    const forceIds = getForcedSourceIds(refreshParam);

    if (!forceIds.length) {
      try {
        const snapshot = await readDashboardSnapshot();
        if (snapshot && snapshot.payload && Array.isArray(snapshot.payload.sections)) {
          jsonResponse(
            response,
            200,
            {
              ...snapshot.payload,
              cacheState: snapshot.source || "snapshot",
              snapshotUpdatedAt: snapshot.updatedAt
            },
            SNAPSHOT_CACHE_CONTROL
          );
          return;
        }
      } catch (error) {
        console.error("[storage] dashboard read failed:", error);
      }
    }

    // Through the single-flight so a manual refresh coalesces with a scheduled
    // rebuild instead of writing a second collection seconds apart.
    const payload = await rebuildDashboardSnapshot(
      forceIds.length ? `manual:${refreshParam}` : "on-demand",
      forceIds
    );

    if (!payload) {
      jsonResponse(response, 503, { error: "Dashboard rebuild failed" });
      return;
    }

    jsonResponse(response, 200, payload);
    return;
  }

  if (url.pathname.startsWith("/api/source/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/source/", ""));
    const force = url.searchParams.get("refresh") === "1";

    if (!sourceById.has(id)) {
      jsonResponse(response, 404, { error: "Unknown source" });
      return;
    }

    const payload = await loadSource(id, { force });
    jsonResponse(response, 200, payload);
    return;
  }

  // 분야별 목록 하나를 따로 준다. 대시보드 응답에는 분야별 항목을 담지 않는다 —
  // 서점 전체 분야(84종)를 담으면 응답이 10MB를 넘겨 Vercel CDN이 캐시를 포기하고
  // 매 방문이 4~5초가 된다. 분야는 한 번에 서너 개만 보므로 그때 받아 가면 된다.
  //
  // source_snapshots 에 소스별 행이 이미 있으므로 그 한 행만 읽으면 된다.
  if (url.pathname === "/api/list") {
    const id = url.searchParams.get("id") || "";

    if (!sourceById.has(id)) {
      jsonResponse(response, 404, { error: `알 수 없는 목록입니다: ${id}` });
      return;
    }

    try {
      const payload = await loadListForClient(id);
      jsonResponse(response, 200, payload, SNAPSHOT_CACHE_CONTROL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonResponse(response, 200, {
        id,
        items: [],
        error: `목록을 불러오지 못했습니다. ${message}`
      });
    }

    return;
  }

  if (url.pathname === "/api/ranking") {
    try {
      const payload = await loadHistoricalRanking(
        url.searchParams.get("store") || "",
        url.searchParams.get("period") || "",
        url.searchParams.get("date") || ""
      );
      jsonResponse(response, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = Number(error.status) || 502;

      // 400은 요청이 틀린 것이라 로그를 남기지 않는다. 502는 서점 쪽 문제다.
      if (status >= 500) {
        console.error("[ranking] 과거 순위 조회 실패:", message);
      }

      jsonResponse(response, status, { error: message });
    }

    return;
  }

  // 서버리스에는 setInterval이 없으므로 수집을 밖에서 불러 준다(Vercel Cron 또는
  // GitHub Actions). 토큰을 세워 두는 이유는 이 경로가 서점을 긁는 유일한 쓰기
  // 경로여서, 공개돼 있으면 누구나 수집을 돌릴 수 있기 때문이다.
  if (url.pathname === "/api/collect") {
    // Vercel Cron은 CRON_SECRET으로 Authorization 헤더를 보내고, GitHub Actions 쪽은
    // COLLECT_SECRET을 쓴다. 둘 중 아무거나 맞으면 통과시켜 트리거를 바꿔도 그대로 돈다.
    const secrets = [process.env.COLLECT_SECRET, process.env.CRON_SECRET]
      .map((value) => String(value || ""))
      .filter(Boolean);

    if (!secrets.length) {
      jsonResponse(response, 503, {
        error:
          "COLLECT_SECRET(또는 CRON_SECRET)이 설정되지 않아 수집 트리거가 비활성입니다."
      });
      return;
    }

    const header = String(request.headers.authorization || "");
    const provided = header.startsWith("Bearer ")
      ? header.slice(7)
      : url.searchParams.get("token") || "";

    if (!secrets.includes(provided)) {
      jsonResponse(response, 401, { error: "인증이 필요합니다." });
      return;
    }

    // 기본은 실시간만 — 매시 호출되는 쪽이라 전수를 돌리면 서점 부하가 커진다.
    // 일반 목록은 scope=all 로 6시간마다 따로 부른다.
    const scope = url.searchParams.get("scope") === "all" ? "all" : "realtime";
    const startedAt = Date.now();

    try {
      if (scope === "all") {
        await Promise.allSettled([refreshRealtimeSources(), refreshStandardSources()]);
      } else {
        await refreshRealtimeSources();
      }

      const payload = await rebuildDashboardSnapshot(`collect:${scope}`);

      jsonResponse(response, payload ? 200 : 500, {
        ok: Boolean(payload),
        scope,
        generatedAt: payload ? payload.generatedAt : null,
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      console.error("[collect] failed:", error);
      jsonResponse(response, 500, {
        ok: false,
        scope,
        error: String(error.message || error),
        elapsedMs: Date.now() - startedAt
      });
    }

    return;
  }

  if (url.pathname === "/api/health") {
    const supabaseConfigured = Boolean(getSupabaseConfig());
    const probe = await probeSupabase();
    let snapshot = null;
    try {
      snapshot = await readDashboardSnapshot();
    } catch (error) {
      snapshot = null;
    }

    jsonResponse(response, 200, {
      ok: true,
      now: new Date().toISOString(),
      storage: {
        supabase: supabaseConfigured && probe.reachable,
        supabaseConfigured,
        supabaseError: probe.error,
        snapshotSource: snapshot ? snapshot.source : null,
        snapshotUpdatedAt: snapshot ? snapshot.updatedAt : null,
        hasDashboardSnapshot: Boolean(snapshot)
      },
      scheduler: {
        realtimeMinutes: REALTIME_REFRESH_MS / 60000,
        standardHours: STANDARD_REFRESH_MS / 3600000
      }
    });
    return;
  }

  await serveStatic(response, url.pathname);
}

// 서버리스에서는 프로세스가 요청마다 사라지므로 .env를 매 요청 앞에서 한 번만 읽고,
// 그 프로미스를 재사용한다. 상시 서버는 부팅에서 이미 끝내 놓는다.
let envReady = null;

function ensureEnv() {
  if (!envReady) {
    envReady = loadEnvFile();
  }

  return envReady;
}

async function handleServerlessRequest(request, response) {
  await ensureEnv();
  await handleRequest(request, response);
}

async function startStandaloneServer() {
  await ensureEnv();
  startSourceSchedulers();

  const probe = await probeSupabase();
  const storageLabel = probe.reachable
    ? "enabled"
    : `disabled (file cache only: ${probe.error})`;

  const server = http.createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    console.log(`Book ranking dashboard ready at http://${HOST}:${PORT}`);
    console.log(`[storage] supabase=${storageLabel}`);
    console.log(
      `[scheduler] realtime=${REALTIME_REFRESH_MS / 60000}m standard=${STANDARD_REFRESH_MS / 3600000}h`
    );
  });

  return server;
}

// 기본 내보내기는 요청 핸들러여야 한다. Vercel의 서비스 감지는 api/index.js가 아니라
// 이 파일을 그대로 함수 진입점으로 잡는데(빌드 산출물 server.cjs), 그때 module.exports가
// 객체면 "Invalid export found ... The default export must be a function or server"로
// 람다가 부팅조차 못 하고 전 경로가 500이 된다. 실제로 프로덕션이 그 상태였다.
// 이름 있는 내보내기는 속성으로 그대로 남겨 api/index.js와 테스트가 계속 쓰게 한다.
module.exports = handleServerlessRequest;
module.exports.handleRequest = handleRequest;
module.exports.handleServerlessRequest = handleServerlessRequest;
module.exports.ensureEnv = ensureEnv;

// Vercel은 이 파일을 require해서 핸들러만 쓰므로 리스너를 열면 안 된다.
// 직접 실행됐을 때만 상시 서버로 뜬다.
if (require.main === module) {
  startStandaloneServer();
}
