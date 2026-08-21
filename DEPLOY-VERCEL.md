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

### Pro 플랜이면

`vercel.json`의 `crons`가 그대로 동작한다. 환경변수 `CRON_SECRET`만 넣으면 Vercel이
`Authorization: Bearer` 헤더로 보내 준다. `.github/workflows/collect.yml`은 지워도 된다.

### Hobby 플랜이면

`vercel.json`에서 `crons` 블록을 **지워라**(두면 배포가 실패한다). 대신 이미 들어 있는
GitHub Actions 워크플로가 스케줄을 맡는다:

1. 리포 **Settings → Secrets and variables → Actions**
   - 시크릿 `COLLECT_SECRET`: 아무 긴 임의 문자열
   - 변수 `DASHBOARD_BASE_URL`: 배포된 주소 (예 `https://book-radar.vercel.app`)
2. Vercel 환경변수에도 같은 값으로 `COLLECT_SECRET`을 넣는다.

GitHub Actions 크론도 정시에 딱 맞지는 않는다(수 분 지연). 순위가 시간 단위로
바뀌므로 실용상 문제는 없다.

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

## 남는 것

- 수집 주기를 정시에 맞추지 않았다. 스케줄러가 프로세스 시작 시점부터 세는 구조라
  `:41` 같은 시각에 돈다. 서점은 정시 몇 분 뒤 갱신하므로 최대 40분 늦게 반영된다.
  크론으로 옮기면 `10 * * * *`처럼 고정되어 이 지연이 사라진다.
- Render를 함께 돌리면 두 쪽이 Supabase의 같은 스냅샷 행에 쓴다. 나중에 수집한 쪽이
  이긴다. **한쪽만 수집하게** 두는 편이 낫다.
