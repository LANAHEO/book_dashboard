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
  mobileRealtimeStore: "kyobo",
  categoryStore: "yes24",
  categoryPeriod: "realtime",
  categoryListByStore: {},
  rankPages: {}
};

const elements = {
  dashboard: document.getElementById("dashboard"),
  generatedAt: document.getElementById("generated-at"),
  summaryText: document.getElementById("summary-text"),
  searchInput: document.getElementById("search-input"),
  storeFilters: document.getElementById("store-filters"),
  viewNav: document.querySelector(".view-nav"),
  autoRefreshBadge: document.getElementById("auto-refresh-badge"),
  autoRefreshText: document.getElementById("auto-refresh-text")
};

const BADGE_IDLE_TEXT = "자동 갱신 · 실시간 5분 / 일반 10분";
const BADGE_UPDATE_FLASH_MS = 3200;
const WATCH_PUBLISHER_NAME = "상상스퀘어";
const WATCH_PUBLISHER_KEY = WATCH_PUBLISHER_NAME.replace(/\s+/g, "").toLowerCase();
const STORE_ALERT_ORDER = ["kyobo", "yes24", "aladin"];
const RANK_PAGE_SIZE = 20;
const CATEGORY_PERIODS = [
  { key: "realtime", label: "실시간" },
  { key: "daily", label: "일간" },
  { key: "weekly", label: "주간" }
];
const VIEW_LABELS = {
  focus: "상상스퀘어 도서 순위",
  realtime: "전체 실시간 TOP 100",
  category: "분야별 순위",
  daily: "전체 서점 일간 순위",
  weekly: "전체 서점 주간 순위"
};

