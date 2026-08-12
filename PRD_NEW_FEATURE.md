# 순위 히스토리 — PRD_NEW_FEATURE.md

> `/office-hours` (2026-08-12) 결과물. 설계 배경·대안 검토는
> `~/.gstack/projects/LANAHEO-book_dashboard/허란희-main-design-20260812-105130.md`

## 한 줄 정의

수집마다 상상스퀘어 신간의 순위를 남겨, 대시보드가 **"지금 몇 위"에 더해 "오르는지
내리는지"까지** 보여주게 한다.

## 왜 이것인가

`draft.md`의 현재 워크플로 3단계 중 두 개는 이미 해결됐다.

| 단계 | 상태 |
|---|---|
| 세 서점을 각각 열어 확인 | Book Radar가 해결 |
| 제목을 검색·스크롤로 찾기 | 직전 커밋의 순위 딥링크가 해결 |
| **스크린샷·메모·엑셀에 적어 둠** | **미해결 ← 이번 작업** |

전제조건은 오늘 갖춰졌다. 스냅샷 정지 버그(`7ca76d3`)를 고치지 않았다면 타임스탬프가
21분씩 얼어 있어 **거짓 시계열**이 됐다.

## UI

신규 화면 없음. 기존 `/` 대시보드의 상상스퀘어 focus 영역만 확장한다.

- focus 칩에 델타 배지 추가: `▲3` / `▼2` / `NEW` / `—`(변화 없음)
- 기준 시점을 화면에 **명시**한다 (예: "직전 수집 대비"). 팀원이 링크를 처음 열어도
  숫자의 의미를 알 수 있어야 한다 — 내부 약어나 색상만으로 뜻을 전달하지 않는다
- 색은 **대시보드의 기존 토큰**(`--success`/`--danger`/`--primary`/`--muted`)을 쓴다.
  `design.md`의 흑백 팔레트는 `/landing`에만 적용돼 있고 본체 리디자인은
  `saas-prd-v2.md`의 미완 항목이다. 여기서 `design.md`의 `sale`을 끌어오면
  반쪽 마이그레이션이 되어 주변 UI와 어긋난다
- 스파크라인은 **이번 범위 밖**. 데이터가 며칠 쌓인 뒤 별도 항목으로 얹는다

## Data

`rank_history` 테이블 1개 추가. 기존 2개와 합쳐 **총 3개** — 매뉴얼 13-saas-core의
상한(3개)에 정확히 도달하므로, 이후 기능은 테이블을 늘리지 않는 방향으로 설계한다.

```sql
create table if not exists public.rank_history (
  id bigserial primary key,
  book_key text not null,
  store_item_id text,
  title text not null,
  store_id text not null,
  list_id text not null,
  rank int not null,
  collected_at timestamptz not null
);

-- 멱등 insert의 기준. store_item_id는 NULL 가능해서 키에서 제외한다
-- (Postgres는 unique 인덱스에서 NULL을 서로 다르게 취급하므로 넣으면 중복 방지가 깨진다).
create unique index if not exists rank_history_unique
  on public.rank_history (book_key, store_id, list_id, collected_at);

-- 직전 수집 전체를 한 번에 긁는 조회 경로.
create index if not exists rank_history_collected
  on public.rank_history (collected_at desc);

alter table public.rank_history enable row level security;
```

`book_key`는 `buildFocusBooks`가 이미 계산하는
`findCatalogKey(...) || normalizeTitleKey(...)` 값을 쓴다. 히스토리 행 1개 =
focus appearance 1개.

`store_item_id`는 `extractStoreItemId(storeId, link)`로 뽑는 서점 자체 상품 ID다.
`book_key`는 서점이 보내는 제목 문자열에 의존해서 판형·부제가 바뀌면 키가 변하고
같은 책이 `NEW`로 오인된다. 서점 상품 ID가 더 안정적인 정체성이라 함께 저장한다.

## Logic

1. **적재** — `buildDashboard`가 스냅샷을 저장하기 **전에** 히스토리 단계를 돌린다.
   `collected_at`은 반드시 스냅샷의 `generatedAt`을 쓴다 — 행마다 `now()`를 쓰면
   같은 수집인데 시각이 갈려 델타 계산이 틀어진다.
2. **델타 계산 — REST 3회로 끝낸다.** appearance마다 개별 조회하면 수집당 63번의
   왕복이고 Render(싱가포르)→Supabase 기준 재생성마다 6~19초가 붙는다. 대신
   `collected_at`을 수집 단위로 균일하게 쓰므로 고정 3회로 끝난다 — 직전 수집
   시각 조회 1회, **그 시각의 전체 행 조회 1회**, 신규 행 **배열 배치 insert 1회**.
   appearance 수와 무관한 상수 회수다.
   조회는 반드시 insert **전에** 해야 한다 — 순서가 뒤바뀌면 "직전"이 지금 쓰는
   수집을 가리킨다.
