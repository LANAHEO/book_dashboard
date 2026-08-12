# Supabase 연결 (로컬)

1. [Supabase](https://supabase.com) 프로젝트 생성
2. SQL Editor에서 `supabase/schema.sql` 실행
3. Project Settings → API 에서 URL / `service_role` 키 복사
4. 프로젝트 루트에 `.env` 작성:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

5. `npm start` 후 수집이 돌면 Table Editor에 `source_snapshots`, `dashboard_snapshots` 행이 생깁니다.

`service_role` 키는 비밀입니다. 깃·채팅·스크린샷에 올리지 마세요. (`.gitignore`에 `.env` 포함됨)
