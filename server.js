"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

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
const REALTIME_LIMIT = 100;
const WATCH_PUBLISHER_NAME = "상상스퀘어";
const WATCH_PUBLISHER_KEY = normalizePublisherKey(WATCH_PUBLISHER_NAME);
const FOCUS_BOOK_TITLES = [
  "인생을 위한 최소한의 생각",
  "AI, 신의 탄생 인간의 종말"
];

const YES24_REALTIME_CATEGORIES = [
  { name: "경제경영", categoryNumber: "001001025" },
  { name: "자기계발", categoryNumber: "001001026" },
  { name: "인문", categoryNumber: "001001019" },
  { name: "에세이", categoryNumber: "001001047" },
  { name: "소설/시/희곡", categoryNumber: "001001046" }
];

const ALADIN_REALTIME_CATEGORIES = [
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

const SOURCES = [
  {
    id: "kyobo-total-weekly",
    storeId: "kyobo",
    name: "종합 주간 베스트",
    typeLabel: "주간",
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/total/weekly",
    load: () =>
      fetchKyoboList("total", {
        page: 1,
        per: STANDARD_LIMIT,
        period: "002",
        bsslBksClstCode: "A"
      })
  },
  {
    id: "kyobo-online-daily",
    storeId: "kyobo",
    name: "온라인 베스트 일간",
    typeLabel: "일간",
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/daily",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: STANDARD_LIMIT,
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
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/weekly",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: STANDARD_LIMIT,
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
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl: "https://store.kyobobook.co.kr/bestseller/online/monthly",
    load: () =>
      fetchKyoboList("online", {
        page: 1,
        per: STANDARD_LIMIT,
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
    load: () =>
      fetchKyoboList("realtime", {
        page: 1,
        per: REALTIME_LIMIT
      })
  },
  {
    id: "yes24-bestseller",
    storeId: "yes24",
    name: "국내도서 종합 베스트",
    typeLabel: "종합",
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl: "https://www.yes24.com/product/category/bestseller?categoryNumber=001",
    load: () =>
      fetchYes24List(
        "https://www.yes24.com/product/category/bestseller?categoryNumber=001",
        { limit: STANDARD_LIMIT }
      )
  },
  {
    id: "yes24-realtime",
    storeId: "yes24",
    name: "실시간 베스트 TOP 100",
    typeLabel: "TOP 100",
    group: "overall-realtime",
    realtime: true,
    ttlMs: FIVE_MINUTES,
    sourceUrl:
      "https://www.yes24.com/product/category/realtimebestseller?categoryNumber=001",
    load: () =>
      fetchYes24List(
        "https://www.yes24.com/product/category/realtimebestseller?categoryNumber=001",
        { limit: REALTIME_LIMIT }
      )
  },
  ...YES24_REALTIME_CATEGORIES.map((category) => ({
    id: `yes24-realtime-${category.categoryNumber}`,
    storeId: "yes24",
    name: `${category.name} 실시간`,
    typeLabel: "분야별",
    categoryName: category.name,
    group: "category-realtime",
    realtime: true,
    ttlMs: FIVE_MINUTES,
    sourceUrl: makeYes24RealtimeUrl(category.categoryNumber),
    load: () => fetchYes24List(makeYes24RealtimeUrl(category.categoryNumber), { limit: REALTIME_LIMIT })
  })),
  {
    id: "yes24-day",
    storeId: "yes24",
    name: "일별 베스트셀러",
    typeLabel: "일별",
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl:
      "https://www.yes24.com/product/category/daybestseller?categoryNumber=001",
    load: () =>
      fetchYes24List(
        "https://www.yes24.com/product/category/daybestseller?categoryNumber=001",
        { limit: STANDARD_LIMIT }
      )
  },
  {
    id: "aladin-weekly",
    storeId: "aladin",
    name: "주간 베스트",
    typeLabel: "주간",
    group: "standard",
    realtime: false,
    ttlMs: TEN_MINUTES,
    sourceUrl:
      "https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=Bestseller",
    load: () =>
      fetchAladinList(
        "https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=Bestseller",
        { limit: STANDARD_LIMIT }
      )
  },
  {
    id: "aladin-now",
    storeId: "aladin",
    name: "지금 베스트 TOP 100",
    typeLabel: "TOP 100",
    group: "overall-realtime",
    realtime: true,
    ttlMs: FIVE_MINUTES,
    sourceUrl:
      "https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=NowBest",
    load: () =>
      fetchAladinList(
        "https://www.aladin.co.kr/shop/common/wbest.aspx?BranchType=1&BestType=NowBest",
        { limit: REALTIME_LIMIT, pages: 2 }
      )
  },
  ...ALADIN_REALTIME_CATEGORIES.map((category) => ({
    id: `aladin-now-${category.cid}`,
    storeId: "aladin",
    name: `${category.name} 실시간`,
    typeLabel: "분야별",
    categoryName: category.name,
    group: "category-realtime",
    realtime: true,
    ttlMs: FIVE_MINUTES,
    sourceUrl: makeAladinNowUrl(category.cid),
    load: () => fetchAladinList(makeAladinNowUrl(category.cid), { limit: REALTIME_LIMIT, pages: 2 })
  }))
];

const sourceById = new Map(SOURCES.map((source) => [source.id, source]));

function makeYes24RealtimeUrl(categoryNumber) {
  return `https://www.yes24.com/product/category/realtimebestseller?categoryNumber=${categoryNumber}`;
}

function makeAladinNowUrl(cid = "") {
  const url = new URL("https://www.aladin.co.kr/shop/common/wbest.aspx");
  url.searchParams.set("BranchType", "1");
  url.searchParams.set("BestType", "NowBest");

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

async function fetchText(url, headers = {}) {
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

function matchesFocusTitle(itemTitle, focusTitle) {
  const itemKey = normalizeTitleKey(itemTitle);
  const focusKey = normalizeTitleKey(focusTitle);
  return Boolean(itemKey && focusKey && itemKey.includes(focusKey));
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
    link: item.saleCmdtid
      ? `https://product.kyobobook.co.kr/detail/${item.saleCmdtid}`
      : "",
    image: buildKyoboImageUrl(item)
  };
}

async function fetchKyoboList(type, params, options = {}) {
  const query = new URLSearchParams();
  const limit = options.limit || params.per || STANDARD_LIMIT;

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
  const data = payload.data || {};

  return {
    items: dedupeByRank((data.bestSeller || []).map(mapKyoboItem)).slice(0, limit),
    sourceStamp: formatKyoboStamp(data.ymw)
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
  const html = await fetchText(url, {
    accept: "text/html,application/xhtml+xml"
  });
  const blocks = html.split(/<li class="[^"]*" data-goods-no="/).slice(1);

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

function buildPayload(definition, result, options = {}) {
  const now = new Date();
  return {
    id: definition.id,
    storeId: definition.storeId,
    name: definition.name,
    typeLabel: definition.typeLabel,
    group: definition.group || (definition.realtime ? "overall-realtime" : "standard"),
    categoryName: definition.categoryName || "",
    realtime: definition.realtime,
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

function buildPublisherAlerts(sections) {
  const items = sections.flatMap((section) =>
    section.lists.flatMap((list) =>
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

function buildFocusBooks(sections) {
  return FOCUS_BOOK_TITLES.map((title) => {
    const appearances = sections.flatMap((section) =>
      section.lists.flatMap((list) =>
        list.items
          .filter((item) => matchesFocusTitle(item.title, title))
          .map((item) => ({
            storeId: section.id,
            storeName: section.name,
            listId: list.id,
            listName: list.name,
            group: list.group || "",
            categoryName: list.categoryName || "",
            realtime: Boolean(list.realtime),
            rank: item.rank,
            title: item.title,
            link: item.link,
            image: item.image,
            publisher: item.publisher || ""
          }))
      )
    );
    const realtimeAppearances = appearances.filter((item) => item.realtime);
    const rankBasis = realtimeAppearances.length ? realtimeAppearances : appearances;
    const bestRank = rankBasis.length
      ? Math.min(...rankBasis.map((item) => item.rank).filter(Boolean))
      : null;

    appearances.sort((a, b) => {
      if (a.realtime !== b.realtime) {
        return a.realtime ? -1 : 1;
      }

      return (a.rank || 9999) - (b.rank || 9999);
    });

    return {
      title,
      bestRank,
      appearanceCount: appearances.length,
      appearances
    };
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

    return {
      ...buildPayload(definition, { items: [], sourceStamp: "" }, { error: message }),
      cacheState: "error"
    };
  }
}

async function buildDashboard(forceIds = []) {
  const lists = await Promise.all(
    SOURCES.map((source) =>
      loadSource(source.id, {
        force: forceIds.includes(source.id)
      })
    )
  );

  const sections = STORES.map((store) => ({
    ...store,
    lists: lists.filter((list) => list.storeId === store.id)
  }));

  return {
    generatedAt: new Date().toISOString(),
    sections,
    alerts: buildPublisherAlerts(sections),
    focusBooks: buildFocusBooks(sections)
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
