-- revu's push device registry (LLP 0009). Run once in the Supabase SQL editor.
-- Only the service-role key touches this table (from the exchange's routes);
-- row-level security stays on with no policies, so the anon key sees nothing.
create table if not exists public.revu_devices (
  token      text primary key,
  login      text not null,
  bundle     text not null default 'dev.donadel.revu',
  updated_at timestamptz not null default now()
);
create index if not exists revu_devices_login on public.revu_devices (lower(login));
alter table public.revu_devices enable row level security;
