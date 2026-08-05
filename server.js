"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const SOURCE_CACHE_DIR = path.join(__dirname, ".cache", "rankings");

const FIVE_MINUTES = 5 * 60 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

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
const YES24_PERIOD_PATHS = {
  realtime: "realtimebestseller",
  daily: "daybestseller",
  weekly: "bestseller"
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
const KYOBO_CATEGORIES = [
  { name: "경제/경영", code: "13" },
  { name: "자기계발", code: "15" },
  { name: "인문", code: "05" },
  { name: "시/에세이", code: "03" },
  { name: "소설", code: "01" }
];
const KYOBO_CATEGORY_NOTE =
  "교보문고는 분야별 실시간 순위를 제공하지 않습니다. 전체 실시간 TOP 100에 든 책을 분야로 나눈 목록이며, 순위는 종합 순위 기준입니다.";
const KYOBO_REALTIME_SNAPSHOT_TTL_MS = 60 * 1000;

const YES24_CATEGORIES = [
  { name: "경제경영", categoryNumber: "001001025" },
  { name: "자기계발", categoryNumber: "001001026" },
  { name: "인문", categoryNumber: "001001019" },
  { name: "에세이", categoryNumber: "001001047" },
  { name: "소설/시/희곡", categoryNumber: "001001046" }
];

const ALADIN_CATEGORIES = [
  { name: "경제경영", cid: "170" },
  { name: "자기계발", cid: "336" },
  { name: "인문학", cid: "656" },
  { name: "에세이", cid: "55889" },
  { name: "소설/시/희곡", cid: "1" }
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
    realtime,
    ttlMs: realtime ? FIVE_MINUTES : TEN_MINUTES,
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
    id: `kyobo-daily-${category.code}`,
    sourceUrl: `https://store.kyobobook.co.kr/bestseller/online/daily/domestic/${category.code}`,
    load: () => fetchKyoboCategoryList("001", category.code)
  }),
  makeCategorySource({
    storeId: "kyobo",
    period: "weekly",
    categoryName: category.name,
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

const ALADIN_CATEGORY_SOURCES = ALADIN_CATEGORIES.flatMap((category) =>
  ["realtime", "daily", "weekly"].map((period) => {
    const sourceUrl = makeAladinUrl(period, category.cid);

    return makeCategorySource({
      storeId: "aladin",
      period,
      categoryName: category.name,
      id: `aladin-${period}-${category.cid}`,
      sourceUrl,
      load: () =>
        fetchAladinList(sourceUrl, { limit: RANK_LIMIT, pages: ALADIN_PAGES_FOR_100 })
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: FIVE_MINUTES,
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
    ttlMs: FIVE_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: FIVE_MINUTES,
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
    ttlMs: TEN_MINUTES,
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
    ttlMs: TEN_MINUTES,
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

async function writePersistedSource(id, payload, expiresAt) {
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
}

async function readPersistedSource(id) {
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

function createHeaders(extra = {}) {
  return {
    "user-agent": USER_AGENT,
    "accept-language": ACCEPT_LANGUAGE,
    ...extra
  };
}

// 목록이 많아 한 번에 수십 건이 나가면 서점 쪽에서 차단당하므로
// 도메인마다 동시 요청 수를 제한한다.
const hostQueues = new Map();

function getHostQueue(host) {
  if (!hostQueues.has(host)) {
    hostQueues.set(host, { active: 0, waiting: [] });
  }

  return hostQueues.get(host);
}

function acquireHostSlot(host) {
  const queue = getHostQueue(host);

  if (queue.active < HOST_CONCURRENCY) {
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

  if (!rank || !title || (category && !category.includes("도서"))) {
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
    publishedAt: normalizePublishedAt(publishedAt),
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
  const blocks = htmlPages.flatMap((html) =>
    html.split(/<li class="[^"]*" data-goods-no="/).slice(1)
  );

  return {
    items: dedupeByRank(blocks.map(mapYes24Block).filter(Boolean)).slice(0, limit),
    sourceStamp: ""
  };
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

  if (
    !rank ||
    !title ||
    /음반|DVD|블루레이|굿즈|문구|티켓|캘린더|달력/i.test(category)
  ) {
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
    publishedAt: normalizePublishedAt(stripTags(authorLine)),
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
  const blocks = htmlPages.flatMap((html) =>
    html.split(/<div class="ss_book_box"[^>]*>/).slice(1)
  );
  const items = dedupeByRank(blocks.map(mapAladinBlock).filter(Boolean)).slice(0, limit);

  return {
    items,
    sourceStamp: "",
    warning:
      items.length > 0 && items[0].rank > 1
        ? "비도서 항목을 제외하고 도서만 표시합니다."
        : ""
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
    publishedAt: normalizePublishedAt(stripTags(publisherLine[2])),
    link: normalizeUrl(
      extract(block, /<a href="([^"]*wproduct\.aspx\?ItemId=\d+)"/),
      "https://www.aladin.co.kr"
    )
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

  return books
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, FOCUS_CATALOG_LIMIT);
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

function buildPayload(definition, result, options = {}) {
  const now = new Date();
  return {
    id: definition.id,
    storeId: definition.storeId,
    name: definition.name,
    typeLabel: definition.typeLabel,
    group: definition.group || (definition.realtime ? "overall-realtime" : "standard"),
    categoryName: definition.categoryName || "",
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
    itemCount: result.items.length,
    items: result.items,
    warning: options.warning || result.warning || "",
    error: options.error || "",
    stale: Boolean(options.stale)
  };
}

// 다른 목록에서 파생된 목록은 같은 책을 같은 순위로 다시 담고 있으므로 집계에서 제외한다.
function getSourceLists(section) {
  return section.lists.filter((list) => !list.derived);
}

function buildPublisherAlerts(sections) {
  const items = sections.flatMap((section) =>
    getSourceLists(section).flatMap((list) =>
      list.items
        .filter((item) => isWatchedPublisher(item.publisher))
        .map((item) => ({
          publisherName: WATCH_PUBLISHER_NAME,
          storeId: section.id,
          storeName: section.name,
          listId: list.id,
          listName: list.name,
          rank: item.rank,
          title: item.title,
          link: item.link,
          image: item.image,
          publisher: item.publisher || ""
        }))
    )
  );

  return {
    publisherName: WATCH_PUBLISHER_NAME,
    totalCount: items.length,
    uniqueTitleCount: new Set(items.map((item) => `${item.title}::${item.publisher}`)).size,
    items
  };
}

function buildFocusBooks(sections, catalog = []) {
  const booksByTitle = new Map(
    catalog.map((book) => [
      normalizeTitleKey(book.title),
      {
        title: book.title,
        publishedAt: book.publishedAt || "",
        link: book.link || "",
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
              appearances: []
            });
          }

          booksByTitle.get(key).appearances.push({
            storeId: section.id,
            storeName: section.name,
            listId: list.id,
            listName: list.name,
            listUrl: list.sourceUrl || "",
            group: list.group || "",
            categoryName: list.categoryName || "",
            realtime: Boolean(list.realtime),
            rank: item.rank,
            title: item.title,
            link: item.link,
            image: item.image,
            publisher: item.publisher || "",
            publishedAt: item.publishedAt || ""
          });
        });
    });
  });

  return [...booksByTitle.values()]
    .map((book) => {
      const appearances = book.appearances;
      const realtimeAppearances = appearances.filter((item) => item.realtime);
      const rankBasis = realtimeAppearances.length ? realtimeAppearances : appearances;
      const bestRank = rankBasis.length
        ? Math.min(...rankBasis.map((item) => item.rank).filter(Boolean))
        : null;
      const latestPublishedAt =
        [book.publishedAt, ...appearances.map((item) => item.publishedAt)]
          .filter(Boolean)
          .sort()
          .at(-1) || "";

      appearances.sort((a, b) => {
        if (a.realtime !== b.realtime) {
          return a.realtime ? -1 : 1;
        }

        return (a.rank || 9999) - (b.rank || 9999);
      });

      return {
        title: book.title,
        link: book.link || appearances.find((item) => item.link)?.link || "",
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

  return {
    generatedAt: new Date().toISOString(),
    assetVersion: await getAssetVersion(),
    sections,
    alerts: buildPublisherAlerts(sections),
    focusBooks: buildFocusBooks(sections, catalog)
  };
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

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
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
  const normalizedPath =
    requestPath === "/" || requestPath === "/main" || requestPath === "/main/"
      ? "/index.html"
      : requestPath;
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

function startSourceSchedulers() {
  setTimeout(() => {
    refreshRealtimeSources().catch((error) => {
      console.error("[scheduler] initial realtime refresh failed:", error);
    });
    refreshStandardSources().catch((error) => {
      console.error("[scheduler] initial standard refresh failed:", error);
    });
  }, 1000);

  setInterval(() => {
    refreshRealtimeSources().catch((error) => {
      console.error("[scheduler] realtime refresh failed:", error);
    });
  }, FIVE_MINUTES);

  setInterval(() => {
    refreshStandardSources().catch((error) => {
      console.error("[scheduler] standard refresh failed:", error);
    });
  }, TEN_MINUTES);
}

const server = http.createServer(async (request, response) => {
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
    const payload = await buildDashboard(forceIds);
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

  if (url.pathname === "/api/health") {
    jsonResponse(response, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  await serveStatic(response, url.pathname);
});

startSourceSchedulers();

server.listen(PORT, HOST, () => {
  console.log(`Book ranking dashboard ready at http://${HOST}:${PORT}`);
});
