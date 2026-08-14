"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

async function loadEnvFile() {
  try {
    const raw = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
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
const DASHBOARD_SNAPSHOT_ID = "latest";

// 서점 실시간은 약 1시간, 일·주간은 더 느리게 바뀌므로 수집 주기를 맞춤.
const REALTIME_REFRESH_MS = 60 * 60 * 1000;
const STANDARD_REFRESH_MS = 6 * 60 * 60 * 1000;
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
    weekly: "최근 7일 · 매일 1회 집계"
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
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
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
async function probeSupabase() {
  if (!getSupabaseConfig()) {
    return { reachable: false, error: "not configured" };
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

  const hasEmptyPage = perPage.some((page) => page.length === 0);

  return hasEmptyPage
    ? `일부 페이지를 읽지 못해 ${items[0].rank}위부터 표시합니다.`
    : "비도서 항목을 제외하고 도서만 표시합니다.";
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
  const snippet = text.length > 32 ? text.slice(0, 32) : text;
  return `#:~:text=${encodeURIComponent(snippet)}`;
}

function appendRankAnchor(storeId, pageUrl, link, title) {
  if (!pageUrl) {
    return "";
  }

  const base = pageUrl.split("#")[0];

  // 상품 id 앵커(ordChk, addInputShop)는 카드 하단에 있어 제목이 화면 밖으로 밀린다.
  // 제목 텍스트 조각으로 스크롤하면 클릭 직후 그 도서가 보이게 된다(Chrome/Edge).
  const fragment = textFragmentAnchor(title);

  if (fragment) {
    return `${base}${fragment}`;
  }

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
// 예스24는 24권, 알라딘은 50권 단위로 페이지가 갈린다.
// 교보문고는 SPA여도 Chromium 텍스트 조각(#:~:text=)으로 제목 위치까지 이동한다.
// 교보는 순위 페이지 링크를 만들지 않는다. 우리가 읽는 교보 API의 순위와 웹
// 베스트셀러 페이지의 배열이 서로 달라서(수집 기준 21위가 1쪽, 45위가 3쪽,
// 60위가 4쪽에 있는 식으로 균일한 쪽당 개수로 설명되지 않는다) 순위에서 쪽 번호를
// 계산할 방법이 없다. 못 맞히는 위치로 보내 목록 맨 위에 떨구느니 상품 상세로
// 보내는 편이 낫다. 예스24(24개/쪽)와 알라딘(50개/쪽)은 계산이 맞는 것을 확인했다.
function buildRankListUrl(storeId, sourceUrl, rank, link = "", title = "") {
  if (!sourceUrl || storeId === "kyobo") {
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

  return {
    items,
    sourceStamp: parseYes24Stamp(htmlPages[0]),
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
    sections,
    focusBooks,
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

    if (!forceIds.length) {
      try {
        const snapshot = await readDashboardSnapshot();
        if (snapshot && snapshot.payload && Array.isArray(snapshot.payload.sections)) {
          jsonResponse(response, 200, {
            ...snapshot.payload,
            cacheState: snapshot.source || "snapshot",
            snapshotUpdatedAt: snapshot.updatedAt
          });
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
});

loadEnvFile().then(async () => {
  startSourceSchedulers();

  const probe = await probeSupabase();
  const storageLabel = probe.reachable
    ? "enabled"
    : `disabled (file cache only: ${probe.error})`;

  server.listen(PORT, HOST, () => {
    console.log(`Book ranking dashboard ready at http://${HOST}:${PORT}`);
    console.log(`[storage] supabase=${storageLabel}`);
    console.log(
      `[scheduler] realtime=${REALTIME_REFRESH_MS / 60000}m standard=${STANDARD_REFRESH_MS / 3600000}h`
    );
  });
});
