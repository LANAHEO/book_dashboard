const state = {
  dashboard: null,
  assetVersion: "",
  activeView: "focus",
  search: "",
  selectedStore: "all",
  loading: false,
  refreshTimer: null,
  badgeResetTimer: null,
  hasLoadedOnce: false,

  // 분야별 화면도 주간부터 연다. 교보는 분야별 실시간을 아예 내주지 않아서
  // 실시간으로 열면 첫 화면이 두 서점짜리가 된다.
  categoryPeriod: "weekly",
  // 분야는 서점을 가로지르는 묶음 키로 고른다(예: "economy").
  categoryGroup: "",
  rankPages: {},
  // null이면 화면 폭으로 정하고, 사용자가 한 번이라도 여닫으면 그 값을 따른다.
  collectStatusOpen: null
};

// 모바일 규칙과 같은 경계를 쓴다(styles.css의 820px). 두 곳이 어긋나면
// 접힌 채로 데스크톱 여백만 잡아먹는 상태가 생긴다.
function isNarrowScreen() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 820px)").matches
    : false;
}

const elements = {
  dashboard: document.getElementById("dashboard"),
  generatedAt: document.getElementById("generated-at"),
  summaryText: document.getElementById("summary-text"),
  searchInput: document.getElementById("search-input"),
  storeFilters: document.getElementById("store-filters"),
  viewNav: document.querySelector(".view-nav"),
  collectStatus: document.getElementById("collect-status"),
  autoRefreshBadge: document.getElementById("auto-refresh-badge"),
  autoRefreshText: document.getElementById("auto-refresh-text")
};

const BADGE_IDLE_FALLBACK = "자동 갱신 준비 중";

// 주기를 여기에 적어 두면 서버 설정을 바꿀 때 같이 안 고쳐진다. 실제로 그래서
// "실시간 5분 / 일반 10분"이라고 표시하면서 60분마다 수집하고 있었다.
function badgeIdleText() {
  const intervals = state.dashboard && state.dashboard.collectIntervals;

  if (!intervals) {
    return BADGE_IDLE_FALLBACK;
  }

  // "자동 갱신"만 적으면 이 숫자가 순위의 집계 기준으로 읽힌다. 이건 우리가 서점을
  // 다시 긁는 간격이고, 순위 자체의 기준은 아래 수집 시점 표에 서점별로 따로 있다.
  return `우리 수집 주기 · 실시간 ${intervals.realtimeMinutes}분 / 일반 ${intervals.standardHours}시간`;
}
const BADGE_UPDATE_FLASH_MS = 3200;
const WATCH_PUBLISHER_NAME = "상상스퀘어";
const WATCH_PUBLISHER_KEY = WATCH_PUBLISHER_NAME.replace(/\s+/g, "").toLowerCase();
const STORE_ALERT_ORDER = ["kyobo", "yes24", "aladin"];
const RANK_PAGE_SIZE = 20;
const FOCUS_DROPPED_LIMIT = 4;

// 상상스퀘어 카드의 네모·바 칸 순서. 세 칸이 어느 카드에서나 같은 순서로
// 서고, 위쪽 네모가 서점 이름을 달고 있어서, 아래 바의 숫자는 몇 번째
// 칸에 있는지만으로 어느 서점 것인지 읽힌다.
const FOCUS_STORE_COLUMNS = [
  { id: "kyobo", label: "교보" },
  { id: "yes24", label: "예스" },
  { id: "aladin", label: "알라딘" }
];

// 바 네 줄. 종합과 분야를 갈라 둔다 — 예전 타일은 한 기간의 최고를 종합·분야
// 가리지 않고 하나로 보여 줬는데, 그러면 "주간 23위"가 종합인지 분야인지
// 카드에서 알 수 없었다.
const FOCUS_BAR_ROWS = [
  { key: "weekly-standard", label: "주간종합순위", group: "standard", period: "weekly" },
  { key: "daily-standard", label: "일간종합순위", group: "standard", period: "daily" },
  { key: "weekly-category", label: "주간분야순위", group: "category", period: "weekly" },
  { key: "daily-category", label: "일간분야순위", group: "category", period: "daily" }
];

// 바 길이를 정하는 기준. 서점 목록이 TOP 100이라 100위가 바닥이다.
const FOCUS_BAR_SCALE = 100;
// 기간 순서는 화면 어디서나 같다: 주간 → 일간 → 실시간. 분야별 화면의
// 기간 단추도 이 순서를 따르고, 첫 단추가 기본값이 된다.
const CATEGORY_PERIODS = [
  { key: "weekly", label: "주간" },
  { key: "daily", label: "일간" },
  { key: "realtime", label: "실시간" }
];
const VIEW_LABELS = {
  focus: "상상스퀘어 도서 순위",
  weekly: "전체 서점 주간 순위",
  daily: "전체 서점 일간 순위",
  category: "분야별 순위",
  realtime: "전체 실시간 TOP 100"
};