function escapeHtml(value) {
  return String(value || "")
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
  setAutoRefreshBadge(BADGE_IDLE_TEXT, "idle");
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

function getVisiblePublisherAlerts() {
  const alerts = state.dashboard?.alerts?.items || [];

  if (state.selectedStore === "all") {
    return alerts;
  }

  return alerts.filter((alert) => alert.storeId === state.selectedStore);
}

function getStoreAlertOrder(storeId) {
  const index = STORE_ALERT_ORDER.indexOf(storeId);
  return index === -1 ? STORE_ALERT_ORDER.length : index;
}

function getRankValue(rank) {
  const value = Number(rank);
  return Number.isFinite(value) ? value : 9999;
}

function getRankTier(rank) {
  const value = getRankValue(rank);

  if (value <= 10) {
    return "top10";
  }

  if (value <= 30) {
    return "top30";
  }

  if (value <= 100) {
    return "top100";
  }

  return "other";
}

function sortPublisherAlerts(alerts) {
  return [...alerts].sort((a, b) => {
    const storeOrder = getStoreAlertOrder(a.storeId) - getStoreAlertOrder(b.storeId);

    if (storeOrder !== 0) {
      return storeOrder;
    }

    const rankOrder = getRankValue(a.rank) - getRankValue(b.rank);

    if (rankOrder !== 0) {
      return rankOrder;
    }

    return `${a.title || ""}${a.listName || ""}`.localeCompare(
      `${b.title || ""}${b.listName || ""}`,
      "ko"
    );
  });
}

function groupPublisherAlertsByStore(alerts, sections) {
  const storeNames = new Map(sections.map((section) => [section.id, section.name]));
  const groups = new Map();

  sortPublisherAlerts(alerts).forEach((alert) => {
    if (!groups.has(alert.storeId)) {
      groups.set(alert.storeId, {
        storeId: alert.storeId,
        storeName: storeNames.get(alert.storeId) || alert.storeName || "서점",
        items: []
      });
    }

    groups.get(alert.storeId).items.push(alert);
  });

  return [...groups.values()].sort(
    (a, b) => getStoreAlertOrder(a.storeId) - getStoreAlertOrder(b.storeId)
  );
}

function filterBySelectedStore(items) {
  if (state.selectedStore === "all") {
    return items;
  }

  return items.filter((item) => item.storeId === state.selectedStore);
}

function getVisibleFocusBooks() {
  return (
    (state.dashboard?.focusBooks || [])
      .map((book) => ({
        ...book,
        appearances: filterBySelectedStore(book.appearances || [])
      }))
      // 서점을 골라 보면 노출이 사라지는 책이 생기므로, 화면 기준으로 다시 뒤로 보낸다.
      // 정렬이 안정적이라 각 묶음 안의 출간 최신순은 그대로 유지된다.
      .sort(
        (a, b) => Number(b.appearances.length > 0) - Number(a.appearances.length > 0)
      )
  );
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

  const titleStart = item.link
    ? `<a class="book-title" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">`
    : '<span class="book-title">';
  const titleEnd = item.link ? "</a>" : "</span>";
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

  const content =
    items.length > 0
      ? `<ol class="rank-list">${items.map(renderItem).join("")}</ol>`
      : '<div class="panel-empty">현재 검색어와 일치하는 책이 없습니다.</div>';
  const countLabel = state.search
    ? `검색 결과 ${filteredItems.length}권`
    : list.realtime
      ? `100위 범위 · ${list.itemCount}권 수집`
      : `${list.itemCount}권 수집`;
  const typeLabel = list.typeLabel || (list.realtime ? "실시간" : "베스트");

  return `
    <article class="${classNames}"${panelStyle}>
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

function getVisibleLists(lists) {
  if (state.selectedStore === "all") {
    return lists;
  }

  return lists.filter((list) => list.storeId === state.selectedStore);
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

function getOverviewCopy(sections) {
  if (state.selectedStore === "all") {
    return {
      kicker: "All Sources",
      title: "교보문고, 예스24, 알라딘 전체 보기",
      note: "전체 실시간 TOP 100을 먼저 확인하고, 이어서 주력 도서와 분야별 실시간 순위를 봅니다."
    };
  }

  const selectedSection = sections.find((section) => section.id === state.selectedStore);
  const storeName = selectedSection ? selectedSection.name : "선택한 서점";

  return {
    kicker: storeName,
    title: `${storeName} 베스트셀러 전체 보기`,
    note: `${storeName} 기준으로 실시간 순위와 주력 도서 노출 현황을 확인합니다.`
  };
}

function renderStoreSection(section) {
  const columnCount = Math.max(section.lists.length, 1);

  return `
    <section
      class="store-section"
      style="--store-accent:${escapeHtml(section.accent)}; --store-soft:${escapeHtml(section.softAccent)}; --store-columns:${columnCount}"
    >
      <div class="store-header">
        <div class="store-title-wrap">
          <span class="store-kicker">${escapeHtml(section.name)}</span>
          <h3 class="store-title">${escapeHtml(section.name)}</h3>
        </div>
      </div>
      <div class="store-grid store-grid-roomy">
        ${section.lists.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function renderRankGroup(title, note, lists, variant = "") {
  if (!lists.length) {
    return "";
  }

  const itemTotal = lists.reduce((sum, list) => sum + (list.itemCount || 0), 0);
  const groupClass = ["rank-section", variant ? `rank-section-${variant}` : ""]
    .filter(Boolean)
    .join(" ");

  return `
    <section class="${groupClass}">
      <div class="rank-section-head">
        <div>
          <h3 class="rank-section-title">${escapeHtml(title)}</h3>
          ${note ? `<p class="rank-section-note">${escapeHtml(note)}</p>` : ""}
        </div>
        <div class="rank-section-stat">
          <strong>${escapeHtml(itemTotal)}</strong>
          <span>권</span>
        </div>
      </div>
      <div class="rank-section-grid">
        ${lists.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function renderFocusBoard() {
  const focusBooks = getVisibleFocusBooks();

  if (!focusBooks.length) {
    return "";
  }

  return `
    <section class="focus-board">
      <div class="rank-section-head">
        <div>
          <h3 class="rank-section-title">주력 도서 순위 추적</h3>
          <p class="rank-section-note">주요 도서가 전체/분야별 실시간 순위에서 몇 위에 있는지 모아봅니다.</p>
        </div>
      </div>
      <div class="focus-grid">
        ${focusBooks
          .map((book) => {
            const appearances = book.appearances || [];
            const realtimeAppearances = appearances.filter((item) => item.realtime);
            const rankBasis = realtimeAppearances.length ? realtimeAppearances : appearances;
            const bestRank = rankBasis.length
              ? Math.min(...rankBasis.map((item) => item.rank).filter(Boolean))
              : null;
            const preview = appearances.slice(0, 8);

            return `
              <article class="focus-card">
                <div class="focus-card-head">
                  <span class="focus-rank">${bestRank ? `${escapeHtml(bestRank)}위` : "-"}</span>
                  <div>
                    <h4 class="focus-title">${escapeHtml(book.title)}</h4>
                    <p class="focus-note">${appearances.length ? `${appearances.length}개 순위에서 확인` : "현재 표시 중인 순위권에 없음"}</p>
                  </div>
                </div>
                <div class="focus-appearances">
                  ${
                    preview.length
                      ? preview
                          .map((item) => {
                            const label = `${item.storeName} · ${item.categoryName || item.listName} · ${item.rank}위`;
                            return item.link
                              ? `<a class="focus-chip" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
                              : `<span class="focus-chip">${escapeHtml(label)}</span>`;
                          })
                          .join("")
                      : '<span class="focus-chip muted">순위권 진입 대기</span>'
                  }
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderOverview(visibleSections, sections) {
  const lists = flattenLists(visibleSections);
  const overallRealtimeLists = lists.filter((list) => list.group === "overall-realtime");
  const categoryRealtimeLists = lists.filter((list) => list.group === "category");
  const standardLists = lists.filter((list) => list.group === "standard" || !list.group);
  const realtimeTotal = overallRealtimeLists.reduce((sum, list) => sum + (list.itemCount || 0), 0);
  const focusTotal = getVisibleFocusBooks().reduce(
    (sum, book) => sum + (book.appearances || []).length,
    0
  );
  const alertTotal = getVisiblePublisherAlerts().length;
  const copy = getOverviewCopy(sections);

  return `
    <section class="overview-board">
      <div class="overview-head">
        <div>
          <p class="overview-kicker">${escapeHtml(copy.kicker)}</p>
          <h2 class="overview-title">${escapeHtml(copy.title)}</h2>
          <p class="overview-note">${escapeHtml(copy.note)}</p>
        </div>
      </div>
      <div class="dashboard-metrics">
        <div class="metric-card metric-primary">
          <span>전체 실시간</span>
          <strong>${escapeHtml(realtimeTotal)}</strong>
          <small>권 추적</small>
        </div>
        <div class="metric-card">
          <span>분야별 실시간</span>
          <strong>${escapeHtml(categoryRealtimeLists.length)}</strong>
          <small>개 카드</small>
        </div>
        <div class="metric-card">
          <span>주력 도서 노출</span>
          <strong>${escapeHtml(focusTotal)}</strong>
          <small>건</small>
        </div>
        <div class="metric-card">
          <span>출판사 알림</span>
          <strong>${escapeHtml(alertTotal)}</strong>
          <small>건</small>
        </div>
      </div>
      <div class="overview-sections">
        ${renderRankGroup(
          "전체 실시간 TOP 100",
          "가장 자주 확인하는 전체 실시간 순위입니다.",
          overallRealtimeLists,
          "priority"
        )}
        ${renderRankGroup(
          "기타 베스트셀러",
          "주간, 일간, 월간 등 참고용 순위입니다.",
          standardLists
        )}
        ${renderFocusBoard()}
        ${renderRankGroup(
          "분야별 베스트셀러",
          "교보문고, 예스24, 알라딘의 분야별 순위를 묶었습니다.",
          categoryRealtimeLists,
          "category"
        )}
      </div>
    </section>
  `;
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

function renderFocusRank(label, appearance) {
  if (!appearance) {
    return `
      <div class="focus-rank-metric muted">
        <span>${escapeHtml(label)}</span>
        <strong>순위권 밖</strong>
      </div>
    `;
  }

  const source = [appearance.storeName, appearance.listName].filter(Boolean).join(" · ");
  const body = `
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(appearance.rank)}위</strong>
    <em class="focus-rank-source">${escapeHtml(source)}</em>
  `;

  return appearance.listUrl
    ? `<a class="focus-rank-metric" href="${escapeHtml(appearance.listUrl)}" target="_blank" rel="noreferrer" title="${escapeHtml(`${source} 순위 페이지 열기`)}">${body}</a>`
    : `<div class="focus-rank-metric">${body}</div>`;
}

function formatPublishedDate(value) {
  if (!value) {
    return "출간일 확인 중";
  }

  return `출간 ${String(value).replaceAll("-", ".")}`;
}

function renderFocusBoardV2() {
  const focusBooks = getVisibleFocusBooks();

  return `
    <section class="focus-board section-block focus-board-priority" id="focus-books">
      <div class="section-heading">
        <div>
          <div class="section-label">Sangsang Square</div>
          <h2>상상스퀘어 도서 순위</h2>
          <p>상상스퀘어 신간을 자동으로 불러와 수집된 순위에서 노출을 찾고, 출간 최신순으로 표시합니다.</p>
        </div>
        <span class="section-count">${escapeHtml(focusBooks.length)}종 추적</span>
      </div>
      <div class="focus-grid">
        ${focusBooks
          .map((book) => {
            const appearances = [...(book.appearances || [])].sort((a, b) => {
              const groupOrder = {
                "overall-realtime": 0,
                category: 1,
                standard: 2
              };
              return (
                (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) ||
                getRankValue(a.rank) - getRankValue(b.rank)
              );
            });
            const overallBest = bestAppearanceFor(
              appearances,
              (item) => item.group === "overall-realtime"
            );
            const categoryBest = bestAppearanceFor(
              appearances,
              (item) => item.group === "category"
            );

            return `
              <article class="focus-card">
                <div class="focus-card-top">
                  <span class="focus-status ${appearances.length ? "active" : ""}">
                    ${appearances.length ? "순위 확인" : "진입 대기"}
                  </span>
                  <span class="focus-appearance-count">
                    ${escapeHtml(formatPublishedDate(book.latestPublishedAt))} · ${escapeHtml(appearances.length)}곳 노출
                  </span>
                </div>
                <h3 class="focus-title">
                  ${book.link
                    ? `<a href="${escapeHtml(book.link)}" target="_blank" rel="noreferrer">${escapeHtml(book.title)}</a>`
                    : escapeHtml(book.title)}
                </h3>
                <div class="focus-rank-grid">
                  ${renderFocusRank("전체 실시간", overallBest)}
                  ${renderFocusRank("분야 최고", categoryBest)}
                </div>
                <div class="focus-appearances">
                  ${appearances.length
                    ? appearances
                        .slice(0, 6)
                        .map((item) => {
                          const label = `${item.storeName} · ${item.listName} · ${item.rank}위`;
                          return item.link
                            ? `<a class="focus-chip" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
                            : `<span class="focus-chip">${escapeHtml(label)}</span>`;
                        })
                        .join("")
                    : '<span class="focus-chip muted">현재 수집된 순위에는 없습니다.</span>'}
                </div>
              </article>
            `;
          })
          .join("")}
      </div>
    </section>
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

  if (!lists.some((list) => list.storeId === state.mobileRealtimeStore)) {
    state.mobileRealtimeStore = lists[0].storeId;
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
      ${renderStoreSwitcher(
        lists,
        state.mobileRealtimeStore,
        "data-mobile-realtime-store",
        "모바일 실시간 서점 선택"
      )}
      <div class="realtime-grid">
        ${lists
          .map(
            (list) => `
              <div class="realtime-store-card ${state.mobileRealtimeStore === list.storeId ? "mobile-active" : ""}">
                ${renderCard(list)}
              </div>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function getCategoryListKey(storeId, period) {
  return `${storeId}:${period}`;
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

  const storeLists = STORE_ALERT_ORDER
    .map((storeId) => lists.find((list) => list.storeId === storeId))
    .filter(Boolean);

  if (!storeLists.some((list) => list.storeId === state.categoryStore)) {
    state.categoryStore = storeLists[0].storeId;
  }

  const storeScopedLists = lists.filter((list) => list.storeId === state.categoryStore);

  if (!storeScopedLists.some((list) => list.period === state.categoryPeriod)) {
    state.categoryPeriod = storeScopedLists[0].period;
  }

  const activeLists = storeScopedLists.filter(
    (list) => list.period === state.categoryPeriod
  );
  const listKey = getCategoryListKey(state.categoryStore, state.categoryPeriod);
  let selectedListId = state.categoryListByStore[listKey];

  if (!activeLists.some((list) => list.id === selectedListId)) {
    selectedListId = activeLists[0].id;
    state.categoryListByStore[listKey] = selectedListId;
  }

  const selectedIndex = activeLists.findIndex((list) => list.id === selectedListId);
  const selectedList = activeLists[selectedIndex];
  const categoryCountByStore = lists.reduce((counts, list) => {
    if (list.period === state.categoryPeriod) {
      counts[list.storeId] = (counts[list.storeId] || 0) + 1;
    }

    return counts;
  }, {});

  return `
    <section class="section-block category-board" id="category-rankings">
      <div class="section-heading">
        <div>
          <div class="section-label">Categories</div>
          <h2>분야별 순위</h2>
          <p>서점과 기간을 고르고 분야를 순서대로 넘겨보세요.</p>
        </div>
        <span class="section-count">${escapeHtml(selectedIndex + 1)} / ${escapeHtml(activeLists.length)}</span>
      </div>
      ${renderStoreSwitcher(
        storeLists,
        state.categoryStore,
        "data-category-store",
        "분야별 순위 서점 선택",
        (list) => `${categoryCountByStore[list.storeId] || 0}개 분야`
      )}
      ${renderCategoryPeriodSwitcher(storeScopedLists, selectedList.accent)}
      <div class="category-selector" aria-label="분야 선택">
        ${activeLists
          .map(
            (list) => `
              <button
                type="button"
                class="category-selector-button ${selectedList.id === list.id ? "active" : ""}"
                data-category-list="${escapeHtml(list.id)}"
                aria-pressed="${selectedList.id === list.id ? "true" : "false"}"
              >
                ${escapeHtml(list.categoryName || list.name)}
              </button>
            `
          )
          .join("")}
      </div>
      <div class="category-stage">
        <div class="category-stepper">
          <button type="button" data-category-step="-1" ${selectedIndex === 0 ? "disabled" : ""}>이전 분야</button>
          <strong>${escapeHtml(selectedList.categoryName || selectedList.name)}</strong>
          <button type="button" data-category-step="1" ${selectedIndex === activeLists.length - 1 ? "disabled" : ""}>다음 분야</button>
        </div>
        ${renderCard(selectedList)}
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
      <div class="standard-grid">
        ${sortByStoreOrder(lists).map(renderCard).join("")}
      </div>
      ${extraLists.length
        ? `
          <div class="board-subheading">${escapeHtml(extraTitle)}</div>
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

function renderPublisherAlerts() {
  if (!elements.publisherAlerts) {
    return;
  }

  const visibleAlerts = getVisiblePublisherAlerts();

  if (!state.dashboard || visibleAlerts.length === 0) {
    elements.publisherAlerts.hidden = true;
    elements.publisherAlerts.innerHTML = "";
    return;
  }

  const selectedSection =
    state.selectedStore === "all"
      ? null
      : state.dashboard.sections.find((section) => section.id === state.selectedStore);
  const scopeLabel = selectedSection ? selectedSection.name : "교보문고 · 예스24 · 알라딘";
  const uniqueTitleCount = new Set(
    visibleAlerts.map((alert) => `${alert.title}::${alert.publisher}`)
  ).size;
  const alertGroups = groupPublisherAlertsByStore(visibleAlerts, state.dashboard.sections);

  elements.publisherAlerts.hidden = false;
  elements.publisherAlerts.innerHTML = `
    <div class="publisher-alert-card">
      <div class="publisher-alert-head">
        <div>
          <p class="publisher-alert-kicker">출판사 알림</p>
          <h2 class="publisher-alert-title">${escapeHtml(WATCH_PUBLISHER_NAME)} 도서 ${visibleAlerts.length}건 감지</h2>
          <p class="publisher-alert-note">${escapeHtml(scopeLabel)} 베스트셀러에서 ${uniqueTitleCount}종의 도서가 확인되었습니다.</p>
        </div>
      </div>
      <div class="publisher-alert-groups">
        ${alertGroups
          .map(
            (group) => `
              <section class="publisher-alert-store publisher-alert-store-${escapeHtml(group.storeId)}">
                <div class="publisher-alert-store-head">
                  <span class="publisher-alert-store-name">${escapeHtml(group.storeName)}</span>
                  <span class="publisher-alert-store-count">${escapeHtml(group.items.length)}건</span>
                </div>
                <div class="publisher-alert-store-list">
                  ${group.items
                    .map((alert) => {
                      const rankTier = getRankTier(alert.rank);
                      const content = `
                        <span class="publisher-alert-rank publisher-alert-rank-${rankTier}">${escapeHtml(alert.rank)}위</span>
                        <span class="publisher-alert-copy">
                          <strong>${escapeHtml(alert.title)}</strong>
                          <span>${escapeHtml(alert.listName)}</span>
                        </span>
                      `;

                      return alert.link
                        ? `<a class="publisher-alert-chip" href="${escapeHtml(alert.link)}" target="_blank" rel="noreferrer">${content}</a>`
                        : `<div class="publisher-alert-chip">${content}</div>`;
                    })
                    .join("")}
                </div>
              </section>
            `
          )
          .join("")}
      </div>
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

function renderDashboard() {
  if (!state.dashboard) {
    elements.dashboard.innerHTML = '<div class="panel-empty">데이터를 불러오고 있습니다.</div>';
    return;
  }

  const visibleSections = getVisibleSections(state.dashboard.sections);

  elements.generatedAt.textContent = formatDateTime(state.dashboard.generatedAt);
  renderStoreFilters(state.dashboard.sections);
  elements.dashboard.innerHTML = renderDashboardSections(visibleSections);
  updateSummary();
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

function scheduleDashboardRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (!state.dashboard) {
    return;
  }

  const refreshableLists = state.dashboard.sections
    .flatMap((section) => section.lists)
    .filter((list) => list.nextRefreshAt);

  if (!refreshableLists.length) {
    return;
  }

  const nextTime = Math.min(
    ...refreshableLists.map((list) => new Date(list.nextRefreshAt).getTime())
  );
  const delay = Math.max(nextTime - Date.now(), 30_000);

  state.refreshTimer = window.setTimeout(() => {
    loadDashboard();
  }, delay);
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

    const realtimeStoreButton = event.target.closest("[data-mobile-realtime-store]");
    if (realtimeStoreButton) {
      state.mobileRealtimeStore = realtimeStoreButton.dataset.mobileRealtimeStore;
      renderDashboard();
      return;
    }

    const categoryStoreButton = event.target.closest("[data-category-store]");
    if (categoryStoreButton) {
      state.categoryStore = categoryStoreButton.dataset.categoryStore;
      renderDashboard();
      return;
    }

    const categoryPeriodButton = event.target.closest("[data-category-period]");
    if (categoryPeriodButton) {
      state.categoryPeriod = categoryPeriodButton.dataset.categoryPeriod;
      renderDashboard();
      return;
    }

    const listKey = getCategoryListKey(state.categoryStore, state.categoryPeriod);

    const categoryListButton = event.target.closest("[data-category-list]");
    if (categoryListButton) {
      state.categoryListByStore[listKey] = categoryListButton.dataset.categoryList;
      renderDashboard();
      return;
    }

    const categoryStepButton = event.target.closest("[data-category-step]");
    if (categoryStepButton) {
      const lists = flattenLists(
        getVisibleSections(state.dashboard.sections)
      ).filter(
        (list) =>
          list.group === "category" &&
          list.storeId === state.categoryStore &&
          list.period === state.categoryPeriod
      );
      const selectedId = state.categoryListByStore[listKey];
      const currentIndex = Math.max(
        0,
        lists.findIndex((list) => list.id === selectedId)
      );
      const nextIndex = Math.min(
        Math.max(
          currentIndex + Number(categoryStepButton.dataset.categoryStep),
          0
        ),
        lists.length - 1
      );

      if (lists[nextIndex]) {
        state.categoryListByStore[listKey] = lists[nextIndex].id;
        renderDashboard();
      }
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
bindEvents();
showIdleBadge();
loadDashboard();
