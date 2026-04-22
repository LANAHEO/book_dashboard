const state = {
  dashboard: null,
  search: "",
  selectedStore: "all",
  loading: false,
  refreshTimer: null,
  clockTimer: null
};

const elements = {
  dashboard: document.getElementById("dashboard"),
  generatedAt: document.getElementById("generated-at"),
  summaryText: document.getElementById("summary-text"),
  searchInput: document.getElementById("search-input"),
  storeFilters: document.getElementById("store-filters")
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

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function relativeRefreshText(value) {
  if (!value) {
    return "";
  }

  const diffMs = new Date(value).getTime() - Date.now();

  if (diffMs <= 0) {
    return "곧 다시 갱신됩니다";
  }

  const minutes = Math.round(diffMs / 60000);

  if (minutes < 60) {
    return `${minutes}분 후 자동 갱신`;
  }

  return `${Math.round(minutes / 60)}시간 후 자동 갱신`;
}

function searchableText(item) {
  return [item.title, item.meta, item.secondary].join(" ").toLowerCase();
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

  const linkStart = item.link
    ? `<a class="book-title" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">`
    : '<span class="book-title">';
  const linkEnd = item.link ? "</a>" : "</span>";

  return `
    <li class="rank-item">
      <span class="rank-badge">${item.rank}</span>
      ${image}
      <div class="book-copy">
        ${linkStart}${escapeHtml(item.title)}${linkEnd}
        ${item.meta ? `<div class="book-meta">${escapeHtml(item.meta)}</div>` : ""}
        ${item.secondary ? `<div class="book-secondary">${escapeHtml(item.secondary)}</div>` : ""}
      </div>
    </li>
  `;
}

function renderCard(list) {
  const items = filterItems(list.items);
  const tags = [];
  const panelStyle =
    list.accent && list.softAccent
      ? ` style="--store-accent:${escapeHtml(list.accent)}; --store-soft:${escapeHtml(list.softAccent)}"`
      : "";
  const storeLabel = list.storeName
    ? `<span class="store-mini">${escapeHtml(list.storeName)}</span>`
    : "";

  if (list.realtime) {
    tags.push('<span class="tag tag-accent">실시간</span>');
  }

  tags.push(`<span class="tag">${escapeHtml(list.typeLabel)}</span>`);
  tags.push(`<span class="tag">항목 ${list.itemCount}권</span>`);

  if (list.warning) {
    tags.push('<span class="tag tag-warning">캐시 표시</span>');
  }

  if (list.error) {
    tags.push('<span class="tag tag-error">수집 실패</span>');
  }

  const note = list.error
    ? `<p class="panel-note panel-note-error">${escapeHtml(list.error)}</p>`
    : list.warning
      ? `<p class="panel-note panel-note-warning">${escapeHtml(list.warning)}</p>`
      : "";

  const sourceStamp = list.sourceStamp
    ? `<div class="panel-sub">원본 기준: ${escapeHtml(list.sourceStamp)}</div>`
    : '<div class="panel-sub">마지막 수집: ' + escapeHtml(formatDateTime(list.updatedAt)) + "</div>";

  const realtimeHint =
    list.realtime && list.nextRefreshAt
      ? `<div class="panel-sub">다음 자동 갱신: ${escapeHtml(formatTime(list.nextRefreshAt))} · ${escapeHtml(relativeRefreshText(list.nextRefreshAt))}</div>`
      : "";

  const content =
    items.length > 0
      ? `<ol class="rank-list">${items.map(renderItem).join("")}</ol>`
      : '<div class="panel-empty">현재 검색어와 일치하는 책이 없습니다.</div>';

  return `
    <article class="panel ${list.realtime ? "realtime" : ""}"${panelStyle}>
      <div class="panel-head">
        ${storeLabel}
        <div class="panel-title-row">
          <div>
            <h3 class="panel-title">${escapeHtml(list.name)}</h3>
            ${sourceStamp}
            ${realtimeHint}
          </div>
          <div class="panel-actions">
            <button type="button" class="inline-button" data-refresh-source="${escapeHtml(list.id)}">이 카드 갱신</button>
            <a class="inline-link" href="${escapeHtml(list.sourceUrl)}" target="_blank" rel="noreferrer">원문 보기</a>
          </div>
        </div>
        <div class="panel-tags">${tags.join("")}</div>
      </div>
      <div class="panel-body">
        ${note}
        <div class="rank-scroll">${content}</div>
      </div>
    </article>
  `;
}

function flattenLists(sections) {
  return sections.flatMap((section) =>
    section.lists.map((list) => ({
      ...list,
      storeName: section.name,
      accent: section.accent,
      softAccent: section.softAccent
    }))
  );
}

function getVisibleLists(lists) {
  if (state.selectedStore === "all") {
    return lists;
  }

  return lists.filter((list) => list.storeId === state.selectedStore);
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

function renderOverview(lists) {
  const realtimeCount = lists.filter((list) => list.realtime).length;
  const warningCount = lists.filter((list) => list.warning || list.error).length;

  return `
    <section class="overview-board">
      <div class="overview-head">
        <div>
          <p class="overview-kicker">All Sources</p>
          <h2 class="overview-title">Kyobo, YES24, Aladin on one board</h2>
          <p class="overview-note">Every source card is visible as soon as the page opens.</p>
        </div>
        <div class="overview-stats">
          <span class="overview-stat">Cards ${lists.length}</span>
          <span class="overview-stat">Realtime ${realtimeCount}</span>
          <span class="overview-stat">Alerts ${warningCount}</span>
        </div>
      </div>
      <div class="overview-grid">
        ${lists.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function renderSection(section) {
  return `
    <section
      class="store-section"
      style="--store-accent:${escapeHtml(section.accent)}; --store-soft:${escapeHtml(section.softAccent)}"
    >
      <div class="store-header">
        <div class="store-title-wrap">
          <span class="store-kicker">${escapeHtml(section.name)}</span>
          <div>
            <h2 class="store-title">${escapeHtml(section.name)}</h2>
            <div class="store-subtitle">${section.lists.length}개 랭킹 카드</div>
          </div>
        </div>
      </div>
      <div class="store-grid">
        ${section.lists.map(renderCard).join("")}
      </div>
    </section>
  `;
}

function updateSummary() {
  if (!state.dashboard) {
    elements.summaryText.textContent = "데이터를 준비하고 있습니다.";
    return;
  }

  const visibleLists = getVisibleLists(flattenLists(state.dashboard.sections));
  const totalCards = visibleLists.length;
  const totalBooks = visibleLists.reduce((sum, list) => sum + list.itemCount, 0);

  elements.summaryText.textContent =
    `총 ${totalCards}개 목록, ${totalBooks}권을 표시 중입니다.` +
    (state.search ? ` 현재 검색어: "${elements.searchInput.value.trim()}"` : "");
}

function renderDashboard() {
  if (!state.dashboard) {
    elements.dashboard.innerHTML = '<div class="panel-empty">데이터를 불러오고 있습니다.</div>';
    return;
  }

  const allLists = flattenLists(state.dashboard.sections);
  const visibleLists = getVisibleLists(allLists);

  elements.generatedAt.textContent = formatDateTime(state.dashboard.generatedAt);
  renderStoreFilters(state.dashboard.sections);
  elements.dashboard.innerHTML = renderOverview(visibleLists);
  updateSummary();
}

function setLoading(loading) {
  state.loading = loading;
  elements.dashboard.setAttribute("aria-busy", loading ? "true" : "false");
  elements.summaryText.textContent = loading
    ? "데이터를 새로 수집하는 중입니다."
    : elements.summaryText.textContent;
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
    scheduleRealtimeRefresh();
  } catch (error) {
    elements.dashboard.innerHTML =
      `<div class="panel-empty">대시보드를 불러오지 못했습니다.<br>${escapeHtml(error.message)}</div>`;
    elements.generatedAt.textContent = "불러오기 실패";
    elements.summaryText.textContent = "서버 응답을 확인해 주세요.";
  } finally {
    setLoading(false);
  }
}

function scheduleRealtimeRefresh() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  if (state.clockTimer) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }

  if (!state.dashboard) {
    return;
  }

  const realtimeLists = state.dashboard.sections
    .flatMap((section) => section.lists)
    .filter((list) => list.realtime && list.nextRefreshAt);

  if (!realtimeLists.length) {
    return;
  }

  const nextTime = Math.min(
    ...realtimeLists.map((list) => new Date(list.nextRefreshAt).getTime())
  );
  const delay = Math.max(nextTime - Date.now(), 30_000);

  state.refreshTimer = window.setTimeout(() => {
    loadDashboard("realtime");
  }, delay);

  state.clockTimer = window.setInterval(() => {
    if (state.dashboard) {
      renderDashboard();
    }
  }, 60_000);
}

function bindEvents() {
  document.querySelectorAll("[data-refresh]").forEach((button) => {
    button.addEventListener("click", () => {
      loadDashboard(button.dataset.refresh);
    });
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
    const target = event.target.closest("[data-refresh-source]");
    if (!target) {
      return;
    }

    loadDashboard(target.dataset.refreshSource);
  });
}

bindEvents();
loadDashboard();
