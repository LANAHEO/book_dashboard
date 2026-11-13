# Vercel 배포

회사 AX 가이드가 지정한 배포 방식(`/42-deploy`)에 맞춘 절차. Render는 필요 없다.

## 왜 구조를 바꿨나

Book Radar는 원래 상시 실행되는 Node HTTP 서버였다. Vercel 함수에는 상시 프로세스가
없어서 `setInterval` 수집기가 아예 돌지 않고, 파일 시스템도 읽기 전용이다.

바뀐 것:

- `server.js`가 요청 핸들러를 `handleRequest`로 내보내고, `require.main` 가드를 둬서
  직접 실행할 때만 리스너를 연다. 로컬은 그대로 `npm start`로 돈다.
- `api/index.js`가 그 핸들러를 Vercel 서버리스 함수로 내보낸다.
- `VERCEL` 환경변수가 있으면 파일 캐시를 건너뛴다. 저장은 Supabase만 쓴다.
- 수집을 `POST/GET /api/collect`로 밖에서 부를 수 있게 했다. 서버리스에는
  `setInterval`이 없으므로 스케줄은 크론이 들고 있어야 한다.

## 수집: 누가 무엇을 모으나

> **2026-11 변경:** 수집은 상상스퀘어 EKS(`external/book-collector`)로 옮기는 중이다.
> 배포 방법과 전환 상태는 [DEPLOY.md "수집기는 상상스퀘어 EKS에서 돈다"](DEPLOY.md)를 본다.
> 아래는 전환이 끝나기 전까지 실제로 Supabase에 쓰고 있는 기존 구조다.

**Vercel은 화면 요청으로는 수집하지 않는다.** 서점에 가는 것은 GitHub Actions가 인증을 붙여
`/api/collect-rows`를 부를 때(알라딘만)뿐이고, 스냅샷은 어떤 경우에도 쓰지 않는다.

2026-11-06에 Vercel이 배포를 통째로 멈췄다(`402 DEPLOYMENT_DISABLED`). Hobby 무료 한도인
Active CPU 4시간을 수집이 6시간 25분 써서다. 원인은 두 가지였다.

- `/api/collect`가 스냅샷을 다시 만들 때마다 목록 230여 개를 서점에서 전부 다시 받았다
  (서버리스는 메모리가 비어 있어서). 지금은 저장된 값이 유효하면 그걸 쓴다.
- 화면이 열려 있는 동안 탭마다 5분에 한 번 `?refresh=quick`으로 서점을 돌게 했다.
  지금 화면은 저장된 값만 읽는다.

알라딘은 해외 접속을 CloudFront에서 막는다 — GitHub Actions 러너(미국)에서 시험하니
교보 59/59·예스24 84/84는 받아졌고 알라딘은 91/91이 403이었다. Vercel(서울, icn1)에서는 받아진다.

| 어디서 | 무엇을 | 설정 |
|---|---|---|
| GitHub Actions (`collect.yml` → `scripts/collector.js`) | 교보·예스24 수집, **스냅샷 작성(유일)**, 회차마다 Vercel에 알라딘 수집 요청 | 워크플로에 `COLLECT_STORES=kyobo,yes24`, `VERCEL_COLLECT_STORES=aladin` |
| Vercel (`/api/collect-rows?store=aladin`) | 알라딘·상상스퀘어 신간 목록 수집, 목록 행만 저장 | 설정 없음 — 그 요청 동안만 알라딘을 맡는다(`AsyncLocalStorage`). 화면 요청은 여전히 읽기만 |
| PC 로컬 서버 (`npm start`) | 보기만(로컬 화면) | `.env`에 `COLLECT_STORES=none`, `SNAPSHOT_WRITER=0` |

알라딘을 처음에는 PC가 맡았는데, 그러면 PC를 끄는 순간 알라딘만 멈췄다. 알라딘만 받는 CPU를
재 보니(평소 확인 0.03초, 순위가 바뀐 회차 0.9초, 6시간마다 전수 5.5초; 알라딘 실시간은 한 시간에
한 번쯤 바뀐다) 한 달 1~2시간이라 Hobby 한도(4시간) 안에서 Vercel에 맡겼다.

스냅샷을 쓰는 곳은 하나여야 한다. 둘이 쓰면 순위 이력이 몇 분 간격으로 두 번 남아
▲▼ 비교 기준이 "방금"으로 당겨진다. Actions 수집기는 회차마다 Vercel이 남긴 알라딘 행이
바뀌었는지 보고(`payload.updatedAt`만 받아 본다), 바뀌었으면 스냅샷에 싣는다.

### GitHub에 넣을 것

리포 **Settings → Secrets and variables → Actions**

- 시크릿 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: 로컬 `.env`와 같은 값
- 시크릿 `COLLECT_SECRET`: Vercel 환경변수 `COLLECT_SECRET`과 같은 값(알라딘 수집 요청 인증)
- 변수 `DASHBOARD_BASE_URL`: 배포 주소. 알라딘 수집 요청과 순위 대조 검사가 쓴다.

