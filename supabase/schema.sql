-- Posie: run this once in Supabase → SQL Editor.
-- Every user can only ever see and change their own pins (Row Level Security).

create table if not exists public.pins (
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  image_path  text,
  deleted     boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.pins enable row level security;

create policy "pins: read own"   on public.pins for select using (auth.uid() = user_id);
create policy "pins: add own"    on public.pins for insert with check (auth.uid() = user_id);
create policy "pins: change own" on public.pins for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pins: delete own" on public.pins for delete using (auth.uid() = user_id);

-- Private bucket for the pictures, one folder per user: pins/<user id>/<pin id>
insert into storage.buckets (id, name, public)
values ('pins', 'pins', false)
on conflict (id) do nothing;

create policy "images: read own" on storage.objects for select
  using (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "images: add own" on storage.objects for insert
  with check (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "images: change own" on storage.objects for update
  using (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "images: delete own" on storage.objects for delete
  using (bucket_id = 'pins' and (storage.foldername(name))[1] = auth.uid()::text);