function escapeHtml(value) {
  // 0을 빈 문자열로 떨어뜨리면 안 된다. "검색 결과 0권"이 "검색 결과 권"으로,
  // "0권 수집"이 "권 수집"으로 나온다. 숫자 0은 값이 없는 것과 다르다.
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "알 수 없음";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function setAutoRefreshBadge(text, badgeState = "active") {
  if (!elements.autoRefreshBadge || !elements.autoRefreshText) {
    return;
  }

  elements.autoRefreshBadge.dataset.badgeState = badgeState;
  elements.autoRefreshText.textContent = text;
}

function clearBadgeResetTimer() {
  if (state.badgeResetTimer) {
    clearTimeout(state.badgeResetTimer);
    state.badgeResetTimer = null;
  }
}

function showIdleBadge() {
  clearBadgeResetTimer();
  setAutoRefreshBadge(badgeIdleText(), "idle");
}

function showUpdatedBadge() {
  clearBadgeResetTimer();
  setAutoRefreshBadge("자동 갱신 · 방금 업데이트됨", "updated");
  state.badgeResetTimer = window.setTimeout(() => {
    showIdleBadge();
  }, BADGE_UPDATE_FLASH_MS);
}

function normalizePublisherKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isWatchedPublisherItem(item) {
  return normalizePublisherKey(item.publisher).includes(WATCH_PUBLISHER_KEY);
}

function getRankValue(rank) {
  const value = Number(rank);
  return Number.isFinite(value) ? value : 9999;
}

function filterBySelectedStore(items) {
  if (state.selectedStore === "all") {
    return items;
  }

  return items.filter((item) => item.storeId === state.selectedStore);
}

// 검색은 순위 목록만 걸러 왔고 상상스퀘어 카드는 그대로 있었다. 같은 화면의
// 같은 입력칸인데 한쪽에만 듣는다. 제목과 출판사로 맞춰 본다 — 노출 항목에
// 들어 있는 값이 그 둘이다.
function focusBookMatchesSearch(book) {
  if (!state.search) {
    return true;
  }

  const parts = [book.title];

  (book.appearances || []).forEach((item) => {
    parts.push(item.title, item.publisher);
  });

  return parts.filter(Boolean).join(" ").toLowerCase().includes(state.search);
}

// 순서는 서버가 정한 그대로 쓴다 — 주요 도서가 맨 앞, 그 뒤는 출간 최신순.
//
// 여기서 다시 정렬하지 않는다. 예전에는 "순위에 든 책"을 앞으로 모으는 정렬이
// 한 줄 있었는데, 그게 출간순을 깨뜨렸다. 노출 0곳인 신간이 몇 달 전에 나온
// 순위권 도서 뒤로 밀려서, 첫 화면에서 최신 출간이 사라졌다. 서버에서 같은
// 묶음을 지웠지만 화면 쪽이 남아 있어 화면만 계속 어긋나 보였다.
function getVisibleFocusBooks() {
  return (state.dashboard?.focusBooks || [])
    .filter(focusBookMatchesSearch)
    .map((book) => ({
      ...book,
      appearances: filterBySelectedStore(book.appearances || []),
      // 이탈도 같이 걸러야 교보를 골랐을 때 알라딘 이탈이 섞이지 않는다.
      droppedOut: filterBySelectedStore(book.droppedOut || [])
    }));
}

// 칩 순서는 순위 종류로 먼저 정한다: 주간 → 일간 → 월간 → 분야별 → 실시간.
// 순위 숫자는 같은 종류 안에서만 견준다. 숫자를 앞세우면 종류가 뒤섞여
// 나오는데, 어느 순위인지가 몇 위인지보다 먼저 읽혀야 하는 화면이다.
// 분야별 안에서도 같은 기간 순서를 쓴다.
const APPEARANCE_GROUP_BASE = { standard: 0, category: 10, "overall-realtime": 20 };
const APPEARANCE_PERIOD_ORDER = { weekly: 0, daily: 1, monthly: 2, realtime: 3 };

// 배포 직전에 캐시된 응답에는 period가 없다. 그때는 목록 이름에서 읽는다 —
// 이름에도 없으면 제 묶음의 맨 뒤에 세운다(순서만 늦어지고 빠지지는 않는다).
function appearancePeriod(item) {
  if (item.period) {
    return item.period;
  }

  const name = String(item.listName || "");

  if (name.includes("주간")) return "weekly";
  if (name.includes("일간") || name.includes("일별")) return "daily";
  if (name.includes("월간")) return "monthly";

  return item.realtime ? "realtime" : "";
}

function appearanceOrder(item) {
  const base = APPEARANCE_GROUP_BASE[item.group] ?? 30;

  return base + (APPEARANCE_PERIOD_ORDER[appearancePeriod(item)] ?? 8);
}

function sortAppearances(items) {
  return [...items].sort(
    (a, b) =>
      appearanceOrder(a) - appearanceOrder(b) ||
      getRankValue(a.rank) - getRankValue(b.rank)
  );
}

function visibleDropouts(book) {
  return (book.droppedOut || []).slice(0, FOCUS_DROPPED_LIMIT);
}

// 서버가 내려주는 listUrl 에는 조각이 없다. 제목을 퍼센트 인코딩한 조각이
// 항목마다 100바이트가 넘어서, 전 서점 분야를 담은 응답에서만 2.2MB였고
// 그 무게 때문에 CDN 캐시가 통째로 꺼졌다. 제목은 이미 항목에 있으니 여기서 만든다.
//
// 자르는 규칙은 server.js 의 textFragmentAnchor 와 같아야 한다. 단어 중간에서
// 끊으면 텍스트 조각이 아예 매칭되지 않는다 — 조각은 단어 경계에서만 일치한다.
function titleFragment(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();

  if (!text) {
    return "";
  }

  let snippet = text;

  if (text.length > 32) {
    const head = text.slice(0, 32);
    const lastSpace = head.lastIndexOf(" ");
    snippet = lastSpace > 0 ? head.slice(0, lastSpace) : text;
  }

  return `#:~:text=${encodeURIComponent(snippet)}`;
}

// 순위 목록으로 가는 링크. 그 책 제목까지 스크롤되도록 조각을 붙인다.
//
// 제목 조각이 언제나 우선이다. 서버가 붙여 둔 상품 id 앵커(#ordChk_, #addInputShop_)는
// 카드 하단을 가리켜서 정작 제목이 화면 밖으로 밀린다 — 제목을 모를 때만 쓴다.
function rankHref(item) {
  if (!item.listUrl) {
    return item.link || "";
  }

  const fragment = titleFragment(item.title);

  if (!fragment) {
    return item.listUrl;
  }

  return item.listUrl.split("#")[0] + fragment;
}

// 실시간 순위는 서점에서 계속 바뀐다. 우리가 보여 주는 값은 "11:00 기준"처럼
// 특정 시점의 것이고, 누르면 열리는 페이지는 지금 값이라 다를 수밖에 없다.
// 실제로 재 보니 주간·일간·분야 목록은 32건 전부 링크가 연 화면과 같았고,
// 어긋난 12건은 전부 실시간이었다. 그래서 실시간 칸에는 기준 시각과 함께
// "지금 값과 다를 수 있다"를 안내에 붙인다 — 숫자만 두면 오류로 읽힌다.
function rankTimingNote(item) {
  if (!item.realtime) {
    return "";
  }

  const stamp = item.sourceStamp ? `${item.sourceStamp} 기준` : "수집 시점 기준";

  return ` · ${stamp}(서점 페이지는 지금 값이라 다를 수 있습니다)`;
}

function searchableText(item) {
  return [item.title, item.meta, item.secondary, item.publisher]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterItems(items) {
  if (!state.search) {
    return items;
  }

  return items.filter((item) => searchableText(item).includes(state.search));
}

function renderItem(item) {
  const watchedPublisher = isWatchedPublisherItem(item);
  const leadingRank = getRankValue(item.rank) <= 3;
  const image = item.image
    ? `<div class="cover"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy"></div>`
    : '<div class="cover"></div>';

  // 순위를 보러 온 화면이므로 그 책이 실제로 놓인 목록 위치로 보낸다.
  // 목록 위치를 못 만들었을 때만 상품 상세로 떨어진다.
  const href = rankHref(item);
  const hint = item.listUrl
    ? `${item.title} · ${item.rank}위 위치로 이동${rankTimingNote(item)}`
    : `${item.title} 상세 페이지 열기`;
  const titleStart = href
    ? `<a class="book-title" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(hint)}">`
    : '<span class="book-title">';
  const titleEnd = href ? "</a>" : "</span>";
  const publisherFlag = watchedPublisher
    ? `<span class="publisher-flag">${escapeHtml(WATCH_PUBLISHER_NAME)}</span>`
    : "";

  return `
    <li class="rank-item ${watchedPublisher ? "rank-item-alert" : ""} ${leadingRank ? "rank-item-leading" : ""}">
      <span class="rank-badge">${escapeHtml(item.rank)}</span>
      ${image}
      <div class="book-copy">
        <div class="book-title-row">
          ${titleStart}${escapeHtml(item.title)}${titleEnd}
          ${publisherFlag}
        </div>
        ${item.meta ? `<div class="book-meta">${escapeHtml(item.meta)}</div>` : ""}
        ${item.secondary ? `<div class="book-secondary">${escapeHtml(item.secondary)}</div>` : ""}
      </div>
    </li>
  `;
}

function getRankPageData(list, items) {
  const paged =
    list.paginate !== false && (list.realtime || items.length > RANK_PAGE_SIZE);

  if (!paged || state.search) {
    return {
      items,
      currentPage: 1,
      totalPages: 1,
      paged: false
    };
  }

  const highestRank = Math.max(
    list.realtime ? 100 : 0,
    ...items.map((item) => getRankValue(item.rank)).filter((rank) => rank < 9999)
  );
  const totalPages = Math.max(1, Math.ceil(highestRank / RANK_PAGE_SIZE));
  const requestedPage = Number(state.rankPages[list.id]) || 1;
  const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
  const from = (currentPage - 1) * RANK_PAGE_SIZE + 1;
  const to = currentPage * RANK_PAGE_SIZE;

  return {
    items: items.filter((item) => {
      const rank = getRankValue(item.rank);
      return rank >= from && rank <= to;
    }),
    currentPage,
    totalPages,
    paged: true
  };
}

function renderRankPagination(list, pageData) {
  if (!pageData.paged || pageData.totalPages <= 1) {
    return "";
  }

  return `
    <div class="rank-range" aria-label="${escapeHtml(list.name)} 순위 구간">
      ${Array.from({ length: pageData.totalPages }, (_, index) => {
        const page = index + 1;
        const from = index * RANK_PAGE_SIZE + 1;
        const to = page * RANK_PAGE_SIZE;

        return `
          <button
            type="button"
            class="rank-range-button ${pageData.currentPage === page ? "active" : ""}"
            data-rank-page="${page}"
            data-list-id="${escapeHtml(list.id)}"
            aria-pressed="${pageData.currentPage === page ? "true" : "false"}"
          >
            ${from}–${to}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderCard(list) {
  const filteredItems = filterItems(list.items);
  const pageData = getRankPageData(list, filteredItems);
  const items = pageData.items;
  const classNames = [
    "panel",
    list.realtime ? "realtime" : "",
    list.group === "overall-realtime" ? "panel-priority" : "",
    list.itemCount >= 80 ? "panel-long" : ""
  ]
    .filter(Boolean)
    .join(" ");
  const panelStyle =
    list.accent && list.softAccent
      ? ` style="--store-accent:${escapeHtml(list.accent)}; --store-soft:${escapeHtml(list.softAccent)}"`
      : "";

  const note = list.error
    ? `<p class="panel-note panel-note-error">${escapeHtml(list.error)}</p>`
    : list.warning
      ? `<p class="panel-note panel-note-warning">${escapeHtml(list.warning)}</p>`
      : list.note
        ? `<p class="panel-note panel-note-info">${escapeHtml(list.note)}</p>`
        : "";

  // 분야별 목록은 항목을 따로 받아오므로, 도착 전에는 비었다고 하면 안 된다.
  const content = list.pendingItems
    ? '<div class="panel-empty panel-loading">순위를 불러오는 중입니다.</div>'
    : items.length > 0
      ? `<ol class="rank-list">${items.map(renderItem).join("")}</ol>`
      : '<div class="panel-empty">현재 검색어와 일치하는 책이 없습니다.</div>';
  const countLabel = state.search
    ? `검색 결과 ${filteredItems.length}권`
    : list.realtime
      ? `100위 범위 · ${list.itemCount}권 수집`
      : `${list.itemCount}권 수집`;
  const typeLabel = list.typeLabel || (list.realtime ? "실시간" : "베스트");

  return `
    <article class="${classNames}"${panelStyle} data-store-id="${escapeHtml(list.storeId || "")}">
      <div class="panel-head">
        <div>
          <div class="panel-title-line">
            <h3 class="panel-title">${escapeHtml(list.name)}</h3>
            ${list.storeName ? `<span class="store-mini">${escapeHtml(list.storeName)}</span>` : ""}
            ${list.categoryName ? `<span class="store-mini category-mini">${escapeHtml(list.categoryName)}</span>` : ""}
          </div>
          <div class="panel-meta">
            <span>${escapeHtml(typeLabel)}</span>
            <span>${escapeHtml(countLabel)}</span>
            ${renderSourceBasis(list)}
          </div>
        </div>
      </div>
      <div class="panel-body">
        ${note}
        ${renderRankPagination(list, pageData)}
        <div class="rank-scroll">${content}</div>
      </div>
    </article>
  `;
}

function decorateList(list, section) {
  return {
    ...list,
    storeName: list.storeName || section.name,
    accent: list.accent || section.accent,
    softAccent: list.softAccent || section.softAccent
  };
}

function flattenLists(sections) {
  return sections.flatMap((section) =>
    section.lists.map((list) => decorateList(list, section))
  );
}

function getVisibleSections(sections) {
  const filteredSections =
    state.selectedStore === "all"
      ? sections
      : sections.filter((section) => section.id === state.selectedStore);

  return filteredSections.map((section) => ({
    ...section,
    lists: section.lists.map((list) => decorateList(list, section))
  }));
}

function renderStoreFilters(sections) {
  if (!elements.storeFilters) {
    return;
  }

  const filters = [
    { id: "all", name: "전체" },
    ...sections.map((section) => ({
      id: section.id,
      name: section.name
    }))
  ];

  elements.storeFilters.innerHTML = filters
    .map(
      (filter) => `
        <button
          type="button"
          class="store-filter-button ${state.selectedStore === filter.id ? "active" : ""}"
          data-store-filter="${escapeHtml(filter.id)}"
          aria-pressed="${state.selectedStore === filter.id ? "true" : "false"}"
        >
          ${escapeHtml(filter.name)}
        </button>
      `
    )
    .join("");
}

function bestAppearanceFor(appearances, predicate) {
  const ranked = appearances.filter((item) => {
    const rank = Number(item.rank);
    return predicate(item) && Number.isFinite(rank) && rank > 0;
  });

  if (!ranked.length) {
    return null;
  }

  return ranked.reduce((best, item) =>
    Number(item.rank) < Number(best.rank) ? item : best
  );
}

// 카드 한 장에 그릴 것을 한 번에 정한다. 요약도 이 결과를 세게 해서, 화면에
// 없는 노출이 요약 숫자에만 들어가는 일이 없게 한다.
function focusCardPlan(book) {
  const appearances = book.appearances || [];
  const storeBest = (storeId, predicate) =>
    bestAppearanceFor(
      appearances,
      (item) => item.storeId === storeId && predicate(item)
    );

  const isCategoryRealtime = (item) =>
    item.group === "category" && appearancePeriod(item) === "realtime";

  // 카드 전체가 따라갈 분야 하나. 이름 칸도, 분야 실시간 네모도, 분야 바 두
  // 줄도 전부 이 키만 본다.
  const categoryKey = focusCategoryKey(appearances);

  // 첫째 줄: 서점별 종합 실시간.
  const liveBoxes = FOCUS_STORE_COLUMNS.map((store) => ({
    store,
    qualifier: "종합 실시간",
    appearance: storeBest(store.id, (item) => item.group === "overall-realtime")
  }));

  // 둘째 줄: 분야명 + 예스·알라딘 분야 실시간. 첫 칸이 교보가 아닌 이유는
  // 교보가 분야 실시간을 따로 내주지 않기 때문이다 — 그 자리에 이 책이 어느
  // 분야에서 겨루는지를 적어, 옆 두 칸의 숫자가 무슨 분야 순위인지 밝힌다.
  const categoryBoxes = [
    { kind: "name", value: focusCategoryName(appearances, categoryKey) },
    ...["yes24", "aladin"].map((storeId) => {
      const store = FOCUS_STORE_COLUMNS.find((entry) => entry.id === storeId);

      return {
        store,
        qualifier: "분야 실시간",
        appearance: storeBest(
          storeId,
          (item) => isCategoryRealtime(item) && inCategoryKey(item, categoryKey)
        )
      };
    })
  ];

  // 한 칸에 들어갈 수 있는 목록이 둘 이상이면 순위가 좋은 쪽이 이겼다. 그래서
  // 교보 "주간종합순위"는 종합 주간 33위와 온라인 주간 38위 중 33위만 보여
  // 줬고, 온라인 주간을 연 사람에게는 틀린 값이었다. 서버가 그 자리의 주인을
  // primary 로 찍어 주므로, 주인이 있으면 순위와 무관하게 그쪽을 쓴다.
  const rowMatch = (row, item) => {
    if (appearancePeriod(item) !== row.period || item.group !== row.group) {
      return false;
    }

    return row.group === "category" ? inCategoryKey(item, categoryKey) : true;
  };

  const bars = FOCUS_BAR_ROWS.map((row) => ({
    row,
    cells: FOCUS_STORE_COLUMNS.map((store) => {
      const primary = storeBest(
        store.id,
        (item) => rowMatch(row, item) && item.primary
      );

      // 주인 목록이 정해진 자리에서는 그 목록만 본다. 대체하면 줄 이름과
      // 다른 목록의 순위가 나간다 — "주간종합순위 57위"가 실은 교보
      // 온라인 베스트 주간 57위였고, 교보 종합 주간을 열어 본 사람은 그
      // 순위를 찾을 수 없었다. 주인 목록에 없으면 없는 것이 사실이다.
      if (primary || hasPrimaryList(store.id, row)) {
        return { store, appearance: primary };
      }

      return { store, appearance: storeBest(store.id, (item) => rowMatch(row, item)) };
    })
  }));

  const drawn = new Set();
  [...liveBoxes, ...categoryBoxes].forEach(
    (box) => box.appearance && drawn.add(box.appearance)
  );
  bars.forEach((bar) =>
    bar.cells.forEach((cell) => cell.appearance && drawn.add(cell.appearance))
  );

  return { liveBoxes, categoryBoxes, bars, drawn: [...drawn] };
}

// 한 책은 여러 분야에 동시에 오른다. 카드는 그중 하나를 골라 이름을 적고,
// 아래 분야 줄 두 개도 반드시 그 하나를 따라야 한다. 예전에는 이름만 골라 놓고
// 순위는 분야를 가리지 않고 제일 좋은 것을 집어 왔다 — "AI, 신의 탄생 인간의
// 종말" 카드는 분야를 "경제/경영"이라 적고 알라딘 칸에 컴퓨터/모바일 14위를
// 보여 줬다. 알라딘 경제경영 주간에서 그 책은 47위다. 서점과 나란히 놓고 보면
// 그냥 틀린 숫자다. 그래서 여기서 분야 묶음 하나를 정하고, 그 뒤로는 전부
// 그 묶음만 본다.
// 그 (서점·줄) 자리에 주인 목록이 정해져 있는지. 책이 그 목록에 들었는지와는
// 다른 질문이다 — 안 들었으면 "100위 밖"이 맞는 답이고, 다른 목록으로 대체하면
// 줄 이름과 다른 순위가 나간다.
//
// 첫 화면(부트스트랩)에는 목록이 실려 오지 않는다. 그때는 알 수 없으므로
// false 를 돌려 예전처럼 동작하게 두고, 전체 응답이 도착하면 바로잡힌다.
function hasPrimaryList(storeId, row) {
  const sections = (state.dashboard && state.dashboard.sections) || [];

  return sections.some((section) =>
    (section.lists || []).some(
      (list) =>
        list.storeId === storeId &&
        list.primary === true &&
        list.group === row.group &&
        list.period === row.period
    )
  );
}

function focusCategoryKey(appearances) {
  const categories = sortAppearances(
    appearances.filter(
      (item) =>
        item.group === "category" && (item.categoryGroupKeys || []).length > 0
    )
  );

  for (const store of FOCUS_STORE_COLUMNS) {
    const match = categories.find((item) => item.storeId === store.id);

    if (match) {
      return match.categoryGroupKeys[0];
    }
  }

  return "";
}

// 키를 못 정한 경우(= 저장된 스냅샷이 categoryGroupKeys 를 아직 안 담고 있는
// 옛 수집분)에는 거르지 않고 통과시킨다. 여기서 막아 버리면 배포 직후 다음
// 수집이 돌기 전까지 분야 줄이 통째로 "100위 밖"이 된다 — 틀린 분야를 보여
// 주는 것보다 나쁘다.
function inCategoryKey(item, key) {
  if (!key) {
    return true;
  }

  return (item.categoryGroupKeys || []).includes(key);
}

// 분야명은 서점마다 다르게 적는다(경제/경영, 경제 경영, 경제경영). 카드에는
// 칸 순서와 같은 우선순위로 교보 → 예스 → 알라딘 중 먼저 있는 이름을 적는다.
function focusCategoryName(appearances, key) {
  const categories = sortAppearances(
    appearances.filter(
      (item) =>
        item.group === "category" && item.categoryName && inCategoryKey(item, key)
    )
  );

  for (const store of FOCUS_STORE_COLUMNS) {
    const match = categories.find((item) => item.storeId === store.id);

    if (match) {
      return match.categoryName;
    }
  }

  return "";
}

// 순위 타일에 그 서점 색을 얹기 위한 값. 팔레트는 styles.css의 토큰이 원본이고
// 여기서는 그 토큰을 가리키기만 한다 — 색을 두 곳에 적어 두면 갈라진다.
const STORE_ACCENT_VAR = {
  kyobo: "var(--store-kyobo)",
  yes24: "var(--store-yes24)",
  aladin: "var(--store-aladin)"
};

function storeAccentStyle(storeId) {
  const accent = STORE_ACCENT_VAR[storeId];
  return accent ? ` style="--store-accent:${accent}"` : "";
}

// 서점 필터로 감춘 칸과 순위에 없는 칸은 다른 사실이다. 둘을 같은 말로
// 적으면 교보만 골라 본 사람에게 예스24가 순위권 밖이라고 거짓말하게 된다.
function isStoreHidden(storeId) {
  return state.selectedStore !== "all" && state.selectedStore !== storeId;
}

// 카드 맨 위 네모 셋: 서점별 종합 실시간. 지금 이 순간의 순위라 오늘 무슨
// 일이 일어났는지 여기서 먼저 읽힌다.
// 분야명 칸. 교보가 분야 실시간을 따로 내주지 않아 비는 자리에, 옆 두 칸이
// 무슨 분야 순위인지를 적는다.
// 이름표는 "분야" 한 줄뿐이다. 옆 두 칸은 서점 이름 아래 "분야 실시간"이
// 붙어 두 줄이 되므로, 둘째 줄 자리는 styles.css에서 비워 둔 채 남겨 둔다 —
// 그러지 않으면 이 칸의 분야명만 한 줄 위로 올라서 세 칸이 어긋난다.
function renderFocusCategoryNameBox(name) {
  return `
    <div class="focus-live-box is-name${name ? "" : " is-empty"}">
      <span class="focus-live-label"><span class="focus-live-store">분야</span></span>
      <strong>${escapeHtml(name || "분야 없음")}</strong>
    </div>
  `;
}

function renderFocusLiveBox(store, qualifier, appearance) {
  // 이름표는 두 줄로 못 박아 둔다. "알라딘 종합 실시간"을 한 줄에 넣으면
  // 모바일 카드 폭(화면의 88%)에서 말줄임으로 잘리고, 서점마다 줄 수가
  // 달라지면 세 네모의 순위 숫자가 서로 다른 높이에 선다.
  const label = `<span class="focus-live-label"><span class="focus-live-store">${escapeHtml(
    store.label
  )}</span>${escapeHtml(qualifier)}</span>`;
  const accent = storeAccentStyle(store.id);

  if (!appearance) {
    const hidden = isStoreHidden(store.id);

    return `
      <div class="focus-live-box is-empty"${accent}${
        hidden ? ' title="서점 필터에서 이 서점을 빼 둔 상태입니다"' : ""
      }>
        ${label}
        <strong>${hidden ? "필터 제외" : "순위권 밖"}</strong>
      </div>
    `;
  }

  const source = [appearance.storeName, appearance.listName].filter(Boolean).join(" · ");
  const body = `
    ${label}
    <strong>${escapeHtml(appearance.rank)}<span>위</span></strong>
    ${renderRankDelta(appearance)}
  `;
  const href = rankHref(appearance);

  return href
    ? `<a class="focus-live-box"${accent} href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(`${source} ${appearance.rank}위 위치로 이동${deltaHint(appearance)}${rankTimingNote(appearance)}`)}">${body}</a>`
    : `<div class="focus-live-box"${accent}>${body}</div>`;
}

// 바 셀에는 화살표만 남긴다. 열두 칸에 숫자까지 붙이면 카드가 화살표 밭이
// 되므로, 몇 계단인지는 툴팁에 적는다.
function renderCellDelta(appearance) {
  if (appearance.isNew) {
    return `<span class="focus-bar-move is-new">N</span>`;
  }

  if (typeof appearance.rankDelta !== "number" || appearance.rankDelta === 0) {
    return "";
  }

  return appearance.rankDelta > 0
    ? `<span class="focus-bar-move is-up">▲</span>`
    : `<span class="focus-bar-move is-down">▼</span>`;
}

function renderFocusBarCell(store, appearance) {
  if (!appearance) {
    const hidden = isStoreHidden(store.id);

    // 네 줄 모두 서점이 100위까지 내주는 목록이라(RANK_LIMIT=100), 이 칸이
    // 비었다는 건 "100위 밖"이라는 뜻이다. 줄표만 찍어 두면 아직 안 들어온
    // 값인지 순위가 없는 건지 알 수 없었다. 필터로 감춘 칸은 다른 사실이니
    // 그대로 줄표로 남긴다 — 교보만 골라 본 사람에게 예스24가 100위 밖이라고
    // 거짓말하면 안 된다.
    return `<span class="focus-bar-cell is-empty${
      hidden ? "" : " is-out"
    }" title="${escapeHtml(
      hidden ? `${store.label} · 서점 필터에서 빼 둔 상태` : `${store.label} · 100위 안에 없음`
    )}">${hidden ? "–" : "100위 밖"}</span>`;
  }

  const source = [appearance.storeName, appearance.listName].filter(Boolean).join(" · ");
  const body = `${escapeHtml(appearance.rank)}<span>위</span>${renderCellDelta(appearance)}`;
  const href = rankHref(appearance);
  const hint = `${source} ${appearance.rank}위 위치로 이동${deltaHint(appearance)}${rankTimingNote(appearance)}`;

  // 칸을 색으로 채우지는 않지만, 어느 서점 순위인지는 칸마다 밝혀야 한다.
  // 그래서 배경 대신 숫자 자체에 그 서점 색을 입힌다 — 위 네모의 서점 이름과
  // 같은 색이므로 둘이 같은 서점을 가리키는 것으로 읽힌다.
  const accent = storeAccentStyle(store.id);

  return href
    ? `<a class="focus-bar-cell"${accent} href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(hint)}">${body}</a>`
    : `<span class="focus-bar-cell"${accent} title="${escapeHtml(source)}">${body}</span>`;
}

// 네 줄에는 색을 칠하지 않는다. 예전에는 줄 배경에 최고 순위만큼 길이가 차는
// 색 바를 깔고 칸마다 서점색을 얹었는데, 한 카드에 네 줄 × 세 칸이라 카드가
// 색 밭이 되고 정작 읽어야 하는 숫자가 뒤로 밀렸다. 어느 칸이 어느 서점인지는
// 위 네모 줄의 이름표가 열 머리 노릇을 하므로 색 없이도 읽힌다.
function renderFocusBar(bar) {
  const hasAny = bar.cells.some((cell) => cell.appearance);

  return `
    <div class="focus-bar${hasAny ? "" : " is-empty"}">
      <span class="focus-bar-label">${escapeHtml(bar.row.label)}</span>
      <span class="focus-bar-cells">
        ${bar.cells.map((cell) => renderFocusBarCell(cell.store, cell.appearance)).join("")}
      </span>
    </div>
  `;
}

// 직전 수집 대비 이동. 히스토리가 없으면(첫 수집) 아무것도 그리지 않는다.
function renderRankDelta(item) {
  if (item.isNew) {
    return `<span class="rank-delta is-new">NEW</span>`;
  }

  if (typeof item.rankDelta !== "number") {
    return "";
  }

  if (item.rankDelta > 0) {
    return `<span class="rank-delta is-up">▲${escapeHtml(item.rankDelta)}</span>`;
  }

  if (item.rankDelta < 0) {
    return `<span class="rank-delta is-down">▼${escapeHtml(Math.abs(item.rankDelta))}</span>`;
  }

  return `<span class="rank-delta is-flat">—</span>`;
}

// 목록마다 수집 주기가 달라(실시간 60분, 일·주간 6시간) "직전 수집"이 가리키는
// 시각이 다르므로, 툴팁에 실제 기준 시각을 적어 둔다.
function deltaHint(item) {
  const baseline = state.dashboard && state.dashboard.deltaBaselineAt;

  if (!baseline) {
    return "";
  }

  if (item.isNew) {
    return ` · ${formatDateTime(baseline)} 수집에는 없었음`;
  }

  if (typeof item.rankDelta !== "number") {
    return "";
  }

  if (item.rankDelta === 0) {
    return ` · ${formatDateTime(baseline)} 수집과 같은 순위`;
  }

  return ` · ${formatDateTime(baseline)} 수집 ${item.previousRank}위 대비`;
}

// 순위에서 빠진 자리는 칸이 사라져 배지를 붙일 곳이 없으므로 따로 그린다.
// 좋은 소식만 보이고 나쁜 소식이 침묵하는 걸 막는 쪽이 이 화면의 목적에 맞다.
function renderDroppedOut(book) {
  const dropped = visibleDropouts(book);

  if (!dropped.length) {
    return "";
  }

  return dropped
    .map((item) => {
      // "이탈"을 앞에 둔다. 칩은 좁은 화면에서 말줄임되므로 뒤에 두면 하필
      // 뜻을 지닌 단어가 잘려 "88위 → 이..." 로 남는다.
      const label = `이탈 · ${item.storeName} · ${item.listName} · 직전 ${item.previousRank}위`;

      return `<span class="focus-chip is-dropped" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    })
    .join("");
}

// 서점이 밝히는 집계 기준. 우리가 수집한 시각과 다르므로 따로 보여 준다 —
// 실시간 목록도 서점 쪽 기준이 한 시간 전일 수 있다.
// 서점이 밝힌 집계 기준과 우리가 가져온 시각의 차이. 목표는 5분 이내다.
//
// 분 단위로 견줄 수 있는 것은 시각까지 적어 주는 기준뿐이다("2026.09.09 17:00").
// 주간·일간은 기준이 주·날짜 단위라 분으로 잴 것이 없고, 알라딘은 기준 자체를
// 밝히지 않는다. 잴 수 없는 것을 0분이라고 적으면 그게 제일 나쁜 거짓말이므로
// 그런 칸은 왜 못 재는지를 적는다.
const COLLECT_LAG_LIMIT_MINUTES = 5;

function parseStoreStamp(stamp) {
  const m = String(stamp || "").match(/(20\d{2})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})/);

  if (!m) {
    return null;
  }

  // 서점 표기는 한국 시간이다. UTC 로 옮겨서 우리 수집 시각과 같은 축에 둔다.
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]);
}

// 이 칸은 오래 오해를 만들었다. 예전에는 (우리 수집 − 서점 기준)을 통째로 적어서
// 예스24가 88분으로 빨갛게 떴는데, 그건 우리가 늦어서가 아니었다. 예스24는 10:39
// 에도 자기 페이지에 "09:00 기준"이라고 적어 둔다 — 우리가 아무리 자주 가져와도
// 그 차이는 줄지 않는다. 우리 잘못이 아닌 것을 우리 지연으로 적으면, 정작 우리가
// 늦었을 때 그 숫자를 믿지 않게 된다.
//
// 그래서 둘로 나눈다. 서점은 매시 정각에 기준을 갈아 끼우므로, 우리가 가져온
// 순간에 서점이 내주고 있어야 할 기준은 그 직전 정각이다.
//   우리 지연     = 우리 수집 − 직전 정각      (우리가 통제하는 값. 목표 5분)
//   서점 표기 지연 = 직전 정각 − 서점이 적은 기준 (서점이 늦게 올린 값)
// 둘을 더하면 예전에 적던 그 숫자가 된다.
const HOUR_MS = 60 * 60 * 1000;

function renderCollectLag(group) {
  const storeAt = parseStoreStamp(group.sourceStamp);

  if (storeAt === null) {
    return `<span class="cs-lag-na" title="이 순위의 집계 기준은 시각까지 적혀 있지 않아 분 단위로 견줄 수 없습니다">–</span>`;
  }

  const ours = Date.parse(group.collectedAt || "");

  if (!Number.isFinite(ours)) {
    return `<span class="cs-lag-na">–</span>`;
  }

  const due = Math.floor(ours / HOUR_MS) * HOUR_MS;
  const ourLag = Math.max(0, Math.round((ours - due) / 60000));
  const storeLag = Math.max(0, Math.round((due - storeAt) / 60000));
  const over = ourLag > COLLECT_LAG_LIMIT_MINUTES;

  const hint = [
    `우리는 정각으로부터 ${ourLag}분 뒤에 가져왔습니다.`,
    storeLag > 0
      ? `이 서점은 ${storeLag}분 지난 기준(${group.sourceStamp})을 아직 최신으로 내주고 있습니다 — 우리가 더 자주 가져와도 줄지 않는 차이입니다.`
      : "서점이 이 시간대 기준을 이미 올린 뒤에 가져왔습니다."
  ].join(" ");

  const store =
    storeLag > 0
      ? `<span class="cs-lag-store">서점 표기 ${escapeHtml(storeLag)}분 늦음</span>`
      : "";

  return `<span class="cs-lag-value${over ? " is-over" : " is-ok"}" title="${escapeHtml(
    hint
  )}">${escapeHtml(ourLag)}분</span>${store}`;
}

function renderSourceBasis(list) {
  const stamp = list.sourceStamp || "";
  const cadence = list.cadence || "";

  // 알라딘은 어느 페이지에도 집계 기준을 적지 않는다. 비워 두면 위의 "마지막 수집"
  // 시각이 순위 기준으로 읽히므로, 밝히지 않았다는 사실을 그대로 적는다.
  if (!stamp && !cadence) {
    return `<span class="panel-basis is-unknown" title="이 서점은 순위 집계 기준을 페이지에 표기하지 않습니다">서점 기준 미표기</span>`;
  }

  const label = stamp ? `서점 기준 ${stamp}` : `서점 기준 · ${cadence}`;
  const title = [stamp ? `서점이 밝힌 집계 기준: ${stamp}` : "", cadence]
    .filter(Boolean)
    .join(" · ");

  return `<span class="panel-basis" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function formatPublishedDate(value) {
  if (!value) {
    return "출간일 확인 중";
  }

  const text = String(value);

  // 출처가 "2026년 8월"까지만 준 경우는 YYYY-MM으로 온다. 없는 일자를
  // 만들어 붙이지 않고 월까지만 보여 준다.
  if (/^\d{4}-\d{2}$/.test(text)) {
    return `출간 ${text.replace("-", ".")}`;
  }

  return `출간 ${text.replaceAll("-", ".")}`;
}

// 카드를 하나씩 훑지 않아도 이번 수집이 어느 쪽으로 움직였는지 보이게 접는다.
// 세는 단위는 책이 아니라 노출(appearance)이다 — 한 책이 목록마다 따로 움직인다.
// 카드에 실제로 그려지는 것만 센다. 화면 배지보다 큰 숫자를 적으면 요약이 방해가 된다.
function summarizeFocusDeltas(books) {
  const summary = { up: 0, down: 0, entered: 0, dropped: 0 };

  books.forEach((book) => {
    focusCardPlan(book).drawn.forEach((item) => {
      if (item.isNew) {
        summary.entered += 1;
      }

      if (typeof item.rankDelta !== "number") {
        return;
      }

      if (item.rankDelta > 0) {
        summary.up += 1;
      } else if (item.rankDelta < 0) {
        summary.down += 1;
      }
    });

    summary.dropped += visibleDropouts(book).length;
  });

  return summary;
}

function renderFocusDeltaSummary(books) {
  // 비교할 직전 수집이 없으면(첫 수집) 0을 늘어놓지 않고 줄 자체를 뺀다.
  if (!(state.dashboard && state.dashboard.deltaBaselineAt)) {
    return "";
  }

  const summary = summarizeFocusDeltas(books);
  // 0인 항목은 적지 않는다. "상승 0"은 읽는 사람에게 아무것도 알려 주지 않는다.
  // 단위는 "곳"이다 — 옆에 "N종 추적"이 붙어 있어 안 적으면 책 수로 읽힌다.
  const parts = [
    ["상승", summary.up],
    ["하락", summary.down],
    ["신규", summary.entered],
    ["이탈", summary.dropped]
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${escapeHtml(count)}곳`);

  return `<p class="focus-delta-summary">${parts.length ? parts.join(" · ") : "변화 없음"}</p>`;
}

function renderFocusBoardV2() {
  const focusBooks = getVisibleFocusBooks();

  return `
    <section class="focus-board section-block focus-board-priority" id="focus-books">
      <div class="section-heading">
        <div>
          <div class="section-label">Sangsang Square</div>
          <h2>상상스퀘어 도서 순위</h2>
          ${renderFocusDeltaSummary(focusBooks)}
        </div>
        <span class="section-count">${
          state.search
            ? `검색 결과 ${escapeHtml(focusBooks.length)}종`
            : `${escapeHtml(focusBooks.length)}종 추적`
        }</span>
      </div>
      ${!focusBooks.length && state.search
        ? '<div class="panel-empty">검색어와 일치하는 상상스퀘어 도서가 없습니다.</div>'
        : ""}
      <div class="focus-grid">
        ${focusBooks
          .map((book) => {
            const appearances = book.appearances || [];
            const plan = focusCardPlan(book);

            // 제목은 그 책 교보문고 상품 페이지로 보낸다. 한때 순위 페이지로
            // 돌렸었는데(카드 안에서 목적지를 하나로 맞추려고), 제목을 누르는
            // 사람이 찾는 것은 순위 안의 위치가 아니라 그 책이다. 순위로 가는
            // 길은 숫자 칸과 바가 이미 전부 맡고 있다.
            //
            // book.link 는 서버가 이 클릭을 위해 만든 값이다 — 카탈로그에서 얻은
            // 교보 링크가 1순위, 없으면 교보 순위에서 얻은 링크, 그다음이 다른
            // 서점이다.
            const titleHref = book.link || "";
            const titleHint = `${book.title} 교보문고 상품 페이지 열기`;

            const droppedOut = renderDroppedOut(book);
            // 이번 수집에 없고 직전에는 있었다면 "진입 대기"가 아니라 이탈이다.
            const statusLabel = appearances.length
              ? "순위 확인"
              : droppedOut
                ? "순위 이탈"
                : "진입 대기";

            return `
              <article class="focus-card${book.pinned ? " is-pinned" : ""}">
                <div class="focus-head">
                  <div class="focus-title-row">
                    <h3 class="focus-title">
                      ${titleHref
                        ? `<a href="${escapeHtml(titleHref)}" target="_blank" rel="noreferrer" title="${escapeHtml(titleHint)}">${escapeHtml(book.title)}</a>`
                        : escapeHtml(book.title)}
                    </h3>
                    ${book.pinned
                      ? `<span class="focus-pin" title="첫 화면 맨 앞에 고정해 둔 도서입니다">주요 도서</span>`
                      : ""}
                  </div>
                  <p class="focus-published">${escapeHtml(formatPublishedDate(book.latestPublishedAt))}</p>
                </div>
                <div class="focus-live-row">
                  ${plan.liveBoxes
                    .map((box) => renderFocusLiveBox(box.store, box.qualifier, box.appearance))
                    .join("")}
                </div>
                <div class="focus-live-row">
                  ${plan.categoryBoxes
                    .map((box) =>
                      box.kind === "name"
                        ? renderFocusCategoryNameBox(box.value)
                        : renderFocusLiveBox(box.store, box.qualifier, box.appearance)
                    )
                    .join("")}
                </div>
                <div class="focus-bar-list">
                  ${plan.bars.map((bar) => renderFocusBar(bar)).join("")}
                </div>
                <div class="focus-card-foot">
                  <span class="focus-status ${appearances.length ? "active" : ""}${
                    !appearances.length && droppedOut ? " dropped" : ""
                  }">
                    ${statusLabel}
                  </span>
                </div>
                ${droppedOut ? `<div class="focus-appearances">${droppedOut}</div>` : ""}
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

// 모바일에서 서점 사이를 옆으로 넘겨 보는 자리의 이름표다. 손가락으로 밀어도
// 되고 여기를 눌러도 된다 — 누르면 그 서점 자리로 미끄러진다. 화면을 다시 그리지
// 않고 스크롤만 옮기므로, 보고 있던 순위 구간이 그대로 남는다.
// 이름표는 칸 순서로 가리킨다. 서점 id로 찾으면 주간 화면이 어긋난다 —
// 거기서는 교보 목록이 둘(종합 주간, 온라인 주간)이라 같은 id가 두 번 나온다.
// 그때는 이름도 서점명 대신 목록을 가르는 말로 바꾼다.
function swipeLabel(list, lists) {
  const sameStore = lists.filter((other) => other.storeId === list.storeId);

  if (sameStore.length < 2) {
    return list.storeName;
  }

  // 서점명을 그대로 두고 가르는 말을 뒤에 붙인다 — "교보문고 종합", "교보문고 온라인".
  // 가르는 말만 남기면 짧기는 한데, 그 둘이 어느 서점 것인지가 이름표에서 사라진다.
  const distinct = String(list.name || "").trim().split(/\s+/)[0];

  return distinct ? `${list.storeName} ${distinct}` : list.storeName;
}

function renderSwipeSwitcher(lists, label) {
  if (lists.length < 2) {
    return "";
  }

  return `
    <div class="store-switcher swipe-switcher" aria-label="${escapeHtml(label)}">
      ${lists
        .map(
          (list, index) => `
            <button
              type="button"
              class="store-switcher-button ${index === 0 ? "active" : ""}"
              data-swipe-index="${index}"
              aria-pressed="${index === 0 ? "true" : "false"}"
              style="--switch-accent:${escapeHtml(list.accent)}"
            >
              ${escapeHtml(swipeLabel(list, lists))}
              ${list.typeLabel ? `<span>${escapeHtml(list.typeLabel)}</span>` : ""}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderStoreSwitcher(
  lists,
  selectedStore,
  dataAttribute,
  label,
  getSubLabel = () => "TOP 100"
) {
  return `
    <div class="store-switcher" aria-label="${escapeHtml(label)}">
      ${lists
        .map(
          (list) => `
            <button
              type="button"
              class="store-switcher-button ${selectedStore === list.storeId ? "active" : ""}"
              ${dataAttribute}="${escapeHtml(list.storeId)}"
              aria-pressed="${selectedStore === list.storeId ? "true" : "false"}"
              style="--switch-accent:${escapeHtml(list.accent)}"
            >
              ${escapeHtml(list.storeName)}
              <span>${escapeHtml(getSubLabel(list))}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderRealtimeBoard(lists) {
  if (!lists.length) {
    return "";
  }

  const totalCollected = lists.reduce((sum, list) => sum + (list.itemCount || 0), 0);

  return `
    <section class="section-block realtime-board" id="realtime-rankings">
      <div class="section-heading realtime-heading">
        <div>
          <div class="section-label live-label"><span aria-hidden="true"></span> Live now</div>
          <h2>전체 실시간 TOP 100</h2>
          <p>가장 자주 보는 순위입니다. 20위 단위로 빠르게 이동할 수 있습니다.</p>
        </div>
        <div class="realtime-total">
          <strong>${escapeHtml(totalCollected)}</strong>
          <span>권 수집</span>
        </div>
      </div>
      ${renderSwipeSwitcher(lists, "실시간 서점 넘겨 보기")}
      <div class="realtime-grid">
        ${lists
          .map(
            (list) => `
              <div class="realtime-store-card" data-store-id="${escapeHtml(list.storeId)}">
                ${renderCard(list)}
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderCategoryPeriodSwitcher(lists, accent) {
  const available = CATEGORY_PERIODS.filter((period) =>
    lists.some((list) => list.period === period.key)
  );

  const accentStyle = accent ? ` style="--switch-accent:${escapeHtml(accent)}"` : "";

  return `
    <div class="category-period-switcher" aria-label="분야별 순위 기간 선택"${accentStyle}>
      ${available
        .map(
          (period) => `
            <button
              type="button"
              class="category-period-button ${state.categoryPeriod === period.key ? "active" : ""}"
              data-category-period="${escapeHtml(period.key)}"
              aria-pressed="${state.categoryPeriod === period.key ? "true" : "false"}"
            >
              ${escapeHtml(period.label)}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

// 분야별 항목은 대시보드 응답에 없다(서점 전체 분야를 담으면 10MB를 넘겨 CDN 캐시가
// 꺼진다). 지금 보고 있는 분야 세 개만 /api/list 로 받아 두고 재사용한다.
const loadedLists = new Map();
// 분야+기간 단위로 받는다. 같은 주소를 두 번 부르지 않기 위한 표시.
const loadingGroups = new Set();
const failedGroups = new Map();

// 캐시에 얹히느냐가 전부다 — CDN MISS는 1.2~1.4초, HIT는 13~31ms다.
// 그래서 주소를 분야+기간으로 고정한다. 34분야 × 3기간 = 102개뿐이라
// 누군가 한 번 열면 그 뒤로는 모두가 캐시를 쓴다.
function requestGroup(groupKey, period) {
  const token = `${groupKey}:${period}`;

  if (loadingGroups.has(token)) {
    return;
  }

  loadingGroups.add(token);

  fetch(`/api/list?group=${encodeURIComponent(groupKey)}&period=${encodeURIComponent(period)}`)
    .then((response) => response.json())
    .then((payload) => {
      for (const list of payload.lists || []) {
        if (list && list.id) {
          loadedLists.set(list.id, list);
        }
      }
    })
    .catch((error) => {
      // 표시를 지우면 다시 그리기 → 다시 요청 → 또 실패로 맴돈다.
      // 실패한 목록에 오류를 심어 두고 그 자리에 사유가 보이게 한다.
      failedGroups.set(token, `목록을 불러오지 못했습니다. ${error.message}`);
    })
    .finally(() => {
      renderDashboard();
    });
}

function withLoadedItems(list) {
  if (!list.itemsDeferred) {
    return list;
  }

  const loaded = loadedLists.get(list.id);

  if (!loaded) {
    const groupKey = (list.groupKeys || [])[0] || "";
    const failure = failedGroups.get(`${groupKey}:${list.period}`);

    if (failure) {
      return { ...list, error: failure };
    }

    return { ...list, pendingItems: true };
  }

  return { ...list, items: loaded.items || [], error: loaded.error || list.error };
}

function categoryGroupsWithLists(lists) {
  const groups = (state.dashboard && state.dashboard.categoryGroups) || [];
  const available = new Set();

  for (const list of lists) {
    for (const key of list.groupKeys || []) {
      available.add(key);
    }
  }

  return groups.filter((group) => available.has(group.key));
}

// 실시간·일간·주간 화면과 같은 구성으로 그린다. 분야를 하나 고르면 그 분야의
// 세 서점 순위가 나란히 선다 — 서점을 바꿔 가며 볼 필요가 없다.
// 한 서점에만 있는 분야는 그 서점 칸만 선다(예: 알라딘 장르소설).
function renderCategoryBoard(lists) {
  if (!lists.length) {
    return `
      <section class="section-block category-board" id="category-rankings">
        <div class="section-heading">
          <div>
            <div class="section-label">Categories</div>
            <h2>분야별 순위</h2>
            <p>분야별 순위는 교보문고, 예스24, 알라딘에서 볼 수 있습니다.</p>
          </div>
        </div>
        <div class="section-empty">상단에서 서점을 선택하면 분야별 순위를 볼 수 있습니다.</div>
      </section>
    `;
  }

  const groups = categoryGroupsWithLists(lists);

  if (!groups.length) {
    return "";
  }

  if (!groups.some((group) => group.key === state.categoryGroup)) {
    state.categoryGroup = groups[0].key;
  }

  const groupLists = lists.filter((list) =>
    (list.groupKeys || []).includes(state.categoryGroup)
  );

  // 교보는 분야별 실시간을 제공하지 않아 그 칸은 세우지 않는다(아래 참고).
  // 기간 목록도 이걸 반영해야 한다 — 교보에만 있는 분야(한국소개도서)는
  // 실시간을 남겨 두면 칸이 하나도 없는 화면이 된다.
  const shownLists = groupLists.filter(
    (list) => !(list.storeId === "kyobo" && list.realtime)
  );

  // 기간은 이 분야에 실제로 있는 것만 고른다. 서점이 안 내주는 조합이 있어서
  // (알라딘 장르소설 실시간처럼) 전체 기준으로 고르면 빈 화면이 된다.
  const periods = CATEGORY_PERIODS.filter((period) =>
    shownLists.some((list) => list.period === period.key)
  );

  if (!periods.length) {
    return "";
  }

  if (!periods.some((period) => period.key === state.categoryPeriod)) {
    state.categoryPeriod = periods[0].key;
  }

  // 교보는 분야별 실시간을 제공하지 않는다. 우리가 종합 실시간 100위를 분야로
  // 쪼개 만든 목록이라, 클릭하면 갈 수 있는 곳이 종합 실시간 페이지뿐이다 —
  // 분야 페이지로는 갈 수가 없고(/realtime/domestic/13 은 404) 그 페이지에서
  // 그 책을 찾는 데 3.4~4.9초가 걸리며, 순위가 흔들리면 아예 없기도 하다.
  // 옆 두 서점은 각자 분야 페이지로 정확히 가므로, 교보만 어긋난 칸이 된다.
  // 그래서 실시간에서는 교보 칸을 세우지 않고 이유를 밝힌다.
  // 일간·주간은 교보도 분야 페이지가 있어 그대로 세 칸이 선다.
  const hiddenStores = groupLists.filter(
    (list) => list.period === state.categoryPeriod && list.storeId === "kyobo" && list.realtime
  );

  const activeLists = sortByStoreOrder(
    shownLists.filter((list) => list.period === state.categoryPeriod)
  ).map(withLoadedItems);

  // 지금 분야를 받아 두고, 좌우 이웃도 한가할 때 미리 당긴다.
  // 분야는 좌우로 훑어 보는 자리라 다음에 누를 것이 대개 옆에 있다.
  if (activeLists.some((list) => list.pendingItems)) {
    requestGroup(state.categoryGroup, state.categoryPeriod);
  } else {
    const idle = window.requestIdleCallback || ((fn) => window.setTimeout(fn, 300));
    const groupIndex = groups.findIndex((group) => group.key === state.categoryGroup);
    const neighbours = [1, -1, 2, -2]
      .map((offset) => groups[groupIndex + offset])
      .filter(Boolean);

    idle(() => {
      for (const group of neighbours) {
        requestGroup(group.key, state.categoryPeriod);
      }
    });
  }

  const activeGroup = groups.find((group) => group.key === state.categoryGroup);
  const totalCollected = activeLists.reduce((sum, list) => sum + (list.itemCount || 0), 0);
  const storeNote = hiddenStores.length
    ? "교보문고는 분야별 실시간 순위를 제공하지 않아 일간·주간에서만 볼 수 있습니다."
    : activeLists.length < 3
      ? `이 분야는 ${activeLists.map((list) => list.storeName).join("·")}에만 있습니다.`
      : "";

  return `
    <section class="section-block category-board" id="category-rankings">
      <div class="section-heading">
        <div>
          <div class="section-label">Categories</div>
          <h2>분야별 순위</h2>
          <p>분야를 고르면 세 서점 순위가 나란히 섭니다.${storeNote ? " " + escapeHtml(storeNote) : ""}</p>
        </div>
        <div class="realtime-total">
          <strong>${escapeHtml(totalCollected)}</strong>
          <span>권 수집</span>
        </div>
      </div>
      ${renderCategoryPeriodSwitcher(shownLists, activeLists[0] && activeLists[0].accent)}
      <div class="category-selector" aria-label="분야 선택">
        ${groups
          .map(
            (group) => `
              <button
                type="button"
                class="category-selector-button ${group.key === state.categoryGroup ? "active" : ""}"
                data-category-group="${escapeHtml(group.key)}"
                aria-pressed="${group.key === state.categoryGroup ? "true" : "false"}"
              >
                ${escapeHtml(group.label)}
              </button>
            `
          )
          .join("")}
      </div>
      ${renderSwipeSwitcher(activeLists, "분야별 서점 넘겨 보기")}
      <div class="standard-grid">
        ${activeLists.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function sortByStoreOrder(lists) {
  return [...lists].sort(
    (a, b) =>
      STORE_ALERT_ORDER.indexOf(a.storeId) - STORE_ALERT_ORDER.indexOf(b.storeId)
  );
}

function renderOverallPeriodBoard(lists, options) {
  if (!lists.length) {
    return "";
  }

  const { id, label, title, description, extraLists = [], extraTitle = "" } = options;
  const totalCollected = [...lists, ...extraLists].reduce(
    (sum, list) => sum + (list.itemCount || 0),
    0
  );

  return `
    <section class="section-block standard-board" id="${escapeHtml(id)}">
      <div class="section-heading">
        <div>
          <div class="section-label">${escapeHtml(label)}</div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="realtime-total">
          <strong>${escapeHtml(totalCollected)}</strong>
          <span>권 수집</span>
        </div>
      </div>
      ${renderSwipeSwitcher(sortByStoreOrder(lists), `${title} 서점 넘겨 보기`)}
      <div class="standard-grid">
        ${sortByStoreOrder(lists).map(renderCard).join("")}
      </div>
      ${extraLists.length
        ? `
          <div class="board-subheading">${escapeHtml(extraTitle)}</div>
          ${renderSwipeSwitcher(sortByStoreOrder(extraLists), `${extraTitle} 서점 넘겨 보기`)}
          <div class="standard-grid">
            ${sortByStoreOrder(extraLists).map(renderCard).join("")}
          </div>
        `
        : ""}
    </section>
  `;
}

function renderDashboardSections(visibleSections) {
  const lists = flattenLists(visibleSections);
  const standardLists = lists.filter((list) => list.group === "standard" || !list.group);
  const byPeriod = (period) => standardLists.filter((list) => list.period === period);

  const views = {
    focus: () => renderFocusBoardV2(),
    realtime: () =>
      renderRealtimeBoard(lists.filter((list) => list.group === "overall-realtime")),
    category: () => renderCategoryBoard(lists.filter((list) => list.group === "category")),
    daily: () =>
      renderOverallPeriodBoard(byPeriod("daily"), {
        id: "daily-rankings",
        label: "Daily",
        title: "전체 서점 일간 순위",
        description: "서점 3곳의 일간 베스트를 100위까지 나란히 봅니다."
      }),
    weekly: () =>
      renderOverallPeriodBoard(byPeriod("weekly"), {
        id: "weekly-rankings",
        label: "Weekly",
        title: "전체 서점 주간 순위",
        description: "서점 3곳의 주간 베스트를 100위까지 나란히 봅니다.",
        extraLists: byPeriod("monthly"),
        extraTitle: "월간 베스트"
      })
  };

  return `
    <div class="dashboard-stack">
      ${(views[state.activeView] || views.focus)()}
    </div>
  `;
}

function updateSummary() {
  if (!state.dashboard) {
    elements.summaryText.textContent = "데이터를 준비하고 있습니다.";
    return;
  }

  const visibleLists = flattenLists(getVisibleSections(state.dashboard.sections));
  const totalBooks = visibleLists.reduce((sum, list) => sum + list.itemCount, 0);
  const viewLabel = VIEW_LABELS[state.activeView] || "";
  const searchSuffix = state.search
    ? ` 현재 검색어: "${elements.searchInput.value.trim()}"`
    : "";

  elements.summaryText.textContent =
    `${viewLabel} 화면입니다. 수집된 도서는 모두 ${totalBooks}권입니다.${searchSuffix}`;
}

function syncViewNav() {
  elements.viewNav?.querySelectorAll("[data-view]").forEach((button) => {
    if (button.dataset.view === state.activeView) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

// 시각만 짧게. 날짜가 오늘이 아니면 날짜까지 붙인다 — 일간·주간은 어제 것을 보고
// 있을 수 있어서, "09:09"만 적으면 오늘 아침으로 읽힌다.
function formatClock(value) {
  if (!value) {
    return "";
  }

  const at = new Date(value);

  if (Number.isNaN(at.getTime())) {
    return "";
  }

  const sameDay = at.toDateString() === new Date().toDateString();

  return new Intl.DateTimeFormat("ko-KR", {
    ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit"
  }).format(at);
}

// 상단에 우리 갱신 주기만 적혀 있으면 그 숫자가 순위의 기준인지 우리가 긁은 시각인지
// 구분되지 않는다. 서점이 밝힌 기준 시점을 먼저 보여 주고, 우리 수집 시각은 그 뒤에
// 부차적으로 적는다 — 사용자가 알고 싶은 것은 "이 순위가 언제 것이냐"다.
function renderStoreStatus() {
  const stores = (state.dashboard && state.dashboard.storeStatus) || [];

  if (!elements.collectStatus) {
    return;
  }

  if (!stores.length) {
    elements.collectStatus.innerHTML = "";
    return;
  }

  const cards = stores
    .map((store) => {
      const rows = store.groups
        .map((group) => {
          const basis = group.sourceStamp
            ? `<strong class="cs-basis">${escapeHtml(group.sourceStamp)}</strong>`
            : `<strong class="cs-basis cs-basis-unknown">서점 미표기</strong>`;
          const cadence = group.cadence
            ? `<span class="cs-cadence">${escapeHtml(group.cadence)}</span>`
            : "";
          const collected = formatClock(group.collectedAt);
          const next = formatClock(group.nextRefreshAt);
          const flag = group.error
            ? '<span class="cs-flag cs-flag-error">수집 실패</span>'
            : group.stale
              ? '<span class="cs-flag cs-flag-stale">이전 값</span>'
              : "";

          return `
            <tr>
              <th scope="row">${escapeHtml(group.label)}${flag}</th>
              <td class="cs-basis-cell">${basis}${cadence}</td>
              <td class="cs-collected">
                <span>${escapeHtml(collected || "-")}</span>
                ${next ? `<span class="cs-next">다음 ${escapeHtml(next)}</span>` : ""}
              </td>
              <td class="cs-lag">${renderCollectLag(group)}</td>
            </tr>
          `;
        })
        .join("");

      return `
        <article class="cs-card" style="--store-accent:${escapeHtml(store.accent || "#111111")}">
          <h2 class="cs-store">${escapeHtml(store.storeName)}</h2>
          <table class="cs-table">
            <thead>
              <tr>
                <th scope="col">구분</th>
                <th scope="col">서점이 밝힌 순위 기준</th>
                <th scope="col">우리 수집</th>
                <th scope="col">우리 지연</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </article>
      `;
    })
    .join("");

  // 표 3장은 데스크톱에선 한눈에 들어오지만 모바일에선 첫 화면을 통째로 먹는다.
  // 좁은 화면에서는 접어 두고, 넓은 화면에서는 펼친 채로 둔다.
  // 사용자가 직접 여닫으면 그 선택을 갱신 후에도 유지한다.
  const open = state.collectStatusOpen === null ? !isNarrowScreen() : state.collectStatusOpen;

  elements.collectStatus.innerHTML = `
    <details class="cs-box"${open ? " open" : ""}>
      <summary class="cs-summary">
        <span class="cs-summary-title">데이터 수집 시점</span>
        <span class="cs-summary-hint">서점 3곳 기준 보기</span>
      </summary>
      <p class="cs-lede">
        <strong>서점이 밝힌 순위 기준</strong>은 서점이 그 순위를 언제 기준으로 집계했는지,
        <strong>우리 수집</strong>은 우리가 그것을 언제 가져왔는지입니다.
        실시간 순위는 매시 정각에 갈리므로 우리도 <strong>매시 정각 직후에 가져옵니다</strong>.
        <strong>우리 지연</strong>은 정각으로부터 몇 분 뒤에 가져왔는지입니다.
        서점이 지난 시간 기준을 아직 최신으로 내주고 있으면 그 사실은 따로 적습니다 —
        그건 우리가 더 자주 가져와도 줄지 않는 차이입니다.
      </p>
      ${renderSwipeSwitcher(stores, "수집 시점 서점 넘겨 보기")}
      <div class="cs-grid">${cards}</div>
    </details>
  `;

  const box = elements.collectStatus.querySelector(".cs-box");

  if (box) {
    box.addEventListener("toggle", () => {
      state.collectStatusOpen = box.open;
      // 접혀 있는 동안에는 폭이 0이라 어느 칸을 보고 있는지 잴 수 없다.
      // 펼치는 순간 다시 맞춘다.
      wireSwipeTracks(elements.collectStatus);
    });
  }

  wireSwipeTracks(elements.collectStatus);
}

function renderDashboard() {
  if (!state.dashboard) {
    elements.dashboard.innerHTML = '<div class="panel-empty">데이터를 불러오고 있습니다.</div>';
    return;
  }

  const visibleSections = getVisibleSections(state.dashboard.sections);

  elements.generatedAt.textContent = formatDateTime(state.dashboard.generatedAt);
  renderStoreStatus();
  renderStoreFilters(state.dashboard.sections);
  elements.dashboard.innerHTML = renderDashboardSections(visibleSections);
  wireSwipeTracks();
  updateSummary();
}

// 넘기는 것 자체는 브라우저가 한다(styles.css의 scroll-snap). 여기서는 지금 어느
// 서점을 보고 있는지 이름표에 표시만 맞춘다. 화면을 다시 그리면 요소가 통째로
// 바뀌므로 그릴 때마다 다시 건다.
function wireSwipeTracks(root = elements.dashboard) {
  if (!root) {
    return;
  }

  root
    .querySelectorAll(".realtime-grid, .standard-grid, .focus-grid, .cs-grid")
    .forEach((track) => {
      const switcher = findSwipeSwitcher(track);
      // 상상스퀘어는 칸이 스무 개가 넘어 이름표를 달 수 없다. 대신 몇 번째를
      // 보고 있는지 머리글의 "N종 추적" 자리에 적는다.
      const counter = track.classList.contains("focus-grid")
        ? track.parentElement && track.parentElement.querySelector(".section-count")
        : null;

      if (!switcher && !counter) {
        return;
      }

      const idleLabel = counter ? counter.textContent.trim() : "";

      const sync = (moved) => {
        // 가로로 못 넘기는 화면(데스크톱)에서는 손댈 것이 없다.
        if (track.scrollWidth <= track.clientWidth + 1) {
          if (counter) {
            counter.textContent = idleLabel;
          }
          return;
        }

        const index = nearestPanelIndex(track);

        // 넘기기 전에는 머리글이 제 할 말을 하게 둔다("28종 추적", "검색 결과 3종").
        // 몇 번째인지는 실제로 넘기기 시작한 다음부터 쓸모가 있다.
        if (counter && !moved) {
          counter.textContent = idleLabel;
        }

        if (switcher) {
          switcher.querySelectorAll("[data-swipe-index]").forEach((button, i) => {
            const active = i === index;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
          });
        }

        if (counter && moved) {
          counter.textContent = `${index + 1} / ${track.children.length}`;
        }
      };

      // 접었다 펼 때 같은 요소에 다시 걸릴 수 있다. 스크롤 감시는 한 번만 건다.
      if (track.dataset.swipeWired !== "1") {
        track.dataset.swipeWired = "1";

        // 스크롤은 손가락 하나에 수십 번 뜬다. 멈춘 뒤에 한 번만 맞춘다.
        let timer = null;
        track.addEventListener(
          "scroll",
          () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => sync(true), 90);
          },
          { passive: true }
        );
      }

      sync(false);
    });
}

// 서점 이름표를 누르면 그 자리로 미끄러진다. 다시 그리지 않으므로 보고 있던
// 순위 구간(21~40위 같은)이 그대로 남는다. 수집 시점 표는 #dashboard 바깥에
// 있어서, 같은 처리를 두 곳에 걸어 준다.
function handleSwipeButtonClick(event) {
  const button = event.target.closest("[data-swipe-index]");

  if (!button) {
    return false;
  }

  const switcher = button.closest(".swipe-switcher");
  const track = switcher && switcher.nextElementSibling;
  const panel = track && track.children[Number(button.dataset.swipeIndex)];

  if (panel) {
    track.scrollTo({ left: panel.offsetLeft, behavior: "smooth" });
  }

  return true;
}

function nearestPanelIndex(track) {
  const panels = [...track.children];

  return panels.reduce(
    (best, panel, i) =>
      Math.abs(panel.offsetLeft - track.scrollLeft) <
      Math.abs(panels[best].offsetLeft - track.scrollLeft)
        ? i
        : best,
    0
  );
}

function findSwipeSwitcher(track) {
  let node = track.previousElementSibling;

  while (node) {
    if (node.classList && node.classList.contains("swipe-switcher")) {
      return node;
    }
    // 월간 구역처럼 사이에 소제목이 끼는 경우가 있다. 이름표를 지나 다른 목록에
    // 닿으면 그 위는 남의 것이므로 멈춘다.
    if (node.classList && (node.classList.contains("standard-grid") || node.classList.contains("realtime-grid"))) {
      return null;
    }
    node = node.previousElementSibling;
  }

  return null;
}

function setLoading(loading) {
  state.loading = loading;
  elements.dashboard.setAttribute("aria-busy", loading ? "true" : "false");

  if (loading) {
    elements.summaryText.textContent = "데이터를 새로 수집하는 중입니다.";
    clearBadgeResetTimer();
    setAutoRefreshBadge(
      state.hasLoadedOnce ? "자동 갱신 · 업데이트 중" : "데이터를 불러오는 중",
      "loading"
    );
  }
}

async function loadDashboard(refresh = "") {
  const query = refresh ? `?refresh=${encodeURIComponent(refresh)}` : "";

  try {
    setLoading(true);
    const response = await fetch(`/api/dashboard${query}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();

    // 화면을 켜둔 채 프런트엔드 파일이 바뀌면 예전 코드로 새 데이터를 그리게 되므로,
    // 버전이 달라진 순간 한 번 새로고침한다.
    if (
      state.assetVersion &&
      payload.assetVersion &&
      payload.assetVersion !== state.assetVersion
    ) {
      window.location.reload();
      return;
    }

    state.assetVersion = payload.assetVersion || "";
    state.dashboard = payload;
    renderDashboard();
    scheduleDashboardRefresh();
    if (state.hasLoadedOnce) {
      showUpdatedBadge();
    } else {
      state.hasLoadedOnce = true;
      showIdleBadge();
    }
  } catch (error) {
    elements.dashboard.innerHTML =
      `<div class="panel-empty">대시보드를 불러오지 못했습니다.<br>${escapeHtml(error.message)}</div>`;
    elements.generatedAt.textContent = "불러오기 실패";
    elements.summaryText.textContent = "서버 응답을 확인해 주세요.";
    setAutoRefreshBadge("자동 갱신 상태를 확인해 주세요", "error");
  } finally {
    setLoading(false);
  }
}

// 화면을 열어 둔 동안에도 값이 따라가야 한다. 예전에는 목록의 nextRefreshAt
// (수집 시각 + 캐시 수명)에서 가장 이른 것을 기다렸는데, 실시간 캐시 수명이
// 60분이라 화면은 한 시간에 한 번만 다시 받았다. 수집은 5분마다 하고 있었으니
// 화면 숫자가 최대 한 시간 뒤처졌고, 그 숫자를 누르면 서점은 그동안 바뀐 지금
// 순위를 보여 줬다 — "클릭하면 다르게 나온다"의 원인이 이것이다.
//
// 그래서 캐시 수명이 아니라 실제 수집 주기를 따른다.
function scheduleDashboardRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (!state.dashboard) {
    return;
  }

  const delay = Math.max(collectIntervalMs(), 60_000);

  state.refreshTimer = window.setTimeout(() => {
    loadDashboard();
  }, delay);
}

function collectIntervalMs() {
  const intervals = (state.dashboard && state.dashboard.collectIntervals) || {};

  return (Number(intervals.realtimeMinutes) || 5) * 60_000;
}

// 탭을 다른 데 두고 있으면 브라우저가 타이머를 늦추거나 멈춘다. 돌아왔을 때
// 화면이 묵었으면 기다리지 않고 바로 받는다 — 열어 둔 채 한참 뒤에 순위를
// 누르는 경우가 실제로 어긋남을 만들던 자리다.
function watchTabReturn() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.dashboard) {
      return;
    }

    const age = Date.now() - Date.parse(state.dashboard.generatedAt || "");

    if (!Number.isFinite(age) || age >= collectIntervalMs()) {
      loadDashboard();
    }
  });
}