`/api/collect`(전체 수집 + 스냅샷)는 Vercel에서 409로 거절한다.

### 주기

Actions 수집기는 시계의 5분 경계 + 60초(:01 :06 …)에 돈다. 회차마다 먼저 Vercel에 알라딘을
받게 하고, 이어서 교보·예스24를 받은 뒤 스냅샷을 만든다. 전수 수집은 UTC 00·06·12·18시.
값은 `server.js`의 `COLLECT_INTERVAL_MINUTES` 하나다.

Hobby 크론은 하루 1회라 쓰지 않는다. GitHub 예약도 정시를 지키지 않아서, 한 번 뜬 실행이
330분 동안 살아 있으며 스스로 5분마다 돌고 끝날 때 다음 실행을 띄운다(`collect.yml` 설명).

## 환경변수

Vercel **Settings → Environment Variables**에 넣는다.

| 이름 | 값 | 용도 |
|---|---|---|
| `SUPABASE_URL` | `https://zodrgrrywbzfdlziiwif.supabase.co` | 스냅샷·순위 이력 저장소 |
| `SUPABASE_SERVICE_ROLE_KEY` | 로컬 `.env`의 `sb_secret_...` | 같음 |

`SUPABASE_URL`은 **API 주소**여야 한다. 브라우저 대시보드 주소
(`supabase.com/dashboard/project/...`)를 넣으면 연결이 조용히 실패한다 — 실제로 한 번
겪었다. `node scripts/check-env.js --live`로 확인할 수 있다.

## 배포

```bash
npm i -g vercel
vercel login          # 브라우저 인증
vercel link           # 프로젝트 연결
vercel --prod
```

또는 Vercel 대시보드에서 GitHub 리포(`LANAHEO/book_dashboard`)를 임포트하면
푸시마다 자동 배포된다. 빌드 설정은 비워 둔다 — 빌드 단계가 없고 의존성도 없다.

## 배포 후 확인

```bash
BASE=https://<배포주소>

curl -s "$BASE/api/health"        # supabase: true 여야 한다
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/"         # 200
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/landing"  # 200

# Vercel 은 수집하지 않는다. 첫 수집은 Actions 의 "순위 수집" 워크플로를 scope=all 로 손으로 돌린다.
```

`/api/health`의 `supabase`가 `false`면 `supabaseError`에 이유가 적혀 있다.

## 겪은 고장과 원인

### 전 경로 500 · FUNCTION_INVOCATION_FAILED

Vercel의 서비스 감지가 `api/index.js`가 아니라 **`server.js`를 그대로 함수 진입점으로**
잡는다(빌드 산출물 `server.cjs`). 그때 `module.exports`가 객체면 런타임 로그에

```
Invalid export found in module "/var/task/server.cjs".
The default export must be a function or server.
```

가 찍히고 람다가 부팅조차 못 한다. 그래서 `api/index.js`의 오류 리포터가 실행될 기회가
없어 Vercel의 일반 오류 페이지만 보인다 — 우리 코드가 돌지 않으므로 원인이 응답에
안 나온다. `server.js`는 요청 핸들러를 **기본 내보내기**로 두고 이름 있는 내보내기는
속성으로 남긴다.

구분법: 정적 파일(`/app.js`, `/styles.css`, `/landing`)은 200인데 함수 경로는 전부
500이고, 인증만 보는 `/api/collect`까지 죽는다면 라우팅 전에 죽은 것이다.

### 화면은 뜨는데 저장이 안 됨 (`supabase: false`)

`SUPABASE_URL`에 브라우저 대시보드 주소
(`https://supabase.com/dashboard/project/<ref>`)를 넣은 경우. 그 주소는 Vercel에
호스팅돼 있어서 `/rest/v1/...` 요청이 **Vercel의 404 HTML**로 돌아온다. 키는 멀쩡하다.
`/api/health`가 이제 바꿀 값을 직접 알려 준다:

```
SUPABASE_URL이 대시보드 주소입니다. API 주소로 바꾸세요 → https://<ref>.supabase.co
```

`.env.bak`에 이 틀린 값이 남아 있으니 거기서 복사하지 말 것.

## 남는 것

- 수집 주기를 정시에 맞추지 않았다. 스케줄러가 프로세스 시작 시점부터 세는 구조라
  `:41` 같은 시각에 돈다. 서점은 정시 몇 분 뒤 갱신하므로 최대 40분 늦게 반영된다.
  크론으로 옮기면 `10 * * * *`처럼 고정되어 이 지연이 사라진다.
- 수집하는 쪽이 둘이 되면 Supabase의 같은 스냅샷 행에 둘이 쓰고, 나중에 수집한 쪽이
  이긴다. 예전에 Render와 Vercel을 함께 돌리다 겪은 일이다. 지금은 Vercel 하나만
  쓰지만, 로컬 서버를 띄워 둔 채 크론이 돌면 같은 일이 생긴다 — **한쪽만 수집하게**
  둔다.
