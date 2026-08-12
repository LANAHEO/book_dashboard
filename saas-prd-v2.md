# Book Radar (고도화) — saas-prd-v2.md

각 항목은 독립적으로 추가 가능합니다. 한 번에 하나만 얹을 것.

- **노출 전용 API 분리** — `/api/dashboard`는 읽기만, 수집은 `/api/collect` 또는 스케줄러 전용으로 분리
- **스냅샷 신선도 배지** — UI에 “N분 전 수집” / 서점 `sourceStamp` 표시 강화
- **수집 실패 알림** — 연속 실패 시 화면 경고 또는 웹훅
- **Supabase RLS·anon 키 읽기** — service role 없이 프론트/엣지에서 스냅샷만 읽기
- **Vercel 정적 랜딩 + API 프록시** — `/landing`은 Vercel, 수집기는 Render 유지
- **대시보드 design.md 전면 적용** — Pretendard·필 CTA·flat chrome으로 본체 UI 리디자인
- **상상스퀘어 알림 구독** — 특정 책이 TOP N 진입 시 슬랙/메일
- **히스토리 차트** — 일자별 순위 변화 저장·그래프 (별도 `rank_history` 테이블)
- **수집 동시성·호스트 제한 튜닝** — 차단 리스크 줄이기
- **수동 refresh 권한** — 내부용 refresh 토큰/버튼
