# 배포

Book Radar는 **Vercel에만 배포한다.** 다른 호스팅은 쓰지 않는다.

절차·환경변수·겪은 고장은 [DEPLOY-VERCEL.md](DEPLOY-VERCEL.md)가 들고 있다.
이 문서는 그 앞에서 알아 둘 것만 적는다.

라이브: <https://book-dashboard-gilt.vercel.app/>

## 어떻게 올라가는가

`main`에 푸시하면 Vercel이 자동 배포한다. 손으로 올릴 때는

```bash
vercel --prod
```

빌드 단계가 없고 설치할 의존성도 없다. 그래서 Vercel 프로젝트의 Framework
Preset은 **Other**이고 빌드 관련 칸은 모두 비워 둔다 — 여기에 무언가 적으면
없는 빌드를 기다리다 실패한다.

## 수집은 배포와 따로 돈다

서버리스 함수에는 상시 프로세스가 없어서 `setInterval` 수집기가 살 수 없다.
스케줄은 리포 안의 `.github/workflows/collect.yml`이 들고 있고, 배포된 주소의
`/api/collect`를 부른다.

`vercel.json`에는 `crons`를 넣지 않았다. Vercel Hobby의 크론은 하루 1회까지만
허용해서, 매시 표현식을 넣으면 배포 자체가 실패한다.

수집 주기는 서점이 순위를 갱신하는 주기에 맞췄다.

- 실시간 목록: 60분 (`REALTIME_REFRESH_MS`)
- 일간·주간·월간 목록: 6시간 (`STANDARD_REFRESH_MS`)

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

```powershell
npm start
```

또는 `start-dashboard.cmd`. <http://localhost:3000>에서 뜬다.

로컬은 상시 프로세스라 수집기가 그대로 돌고, Supabase 키가 없으면
`.cache/rankings`에 쌓는다 — 이 캐시는 재시작하면 사라진다.

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
