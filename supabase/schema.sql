-- Book Radar v1 schema
-- Supabase SQL Editor에서 실행

create table if not exists public.source_snapshots (
  id text primary key,
  payload jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.dashboard_snapshots (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- 서버(service role)만 쓰도록 RLS 켜 두고, 정책은 서비스 롤이 우회합니다.
alter table public.source_snapshots enable row level security;
alter table public.dashboard_snapshots enable row level security;
