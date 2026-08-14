-- StateArk v0.4 - cloud mirror hardening.
-- Safe to run on top of 001 and 002. Idempotent.

-- 1. The v0.3 sync path did delete-then-insert on artifacts, which leaves the
--    cloud copy empty if the process dies in between. v0.4 upserts instead.
--    That requires the unique key from 002 to actually exist:
create unique index if not exists stateark_artifacts_savepoint_name_key
  on public.stateark_artifacts (savepoint_id, name);

-- 2. Deny-by-default is already in effect (RLS on, no policies), which means
--    anon/publishable keys can read nothing. Make that explicit so a future
--    "just add a policy" change cannot silently open everything.
comment on table public.stateark_projects   is 'StateArk cloud mirror. Server-side secret key only. No RLS policies = no client access.';
comment on table public.stateark_savepoints is 'StateArk cloud mirror. Server-side secret key only. No RLS policies = no client access.';
comment on table public.stateark_artifacts  is 'StateArk cloud mirror. Server-side secret key only. No RLS policies = no client access.';

-- 3. updated_at on projects was only ever written by the client. Keep it honest.
create or replace function public.stateark_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists stateark_projects_touch on public.stateark_projects;
create trigger stateark_projects_touch
  before update on public.stateark_projects
  for each row execute function public.stateark_touch_updated_at();

-- 4. Storage bucket. If you changed STATEARK_STORAGE_BUCKET in .env,
--    change the id here to match, or the upload will fail at runtime.
insert into storage.buckets (id, name, public)
values ('stateark-artifacts', 'stateark-artifacts', false)
on conflict (id) do update set public = false;

-- NOTE: this mirror is encrypted at rest by Supabase but is NOT end-to-end
-- encrypted. Do not market the Pro tier as zero-knowledge until client-side
-- encryption happens before upload.