3. **첫 등장 처리** — 직전 수집은 있는데 그 노출만 없었으면 `NEW`.
   히스토리가 **아예 없는 첫 수집에서는 배지를 그리지 않는다**(`deltaBaselineAt`이 빈
   문자열). 비교 대상이 없는데 61개 `NEW`를 깔면 정보가 아니라 소음이다.
4. **이탈 계산 — 센티넬 행 없이.** 2번에서 직전 수집의 전체 행을 이미 들고 있으므로,
   직전에 있었는데 현재 집합에 없는 튜플이 곧 이탈이다. 추가 쿼리 0, 스키마 오염 0.
   순위에서 빠진 자리는 칩이 사라져 배지를 붙일 곳이 없으니 책 단위로 표시한다.
   좋은 소식만 보이고 나쁜 소식이 침묵하는 것을 막는다.
5. **중복 방지** — `unique (book_key, store_id, list_id, collected_at)` +
   `Prefer: resolution=ignore-duplicates`. 재시도가 몇 번 일어나도 결과가 같다.
6. **실패 격리** — 히스토리 단계가 실패해도 스냅샷 저장과 대시보드 응답은 정상
   동작한다. `try/catch`로 감싸고 로그만 남긴다. 부가 기능이 본체를 죽이지 않게.
   `deltaBaselineAt`이 빈 문자열이면 UI는 배지를 그리지 않는다.

## 성공 기준

> **두 번의 연속 수집 후, `/`의 상상스퀘어 focus 칩에 델타 배지가 뜬다.**
> 두 수집 모두에 있던 책은 `▲n`/`▼n`/`—`, 나중 수집에만 있는 책은 `NEW`.
> 그리고 `rank_history` 행 수가 수집마다 focus appearance 수만큼 증가한다.

검증: `?refresh=all`을 순위가 바뀔 만큼 간격을 두고 두 번 실행 → Supabase에서 행 수 증가
확인 → 화면에서 배지 육안 확인 → 서버 재시작 후에도 배지가 즉시 보이는지 확인
(스냅샷에 구워졌는지 검증).

## 이번에 하지 않을 것

- 스파크라인·차트 (데이터 축적 후)
- 기간 선택 UI (직전 수집 대비로 고정)
- 알림·웹훅 (v2의 별도 항목)
- 백필 — `.cache/rankings`의 과거 파일로 시작점을 만들 수 있지만 신뢰도가 낮아 제외.
  **히스토리는 오늘 0에서 시작한다**

## 알려진 한계 (정직하게)

- **첫 수집에는 배지가 하나도 없다.** 비교 대상이 없으므로 화면은 이전과 똑같이 보이고,
  델타는 **두 번째 수집(실시간 목록 기준 60분 후)부터** 나온다. 데모 상황이라면
  이 점을 미리 말해야 한다.
- **보존 정책 없음.** 수집당 행 수 = focus appearance 수. 60분 간격이면 하루 수백~수천 행.
  무료 티어에서 며칠은 버티지만 상한이 필요하다 → 다음 항목으로 분리 (90일 삭제 또는
  일별 롤업).
- **델타 기준이 목록마다 의미가 다르다.** 실시간은 60분, 일간·주간은 6시간 주기다.
  "직전 수집 대비"가 실시간에서는 1시간, 주간에서는 6시간을 뜻한다. 1차는 단순함을
  택하고 화면에 기준을 명시해 오해를 막는다.
- **동일 수집 내 중복 가능성.** 재시도 시 같은 `(book_key, store_id, list_id, collected_at)`이
  두 번 들어갈 여지 → unique 제약 또는 조회 시 dedupe 필요.
- **`book_key`가 바뀐 책의 이탈은 화면에 안 나온다.** 이탈은 `book_key`로 모아 현재
  focus 목록에 붙이므로, 서점이 판형·부제를 바꿔 키가 변한 책은 새 키로 `NEW`가 뜨고
  옛 키의 이탈은 표시되지 않는다. `store_item_id`로 조인하면 구조적으로 해결되지만
  발생 빈도를 모르는 상태에서 델타 조인 키를 바꾸는 건 범위가 크다. 지금은
  `[history] dropout not shown, book_key absent...` 경고만 남기고, 로그가 쌓이면
  실제 빈도를 보고 결정한다.
- **팀 사용 관찰이 없다.** 이 기능이 팀에게도 유용한지는 가정이다. 다음 신간이 순위권에
  들어가는 날 팀원 한 명이 쓰는 것을 아무 말 없이 지켜볼 것.

## 작업 순서

1. Supabase SQL Editor에서 위 스키마 실행 (DDL은 REST 불가)
2. `rank_history` 적재 함수 + 델타 조회를 `server.js`에 추가
3. `rebuildDashboardSnapshot`에 적재 훅 연결, payload에 `delta`/`previousRank` 주입
4. `public/app.js` focus 칩에 배지 렌더, `public/styles.css`에 배지 스타일
5. 로컬에서 두 번 수집해 성공 기준 검증
6. 커밋 → 푸시 → 운영에서 재검증
