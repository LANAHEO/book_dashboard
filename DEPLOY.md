# 배포

Book Radar는 두 부분으로 나뉘어 따로 배포된다.

| 무엇 | 어디서 | 어떻게 올라가나 |
|---|---|---|
| 화면(대시보드) | Vercel | `main`에 push |
| **순위 수집기** | **상상스퀘어 EKS** (`ssq-eks`, 네임스페이스 `external`) | **`deploy/collector` 브랜치에 push** |

화면 쪽 절차·환경변수·겪은 고장은 [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md),
수집기 쪽 상세(AWS 준비, 권한, 파드 구성)는 [deploy/collector/README.md](deploy/collector/README.md)가 들고 있다.
이 문서는 그 앞에서 알아 둘 것만 적는다.

라이브: <https://book-dashboard-gilt.vercel.app/>

## 화면은 어떻게 올라가는가

`main`에 푸시하면 Vercel이 자동 배포한다. 손으로 올릴 때는

```bash
vercel --prod
```

빌드 단계가 없고 설치할 의존성도 없다. 그래서 Vercel 프로젝트의 Framework
Preset은 **Other**이고 빌드 관련 칸은 모두 비워 둔다 — 여기에 무언가 적으면
없는 빌드를 기다리다 실패한다.

## 수집기는 상상스퀘어 EKS에서 돈다 (2026-11 변경)

**바뀐 것:** 순위 수집은 더 이상 Vercel·GitHub Actions에서 하지 않는다. 상상스퀘어 EKS
클러스터의 파드 하나(`external/book-collector`)가 5분마다 교보·예스24·알라딘을 모아
Supabase에 남긴다. 화면(Vercel)은 Supabase에 저장된 값을 읽기만 한다.

옮긴 이유는 두 가지다.

- Vercel 무료 CPU 한도를 수집이 다 써서 2026-11-06에 배포가 통째로 멈췄다.
- 알라딘은 해외 접속을 막아 GitHub Actions(미국)에서는 받을 수 없다. EKS는 서울이라 세 서점을 한 곳에서 받는다.

### 수집기 배포: `deploy/collector` 브랜치

`main`에 올린다고 수집기가 바뀌지 않는다. **배포할 커밋을 `deploy/collector` 브랜치로 옮겨야 나간다.**

```bash
git push origin main:deploy/collector      # main 의 지금 커밋을 수집기로 배포
```

그러면 `.github/workflows/deploy-collector.yml`이 이미지를 굽고 EKS의 파드를 갈아 끼운다
(Actions 탭 "수집기 EKS 배포"). AWS 키는 GitHub에 없다 — OIDC로 이 리포의 `deploy/collector`
브랜치만 배포 권한을 잠깐 빌리고, Supabase 키는 AWS SSM(`/book-collector/prod/env`)에서 가져온다.

수집 코드를 고쳤다면(`server.js`의 서점 파서, `scripts/collector.js`) 화면과 수집기가 같은
`server.js`를 쓰므로 `main`(화면)과 `deploy/collector`(수집기)에 둘 다 올린다.

### 수집이 이상하면: IT팀에 문의

화면의 순위가 오래 안 바뀌거나, 수집 시각이 멈춰 있거나, 특정 서점만 비어 있으면
**IT팀에 문의한다.** 클러스터와 로그는 IT팀이 관리한다. 문의할 때 아래를 같이 전하면 빠르다.

- 언제부터 이상했는지, 어느 서점·어느 목록인지
- 수집기 위치: 클러스터 `ssq-eks`, 네임스페이스 `external`, Deployment `book-collector`
- 로그: Grafana(`monitor.ssqworld.com`) → 데이터소스 **loki-prod** →
  `{namespace="external", container="collector"}`, 실패만 보려면 뒤에 `|= "✖ 실패"`

