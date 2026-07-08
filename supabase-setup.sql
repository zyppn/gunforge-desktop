-- GUNFORGE online market backend (Supabase)
-- Run this in your project's SQL editor, then paste your project URL and anon key
-- into the BACKEND object near the top of gunforge3d.html's script.

create table if not exists public.gunforge_kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.gunforge_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists gunforge_kv_touch on public.gunforge_kv;
create trigger gunforge_kv_touch before update on public.gunforge_kv
  for each row execute function public.gunforge_touch();

alter table public.gunforge_kv enable row level security;

-- Demo-grade policies: any visitor can read and write the shared market keys.
-- Fine for a playtest economy; NOT production-secure (see README for the hardening path).
create policy "gunforge anon read"   on public.gunforge_kv for select to anon using (true);
create policy "gunforge anon insert" on public.gunforge_kv for insert to anon with check (true);
create policy "gunforge anon update" on public.gunforge_kv for update to anon using (true) with check (true);
