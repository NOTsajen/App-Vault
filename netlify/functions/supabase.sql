-- Run this ONCE in Supabase > SQL Editor > New query > Run.
create table if not exists apps (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  tagline text check (char_length(tagline) <= 100),
  description text check (char_length(description) <= 2000),
  kind text not null default 'app' check (kind in ('app','game','website')),
  url text not null check (url ~* '^https?://' and char_length(url) <= 500),
  dev text check (char_length(dev) <= 40),
  icon text check (icon is null or icon ~* '^https://'),
  shots text[] not null default '{}' check (cardinality(shots) <= 6),
  created_at timestamptz not null default now()
);
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references apps(id) on delete cascade,
  device text not null,
  name text check (char_length(name) <= 40),
  stars int not null check (stars between 1 and 5),
  body text check (char_length(body) <= 600),
  created_at timestamptz not null default now(),
  unique (app_id, device)
);
alter table apps enable row level security;
alter table reviews enable row level security;
create policy "anyone reads apps" on apps for select using (true);
create policy "anyone adds apps" on apps for insert with check (true);
create policy "anyone reads reviews" on reviews for select using (true);
create policy "anyone adds reviews" on reviews for insert with check (true);
create or replace view app_stats as
  select app_id, round(avg(stars)::numeric, 1) as avg, count(*) as n from reviews group by app_id;
grant select on app_stats to anon, authenticated;
-- screenshots + icons storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('shots', 'shots', true, 1500000, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;
create policy "anyone views shots" on storage.objects for select using (bucket_id = 'shots');
create policy "anyone uploads shots" on storage.objects for insert with check (bucket_id = 'shots');
