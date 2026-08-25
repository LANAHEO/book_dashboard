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
const FOCUS_APPEARANCE_LIMIT = 6;
const FOCUS_DROPPED_LIMIT = 4;
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

function getVisibleFocusBooks() {
  return (
    (state.dashboard?.focusBooks || [])
      .map((book) => ({
        ...book,
        appearances: filterBySelectedStore(book.appearances || []),
        // 이탈도 같이 걸러야 교보를 골랐을 때 알라딘 이탈이 섞이지 않는다.
        droppedOut: filterBySelectedStore(book.droppedOut || [])
      }))
      // 서점을 골라 보면 노출이 사라지는 책이 생기므로, 화면 기준으로 다시 뒤로 보낸다.
      // 정렬이 안정적이라 각 묶음 안의 출간 최신순은 그대로 유지된다.
      .sort(
        (a, b) => Number(b.appearances.length > 0) - Number(a.appearances.length > 0)
      )
  );
}

// 카드는 노출을 묶음·순위로 정렬해 앞에서 여섯 개만, 이탈은 네 개만 그린다.
// 요약도 이 두 함수를 지나가게 해서, 세는 것과 그리는 것이 같은 목록이 되게 한다.
function visibleAppearances(book) {
  const groupOrder = { "overall-realtime": 0, category: 1, standard: 2 };

  return [...(book.appearances || [])]
    .sort(
      (a, b) =>
        (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) ||
        getRankValue(a.rank) - getRankValue(b.rank)
    )
    .slice(0, FOCUS_APPEARANCE_LIMIT);
}

function visibleDropouts(book) {
  return (book.droppedOut || []).slice(0, FOCUS_DROPPED_LIMIT);
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
  const href = item.listUrl || item.link;
  const hint = item.listUrl
    ? `${item.title} · ${item.rank}위 위치로 이동`
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
  const href = appearance.listUrl || appearance.link;

  return href
    ? `<a class="focus-rank-metric" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(`${source} ${appearance.rank}위 위치로 이동`)}">${body}</a>`
    : `<div class="focus-rank-metric">${body}</div>`;
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

function renderFocusAppearance(item) {
  const label = `${item.storeName} · ${item.listName} · ${item.rank}위`;
  const body = `${escapeHtml(label)}${renderRankDelta(item)}`;
  // 해당 위가 있는 목록 페이지 + 그 도서 위치를 우선하고, 없으면 도서 상세로 간다.
  const href = item.listUrl || item.link;

  if (!href) {
    return `<span class="focus-chip">${body}</span>`;
  }

  const hint = `${label} 위치로 이동${deltaHint(item)}`;

  return `<a class="focus-chip" href="${escapeHtml(href)}" target="_blank" rel="noreferrer" title="${escapeHtml(hint)}">${body}</a>`;
}

// 순위에서 빠진 자리는 칩이 사라져 배지를 붙일 곳이 없으므로 따로 그린다.
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
    visibleAppearances(book).forEach((item) => {
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
          <p>상상스퀘어 신간을 자동으로 불러와 수집된 순위에서 노출을 찾고, 출간 최신순으로 표시합니다.</p>
          ${state.dashboard && state.dashboard.deltaBaselineAt
            ? `<p class="focus-delta-note">▲▼ 는 ${escapeHtml(
                formatDateTime(state.dashboard.deltaBaselineAt)
              )} 수집과 비교한 순위 변화입니다. NEW 는 그때 없던 노출입니다.</p>`
            : ""}
          ${renderFocusDeltaSummary(focusBooks)}
        </div>
        <span class="section-count">${escapeHtml(focusBooks.length)}종 추적</span>
      </div>
      <div class="focus-grid">
        ${focusBooks
          .map((book) => {
            const appearances = book.appearances || [];
            // 칩으로 그리는 건 이 중 앞쪽 일부다. 노출 개수와 최고 순위는 전부를 본다.
            const shownAppearances = visibleAppearances(book);
            const overallBest = bestAppearanceFor(
              appearances,
              (item) => item.group === "overall-realtime"
            );
            const categoryBest = bestAppearanceFor(
              appearances,
              (item) => item.group === "category"
            );

            const droppedOut = renderDroppedOut(book);
            // 이번 수집에 없고 직전에는 있었다면 "진입 대기"가 아니라 이탈이다.
            const statusLabel = appearances.length
              ? "순위 확인"
              : droppedOut
                ? "순위 이탈"
                : "진입 대기";

            return `
              <article class="focus-card">
                <div class="focus-card-top">
                  <span class="focus-status ${appearances.length ? "active" : ""}${
                    !appearances.length && droppedOut ? " dropped" : ""
                  }">
                    ${statusLabel}
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
                  ${shownAppearances
                    .map((item) => renderFocusAppearance(item))
                    .join("")}
                  ${droppedOut}
                  ${!appearances.length && !droppedOut
                    ? '<span class="focus-chip muted">현재 수집된 순위에는 없습니다.</span>'
                    : ""}
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
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </article>
      `;
    })
    .join("");

  elements.collectStatus.innerHTML = `
    <div class="cs-head">
      <h2>데이터 수집 시점</h2>
      <p>
        왼쪽은 <strong>서점이 그 순위를 언제 기준으로 집계했는지</strong>,
        오른쪽은 <strong>우리가 그것을 언제 가져왔는지</strong>입니다. 둘은 다른 값입니다.
      </p>
    </div>
    <div class="cs-grid">${cards}</div>
  `;
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