function bindEvents() {
  elements.viewNav?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (!button || button.dataset.view === state.activeView) {
      return;
    }

    state.activeView = button.dataset.view;
    syncViewNav();
    renderDashboard();
    // 화면을 갈아끼우는 것이므로 스크롤은 애니메이션 없이 맨 위로 돌려놓는다.
    window.scrollTo({ top: 0, behavior: "instant" });
  });

  elements.searchInput.addEventListener("input", () => {
    state.search = elements.searchInput.value.trim().toLowerCase();
    renderDashboard();
  });

  elements.collectStatus?.addEventListener("click", (event) => {
    if (handleSwipeButtonClick(event)) {
      // 이름표는 <summary> 밖이지만, 눌렀을 때 표가 접히지 않게 막아 둔다.
      event.preventDefault();
    }
  });

  elements.storeFilters.addEventListener("click", (event) => {
    const target = event.target.closest("[data-store-filter]");
    if (!target) {
      return;
    }

    state.selectedStore = target.dataset.storeFilter;
    renderDashboard();
  });

  elements.dashboard.addEventListener("click", (event) => {
    const rankPageButton = event.target.closest("[data-rank-page]");
    if (rankPageButton) {
      state.rankPages[rankPageButton.dataset.listId] = Number(
        rankPageButton.dataset.rankPage
      );
      renderDashboard();
      return;
    }

    if (handleSwipeButtonClick(event)) {
      return;
    }

    const categoryPeriodButton = event.target.closest("[data-category-period]");
    if (categoryPeriodButton) {
      state.categoryPeriod = categoryPeriodButton.dataset.categoryPeriod;
      renderDashboard();
      return;
    }

    // 분야는 서점별 목록이 아니라 서점을 가로지르는 묶음으로 고른다.
    const categoryGroupButton = event.target.closest("[data-category-group]");
    if (categoryGroupButton) {
      state.categoryGroup = categoryGroupButton.dataset.categoryGroup;
      renderDashboard();
      return;
    }
  });
}

