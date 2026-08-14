-- StateArk v0.2 — artifact bundles
create table if not exists public.stateark_artifacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null references public.stateark_projects(id) on delete cascade,
  savepoint_id uuid not null references public.stateark_savepoints(id) on delete cascade,
  name text not null,
  kind text not null default 'other' check (kind in ('code','prompt','document','schema','config','archive','image','data','other')),
  mime_type text,
  storage_path text,
  text_content text,
  size_bytes bigint,
  sha256 text,
  status text not null default 'stored' check (status in ('stored','pending')),
  note text,
  created_at timestamptz not null default now(),
  unique(savepoint_id, name)
);

create index if not exists stateark_artifacts_savepoint_idx
  on public.stateark_artifacts(savepoint_id, created_at);
create index if not exists stateark_artifacts_project_idx
  on public.stateark_artifacts(project_id, created_at desc);

alter table public.stateark_artifacts enable row level security;

-- Private bucket. StateArk accesses it only server-side with the server-side Secret key.
insert into storage.buckets (id, name, public)
values ('stateark-artifacts', 'stateark-artifacts', false)
on conflict (id) do update set public = false;
