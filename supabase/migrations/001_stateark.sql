create extension if not exists pgcrypto;

create table if not exists public.stateark_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  slug text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, slug)
);

create table if not exists public.stateark_savepoints (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null references public.stateark_projects(id) on delete cascade,
  version_major integer not null default 0,
  version_minor integer not null default 1,
  version_label text generated always as ('v' || version_major::text || '.' || version_minor::text) stored,
  title text,
  checkpoint_type text not null default 'minor' check (checkpoint_type in ('minor','major')),
  state jsonb not null,
  rendered_markdown text not null,
  source_platform text,
  created_at timestamptz not null default now(),
  unique(project_id, version_major, version_minor)
);

create index if not exists stateark_projects_owner_idx on public.stateark_projects(owner_id, updated_at desc);
create index if not exists stateark_savepoints_project_idx on public.stateark_savepoints(project_id, version_major desc, version_minor desc);

alter table public.stateark_projects enable row level security;
alter table public.stateark_savepoints enable row level security;

-- v0.1 server uses the server-side Secret key server-side and filters every query by STATEARK_OWNER_ID.
-- Do not expose the server-side Secret key to browsers or MCP clients.
