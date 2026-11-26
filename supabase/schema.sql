-- Vanish Chat — optional Supabase schema
-- Run this in your Supabase project's SQL Editor (one time).

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (char_length(username) between 3 and 32),
  salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'image', 'video')),
  body text,
  media_path text,
  media_name text,
  media_mime text,
  media_size bigint,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists messages_chat_created_idx on public.messages (chat_id, created_at);
create index if not exists messages_expiry_idx on public.messages (expires_at);

-- The app sends the signed-in user's id as x-vanish-user on every request.
create or replace function public.vanish_user_id() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-vanish-user', '');
$$;

alter table public.profiles enable row level security;
alter table public.messages enable row level security;

drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles for select using (true);

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles for insert with check (true);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update
  using (id::text = public.vanish_user_id())
  with check (id::text = public.vanish_user_id());

drop policy if exists "messages_read_participants" on public.messages;
create policy "messages_read_participants" on public.messages for select
  using (sender_id::text = public.vanish_user_id()
      or recipient_id::text = public.vanish_user_id());

drop policy if exists "messages_insert_self" on public.messages;
create policy "messages_insert_self" on public.messages for insert
  with check (sender_id::text = public.vanish_user_id());

drop policy if exists "messages_delete_participants" on public.messages;
create policy "messages_delete_participants" on public.messages for delete
  using (sender_id::text = public.vanish_user_id()
      or recipient_id::text = public.vanish_user_id());

-- Public media bucket for 24-hour images/videos.
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

drop policy if exists "media_read" on storage.objects;
create policy "media_read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'media');

drop policy if exists "media_insert_own_folder" on storage.objects;
create policy "media_insert_own_folder" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = public.vanish_user_id());

drop policy if exists "media_delete_own_folder" on storage.objects;
create policy "media_delete_own_folder" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = public.vanish_user_id());

-- Optional: run periodically (e.g. Supabase Cron) to delete expired rows even
-- when nobody is online. Media objects are removed by the app on purge.
create or replace function public.delete_expired_messages() returns integer
language plpgsql security definer as $$
declare removed integer;
begin
  delete from public.messages where expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;
