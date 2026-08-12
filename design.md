---
version: alpha
name: Book-Radar-design
description: |
  Nike commerce chrome을 Book Radar용으로 옮긴 규칙.
  사진·캠페인 타이포가 말하고, UI 크롬은 흑·백·소프트 그레이와 필 CTA만 쓴다.
  폰트는 Pretendard만 사용. 기울임체(italic)는 쓰지 않는다.

colors:
  primary: "#111111"
  on-primary: "#ffffff"
  canvas: "#ffffff"
  soft-cloud: "#f5f5f5"
  ink: "#111111"
  charcoal: "#39393b"
  mute: "#707072"
  stone: "#9e9ea0"
  hairline: "#cacacb"
  hairline-soft: "#e5e5e5"
  sale: "#d30005"
  success: "#007d48"
  kyobo: "#2d8b57"
  yes24: "#0080ff"
  aladin: "#ee7b00"

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
| ink / primary | `#111111` | CTA, 헤드라인, 활성 칩 |
| canvas | `#ffffff` | 페이지 배경, on-image CTA |
| soft-cloud | `#f5f5f5` | 보조 면, 서치/세컨더리 |
| mute | `#707072` | 보조 설명 |
| hairline | `#cacacb` | 구분선 |
| sale | `#d30005` | 경고/급등 신호만 |

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

## Landing application

- 경로: `/landing`
- CTA 목적지: 대시보드 `/` (또는 `/main`)
- 톤: 운동복 커머스가 아니라 **출판/순위 레이더** — 흑백 크롬은 유지, 카피는 책·순위 언어
