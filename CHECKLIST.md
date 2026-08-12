# 지금 할 일 (saas-prd-v1)

## 1. Supabase 스키마
1. https://supabase.com 에서 프로젝트 생성
2. SQL Editor → `supabase/schema.sql` 내용 붙여넣기 → Run
3. Settings → API 에서 Project URL / `service_role` 복사

## 2. .env 연결
프로젝트 루트에 `.env` 파일 생성:

```
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

서버 재시작: `npm start`  
로그에 `[storage] supabase=enabled` 가 보이면 OK.

## 3. 성공 기준 확인
```
curl http://localhost:3000/api/health
curl http://localhost:3000/landing
curl "http://localhost:3000/api/dashboard?refresh=all"
curl http://localhost:3000/api/dashboard
```

- health 에 `storage.supabase: true`, `hasDashboardSnapshot: true`
- 두 번째 dashboard 호출의 `cacheState` 가 `supabase` (또는 키 없을 때 `file`)
- `/landing` 200, CTA로 `/` 이동

키를 채팅에 붙여넣으면(또는 `.env`만 채워 두면) 2~3번을 대신 확인해 줄 수 있습니다.
