# Vercel 배포

회사 AX 가이드가 지정한 배포 방식(`/42-deploy`)에 맞춘 절차. Render는 필요 없다.

## 왜 구조를 바꿨나

Book Radar는 원래 상시 실행되는 Node HTTP 서버였다. Vercel 함수에는 상시 프로세스가
없어서 `setInterval` 수집기가 아예 돌지 않고, 파일 시스템도 읽기 전용이다.

바뀐 것:

- `server.js`가 요청 핸들러를 `handleRequest`로 내보내고, `require.main` 가드를 둬서
  직접 실행할 때만 리스너를 연다. 로컬·Render는 그대로 `npm start`로 돈다.
- `api/index.js`가 그 핸들러를 Vercel 서버리스 함수로 내보낸다.
- `VERCEL` 환경변수가 있으면 파일 캐시를 건너뛴다. 저장은 Supabase만 쓴다.
- 수집을 `POST/GET /api/collect`로 밖에서 부를 수 있게 했다. 서버리스에는
  `setInterval`이 없으므로 스케줄은 크론이 들고 있어야 한다.

## 크론: 플랜에 따라 갈린다

| | 크론 최소 주기 | 함수 실행 시간 |
|---|---|---|
| Hobby | **하루 1회** | 300초 |
| Pro | 1분 | 300초 (확장 시 최대 1800초) |

전수 수집은 40초 안에 끝나므로 **실행 시간은 어느 플랜에서도 문제가 없다.**
문제는 주기다. Hobby에서 `10 * * * *` 같은 매시 표현식은 **배포 자체가 실패**한다
(`Hobby accounts are limited to daily cron jobs`).

### 기본값: GitHub Actions (플랜 무관)

`vercel.json`에 `crons`를 **넣지 않았다.** 매시 표현식은 Hobby에서 배포를 실패시키므로,
플랜을 모르는 상태에서 첫 배포가 깨지지 않게 하는 쪽을 골랐다. 스케줄은 이미 들어 있는
`.github/workflows/collect.yml`이 맡는다 — Hobby·Pro 모두 동작한다.

설정할 것:

1. 리포 **Settings → Secrets and variables → Actions**
   - 시크릿 `COLLECT_SECRET`: 아무 긴 임의 문자열
   - 변수 `DASHBOARD_BASE_URL`: 배포된 주소 — 지금은 `https://book-dashboard-gilt.vercel.app`
2. Vercel 환경변수에도 같은 값으로 `COLLECT_SECRET`을 넣는다.

GitHub Actions 크론도 정시에 딱 맞지는 않는다(수 분 지연). 순위가 시간 단위로
바뀌므로 실용상 문제는 없다.

### Pro 플랜이라면 Vercel Cron으로 바꿔도 된다

Pro는 분 단위 크론이 되므로 GitHub Actions 없이 Vercel이 직접 부를 수 있다.
`vercel.json`에 아래를 넣고 환경변수 `CRON_SECRET`을 설정하면 Vercel이
`Authorization: Bearer`로 보내 준다. 그 뒤 워크플로 파일은 지운다.

```json
"crons": [
  { "path": "/api/collect?scope=realtime", "schedule": "10 * * * *" },
  { "path": "/api/collect?scope=all", "schedule": "20 */6 * * *" }
]
```

Hobby에서 이걸 넣으면 `Hobby accounts are limited to daily cron jobs` 로 배포가 실패한다.

## 환경변수

Vercel **Settings → Environment Variables**에 넣는다.

| 이름 | 값 | 용도 |
|---|---|---|
| `SUPABASE_URL` | `https://zodrgrrywbzfdlziiwif.supabase.co` | 스냅샷·순위 이력 저장소 |
| `SUPABASE_SERVICE_ROLE_KEY` | 로컬 `.env`의 `sb_secret_...` | 같음 |
| `COLLECT_SECRET` 또는 `CRON_SECRET` | 임의의 긴 문자열 | 수집 트리거 인증 |

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

# 첫 수집을 손으로 한 번 돌린다(크론을 기다리지 않아도 된다)
curl -s -H "Authorization: Bearer $COLLECT_SECRET" "$BASE/api/collect?scope=all"
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
- Render를 함께 돌리면 두 쪽이 Supabase의 같은 스냅샷 행에 쓴다. 나중에 수집한 쪽이
  이긴다. **한쪽만 수집하게** 두는 편이 낫다.
