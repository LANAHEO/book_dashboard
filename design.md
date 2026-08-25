---
version: alpha
name: Book-Radar-design
description: |
  Nike commerce chrome을 Book Radar용으로 옮긴 규칙.
  사진·캠페인 타이포가 말하고, UI 크롬은 흑·백·소프트 그레이와 필 CTA만 쓴다.
  폰트는 Pretendard만 사용. 기울임체(italic)는 쓰지 않는다.

# 2026-08 리팔레트. 순검정(#111) + 순백 조합이 "칙칙하다"는 지적을 받아 바꿨다.
# 잉크는 파란기를 조금 넣어 무채색이 탁해 보이지 않게 하고, 바탕은 종이 톤으로
# 띄워 흰 카드가 분리되게 했다. 새 브랜드 색은 만들지 않았다 —
# 이 화면의 색은 교보·예스24·알라딘 세 서점이 담당한다.
colors:
  primary: "#181d2f"
  on-primary: "#ffffff"
  page: "#f3f5fa"
  canvas: "#ffffff"
  soft-cloud: "#edf1f8"
  ink: "#181d2f"
  charcoal: "#313a51"
  mute: "#59637a"
  stone: "#8a94aa"
  hairline: "#d6dce9"
  hairline-soft: "#e7ecf5"
  sale: "#d2264b"
  success: "#0a7d54"
  kyobo: "#12855c"
  yes24: "#2f6bff"
  aladin: "#e8720c"

typography:
  display-campaign:
    fontFamily: Pretendard
    fontSize: 72px
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: -0.02em
    fontStyle: normal
  heading-xl:
    fontFamily: Pretendard
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    fontStyle: normal
  heading-lg:
    fontFamily: Pretendard
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    fontStyle: normal
  body-md:
    fontFamily: Pretendard
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.55
    fontStyle: normal
  body-strong:
    fontFamily: Pretendard
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    fontStyle: normal
  button-md:
    fontFamily: Pretendard
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    fontStyle: normal
  caption-md:
    fontFamily: Pretendard
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.5
    fontStyle: normal
  caption-sm:
    fontFamily: Pretendard
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    fontStyle: normal

rounded:
  none: 0px
  md: 24px
  lg: 30px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 18px
  xl: 24px
  xxl: 30px
  section: 48px

components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: 16px 32px
    height: 48px
  button-secondary:
    backgroundColor: "{colors.soft-cloud}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: 16px 32px
    height: 48px
  button-outline-on-image:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: 12px 24px
  filter-chip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: 8px 16px
  filter-chip-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
---

## Overview

Book Radar는 Nike식 **에디토리얼 + 미니멀 커머스 크롬**을 따른다.

- 히어로는 브랜드명과 큰 헤드라인이 주인공
- UI는 `{colors.ink}` / `{colors.canvas}` / `{colors.soft-cloud}` 위주
- CTA는 필(`{rounded.full}`)만
- 카드 그림자·그라데이션 장식·보라 톤 금지
- **폰트: Pretendard만. italic 금지.**

## Hard rules

1. 모든 텍스트 `font-style: normal` (기울임 없음)
2. UI 폰트 패밀리: `"Pretendard", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
3. Primary CTA는 화면당 검정 필 하나
4. 제품/대시보드 카드는 그림자 없이 flat, 구분선은 `{colors.hairline}` 1px
5. 서점 액센트(`kyobo`/`yes24`/`aladin`)는 칩·뱃지에만, 본문/CTA 배경에 쓰지 않음

## Colors

| Token | Hex | Use |
|---|---|---|
| ink / primary | `#181d2f` | CTA, 헤드라인, 활성 칩 |
| page | `#f3f5fa` | 페이지 바탕 (카드를 띄우는 종이 톤) |
| canvas | `#ffffff` | 카드 면 |
| soft-cloud | `#edf1f8` | 보조 면, 서치/세컨더리 |
| mute | `#59637a` | 보조 설명 |
| hairline | `#d6dce9` | 구분선 |
| sale | `#d2264b` | 경고/급등 신호만 |

### 서점 색을 쓰는 자리

세 서점 색이 이 화면의 유일한 채도다. 쓰는 곳은 세 군데뿐이다.

1. 마스트헤드 상단 3분할 띠 — 장식이 아니라 "이 화면은 세 서점을 모은다"는 표시
2. 순위 칩 (`.focus-chip`) — 점 + 옅은 바탕, 같은 책의 서점별 노출을 색으로 가른다
3. 순위 타일 (`.focus-rank-metric`) — 옅은 바탕, 어느 서점 순위인지 먼저 읽히게

본문 텍스트·CTA 배경에는 여전히 쓰지 않는다. 색은 `--store-accent` 인라인 변수로
넘기고 실제 값은 `styles.css`의 토큰이 원본이다.

## Typography

| Token | Size | Weight | Use |
|---|---|---|---|
| display-campaign | 72px (mobile 40px) | 700 | 히어로 헤드라인 |
| heading-xl | 32px | 600 | 섹션 타이틀 |
| heading-lg | 24px | 600 | 서브 타이틀 |
| body-md | 16px | 400 | 본문 |
| body-strong | 16px | 600 | 강조 라벨 |
| button-md | 16px | 600 | 버튼 |
| caption-md | 14px | 500 | 메타 |

## Layout

- 기준 간격 8px, 섹션 간격 `{spacing.section}` 48px
- 콘텐츠 max-width ~1120px (랜딩), 대시보드는 더 넓게 유지 가능
- 히어로: full-bleed, 첫 뷰포트에 브랜드 + 헤드라인 1개 + 문장 1개 + CTA 그룹만

## Components

- `button-primary`: 검정 필
- `button-secondary`: soft-cloud 필
- `button-outline-on-image`: 흰 필 (이미지 위)
- `filter-chip` / `filter-chip-active`: 서점·기간 필터

## Do / Don't

### Do
- Pretendard만 사용
- 히어로에 Book Radar 브랜드를 크게
- 필 CTA, flat 카드, hairline 구분

### Don't
- italic / oblique
- Inter·Roboto·기본 시스템만으로 끝내지 말 것 (Pretendard CDN 로드)
- 보라 그라데이션, 크림+테라코타, 카드 그림자 스택
- 히어로에 통계 스트립·배지 오버레이 남발
- 순검정(#111) 슬래브로 화면 위쪽을 누르는 것 — 2026-08에 걷어냈다

## Landing application

- 경로: `/landing`
- CTA 목적지: 대시보드 `/` (또는 `/main`)
- 톤: 운동복 커머스가 아니라 **출판/순위 레이더** — 흑백 크롬은 유지, 카피는 책·순위 언어