function removeAddressHash() {
  if (!window.location.hash) {
    return;
  }

  window.history.replaceState(
    null,
    document.title,
    `${window.location.pathname}${window.location.search}`
  );
}

removeAddressHash();
window.addEventListener("hashchange", removeAddressHash);
watchTabReturn();
bindEvents();
showIdleBadge();
// 서버가 첫 화면 데이터를 HTML에 실어 보낸다(window.__BOOTSTRAP__).
// 있으면 그걸로 곧바로 그리고, 나머지 탭에 필요한 전체 데이터는 뒤에서 받는다.
// 없으면(저장이 아직 없거나 실패) 예전처럼 API부터 기다린다.
function start() {
  const bootstrap = window.__BOOTSTRAP__;

  if (bootstrap && Array.isArray(bootstrap.focusBooks)) {
    state.dashboard = bootstrap;
    // assetVersion 은 설정하지 않는다. 그 검사는 화면을 오래 켜 둔 채 배포가
    // 일어났을 때를 위한 것인데, 여기서 채워 두면 첫 응답이 조금만 달라도
    // (스냅샷과 부트스트랩이 다른 수집에서 왔을 때) 새로고침 루프가 된다.
    // 실제로 그렇게 됐다 — 한 번 여는 동안 페이지가 6번 다시 떴다.
    state.hasLoadedOnce = true;
    renderDashboard();
    showIdleBadge();
  }

  loadDashboard();
}

start();
