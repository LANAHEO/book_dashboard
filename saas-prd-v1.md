# Book Radar (1차) — saas-prd-v1.md

## 한 줄 정의

교보·예스24·알라딘 순위를 백그라운드로 모아 Supabase에 저장하고, 대시보드(`/`)는 DB(또는 로컬 폴백)에서 읽어 **빠르게 보여주는** 도서 순위 도구.

## UI

- 화면 1: 대시보드 `/` — 기존 Book Radar (상상스퀘어 / 실시간 / 분야 / 일간 / 주간). 신규 화면 추가 없음.
- 화면 2: 랜딩 `/landing` — 이미 존재. 그대로 유지.

## Data

| 테이블 | 역할 | 주요 컬럼 |
|---|---|---|
| `source_snapshots` | 소스별 순위 JSON | `id` (text PK), `payload` (jsonb), `expires_at`, `updated_at` |
| `dashboard_snapshots` | 대시보드 전체 스냅샷 1행 | `id` (text PK, 고정 `latest`), `payload` (jsonb), `updated_at` |

- Supabase 미설정 시: 기존 `.cache/rankings` + 메모리 Map으로 동일 동작 (폴백).

## Logic

- 수집기는 계속 서점을 긁는다.
- 수집 성공 시 `source_snapshots` + `dashboard_snapshots`에 upsert.
- `/api/dashboard`는 **강제 refresh가 아니면** 최신 `dashboard_snapshots`를 우선 반환 (있으면 스크래핑 대기 없음).
- 스냅샷이 없거나 강제 refresh면 기존처럼 수집 후 저장.

## 수집 주기 (원본 갱신 텀 반영)

- 실시간 소스: **60분**
- 일간·주간·월간 등 일반 소스: **6시간**

## 오늘의 성공 기준

`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`가 있으면 수집 후 Supabase에 행이 생기고, 서버를 재시작한 뒤 `/`를 열었을 때 **전수 재수집을 기다리지 않고** 직전 스냅샷이 보이면 OK.  
키 없으면 `.cache/rankings/dashboard-latest.json` 파일 스냅샷으로 동일 흐름이 동작하면 OK (`/api/health`의 `hasDashboardSnapshot: true`, 두 번째 `/api/dashboard`의 `cacheState: "file"`).
