const state = {
  dashboard: null,
  search: "",
  selectedStore: "all",
  loading: false,
  refreshTimer: null,
  badgeResetTimer: null,
  hasLoadedOnce: false
};

const elements = {
  dashboard: document.getElementById("dashboard"),
  generatedAt: document.getElementById("generated-at"),
  summaryText: document.getElementById("summary-text"),
  searchInput: document.getElementById("search-input"),
  storeFilters: document.getElementById("store-filters"),
  autoRefreshBadge: document.getElementById("auto-refresh-badge"),
  autoRefreshText: document.getElementById("auto-refresh-text")
};

const BADGE_IDLE_TEXT = "자동 갱신 · 실시간 5분 / 일반 10분";
const BADGE_UPDATE_FLASH_MS = 3200;

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

function searchableText(item) {
  return [item.title, item.meta, item.secondary]
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
  const image = item.image
    ? `<div class="cover"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy"></div>`
    : '<div class="cover"></div>';

  const titleStart = item.link
    ? `<a class="book-title" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">`
    : '<span class="book-title">';
  const titleEnd = item.link ? "</a>" : "</span>";

  return `
    <li class="rank-item">
      <span class="rank-badge">${escapeHtml(item.rank)}</span>
      ${image}
      <div class="book-copy">
        ${titleStart}${escapeHtml(item.title)}${titleEnd}
        ${item.meta ? `<div class="book-meta">${escapeHtml(item.meta)}</div>` : ""}
        ${item.secondary ? `<div class="book-secondary">${escapeHtml(item.secondary)}</div>` : ""}
      </div>
    </li>
  `;
}

function renderCard(list) {
  const items = filterItems(list.items);
  const panelStyle =
    list.accent && list.softAccent
      ? ` style="--store-accent:${escapeHtml(list.accent)}; --store-soft:${escapeHtml(list.softAccent)}"`
      : "";

  const note = list.error
    ? `<p class="panel-note panel-note-error">${escapeHtml(list.error)}</p>`
    : list.warning
      ? `<p class="panel-note panel-note-warning">${escapeHtml(list.warning)}</p>`
      : "";

  const content =
    items.length > 0
      ? `<ol class="rank-list">${items.map(renderItem).join("")}</ol>`
      : '<div class="panel-empty">현재 검색어와 일치하는 책이 없습니다.</div>';

  return `
    <article class="panel ${list.realtime ? "realtime" : ""}"${panelStyle}>
      <div class="panel-head">
        <div class="panel-title-line">
          <h3 class="panel-title">${escapeHtml(list.name)}</h3>
          ${list.storeName ? `<span class="store-mini">${escapeHtml(list.storeName)}</span>` : ""}
        </div>
      </div>
      <div class="panel-body">
        ${note}
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
      note: "첫 화면에서 모든 순위 카드를 한 번에 볼 수 있습니다."
    };
  }

  const selectedSection = sections.find((section) => section.id === state.selectedStore);
  const storeName = selectedSection ? selectedSection.name : "선택한 서점";

  return {
    kicker: storeName,
    title: `${storeName} 베스트셀러 전체 보기`,
    note: `${storeName}의 모든 순위 카드를 한 번에 볼 수 있습니다.`
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

function renderOverview(visibleSections, sections) {
  const lists = flattenLists(visibleSections);
  const realtimeCount = lists.filter((list) => list.realtime).length;
  const warningCount = lists.filter((list) => list.warning || list.error).length;
  const copy = getOverviewCopy(sections);

  return `
    <section class="overview-board">
      <div class="overview-head">
        <div>
          <p class="overview-kicker">${escapeHtml(copy.kicker)}</p>
          <h2 class="overview-title">${escapeHtml(copy.title)}</h2>
          <p class="overview-note">${escapeHtml(copy.note)}</p>
        </div>
        <div class="overview-stats">
          <span class="overview-stat">카드 ${lists.length}</span>
          <span class="overview-stat">실시간 ${realtimeCount}</span>
          <span class="overview-stat">알림 ${warningCount}</span>
        </div>
      </div>
      <div class="overview-sections">
        ${visibleSections.map(renderStoreSection).join("")}
      </div>
    </section>
  `;
}

function updateSummary() {
  if (!state.dashboard) {
    elements.summaryText.textContent = "데이터를 준비하고 있습니다.";
    return;
  }

  const visibleLists = flattenLists(getVisibleSections(state.dashboard.sections));
  const totalCards = visibleLists.length;
  const totalBooks = visibleLists.reduce((sum, list) => sum + list.itemCount, 0);
  const searchSuffix = state.search
    ? ` 현재 검색어: "${elements.searchInput.value.trim()}"`
    : "";

  elements.summaryText.textContent =
    `총 ${totalCards}개 목록, ${totalBooks}권을 표시 중입니다.${searchSuffix}`;
}

function renderDashboard() {
  if (!state.dashboard) {
    elements.dashboard.innerHTML = '<div class="panel-empty">데이터를 불러오고 있습니다.</div>';
    return;
  }

  const visibleSections = getVisibleSections(state.dashboard.sections);

  elements.generatedAt.textContent = formatDateTime(state.dashboard.generatedAt);
  renderStoreFilters(state.dashboard.sections);
  elements.dashboard.innerHTML = renderOverview(visibleSections, state.dashboard.sections);
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

    state.dashboard = await response.json();
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
}

bindEvents();
showIdleBadge();
loadDashboard();