로그에는 회차마다 시작·끝, 서점별로 받은 목록 수, 실패한 목록과 이유가 한국 시간으로 찍힌다.
읽는 법은 [deploy/collector/README.md "돌고 있는지 보기"](deploy/collector/README.md#돌고-있는지-보기)에 있다.

### 전환 상태

| 날짜 | 상태 |
|---|---|
| 2026-11-13 | EKS 수집기 배포. **dry-run**(서점은 실제로 받되 Supabase에는 안 씀)으로 기존 GitHub Actions 수집기와 나란히 돌며 확인 중 |
| (다음) | Actions 수집기(`collect.yml`) 끄고 EKS를 `COLLECT_DRY_RUN=0`으로 — 이때부터 EKS가 유일한 수집기 |
| (다음) | Vercel의 수집 경로(`/api/collect-rows`, `/api/collect`) 정리 |

순서를 지킨다. 두 곳이 동시에 쓰면 순위 이력이 두 번 쌓여 ▲▼ 비교가 엉킨다 — Actions를 먼저 끄고 EKS 쓰기를 켠다.

## 저장은 Supabase만 쓴다

`VERCEL` 환경변수가 있으면 파일 캐시를 건너뛴다. 함수의 파일 시스템은 읽기
전용이고 호출마다 날아가므로, `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`가
없으면 수집한 순위가 남지 않는다.

값이 실제로 붙는지는 이렇게 확인한다.

```bash
node scripts/check-env.js --live
curl -s https://book-dashboard-gilt.vercel.app/api/health   # supabase: true 여야 한다
```

## 로컬 실행

### 화면

```powershell
npm start
```

또는 `start-dashboard.cmd`. <http://localhost:3000>에서 뜬다.

### 수집기 (개발·확인용)

서점 파서나 수집 로직을 고쳤으면 배포 전에 로컬에서 돌려 본다. Node 20 이상만 있으면 된다.

```bash
npm run collect:once   # 한 회차만 돌고 끝낸다 — 고친 뒤 확인은 이걸로
npm run collect:dry    # 5분마다 계속 돈다(Ctrl+C 로 끈다)
```

- **기본이 dry-run이다.** 서점은 실제로 받지만 Supabase에는 쓰지 않는다. `.env`에 Supabase 키가
  있으면 읽기만 한다. 로컬에서 실수로 운영 데이터를 덮어쓰지 않게 `.env`에 `COLLECT_DRY_RUN=0`을
  적어 두어도 무시한다.
- 로컬은 한국 IP라 알라딘도 받아진다.
- 받은 목록은 `.cache/rankings/*.json`에 남는다. 파서 결과는 여기서 본다.
- 출력은 EKS 로그와 같은 형식이다 — `✔ 회차 끝`, `서점 교보 86/86 …`, 실패하면 `✖ 실패 …` 줄.
- 한국 시간 03·09·15·21시대에 시작하면 일간·주간까지 받는 전수 수집(1~2분)이 되고, 그 외에는 실시간만 받는다.

배포될 이미지 그대로 돌려 보려면 [deploy/collector/README.md](deploy/collector/README.md#로컬에서-작업하기)의 `docker` 명령을 쓴다.

## 런타임 요구사항

- Node.js 20 이상
- 설치할 의존성 없음 (`npm install`은 빌드 단계를 만족시키려고 있을 뿐이다)
- `0.0.0.0`에 붙고 `PORT` 환경변수를 따른다
- 헬스체크 경로: `/api/health`

## 커스텀 도메인

Vercel 프로젝트 **Settings → Domains**에 도메인을 추가하고, Vercel이 알려 주는
대상으로 DNS 레코드를 가리킨다.

## 예전 플랫폼에서 남은 파일

`Dockerfile`, `.dockerignore`, `render.yaml`은 Render에 올리던 시절 파일이다.
지금은 아무것도 이 파일들을 읽지 않고, `.vercelignore`가 함수 번들에서도 빼
두므로 배포에 영향은 없다. 같은 이유로 `CLOUDFLARE_TUNNEL_SETUP.md`(내 PC를
터널로 공개하는 방법)도 지금 쓰는 방식이 아니다.
