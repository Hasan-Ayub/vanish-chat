-- Vanish Chat — Supabase schema for server-side accounts, chats, messages and media.
-- Run this once in your Supabase project's SQL Editor.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- accounts
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (char_length(username) between 3 and 32),
  salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- chats
create table if not exists public.chats (
  id text primary key,
  user_1 uuid not null references public.profiles(id) on delete cascade,
  user_2 uuid not null references public.profiles(id) on delete cascade,
  peer_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_1 <> user_2)
);

create index if not exists chats_user_1_idx on public.chats (user_1);
create index if not exists chats_user_2_idx on public.chats (user_2);

-- ---------------------------------------------------------------- messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'image', 'video')),
  body text,
  media_id text,
  media_path text,
  media_chunks integer not null default 0,
  media_name text,
  media_mime text,
  media_size bigint,
  sender_name text,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Upgrade tables created by the older optional schema.
alter table public.chats add column if not exists peer_name text;
alter table public.messages add column if not exists sender_name text;
alter table public.messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.messages add column if not exists media_id text;
alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_chunks integer not null default 0;
alter table public.messages add column if not exists media_name text;
alter table public.messages add column if not exists media_mime text;
alter table public.messages add column if not exists media_size bigint;

create index if not exists messages_chat_created_idx on public.messages (chat_id, created_at);
create index if not exists messages_expiry_idx on public.messages (expires_at);
create index if not exists messages_sender_idx on public.messages (sender_id);
create index if not exists messages_recipient_idx on public.messages (recipient_id);

-- The app sends the signed-in user's id as x-vanish-user on every request.
create or replace function public.vanish_user_id() returns text
language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-vanish-user', '');
$$;

alter table public.profiles enable row level security;
alter table public.chats enable row level security;
alter table public.messages enable row level security;

-- Profiles must be readable so a device can look up a username/password hash
-- and resolve peer names. The anon key is public; see the README caveat.
drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles for select using (true);

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles for insert with check (true);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update
  using (id::text = public.vanish_user_id())
  with check (id::text = public.vanish_user_id());

-- ------------------------------------------------------------------ chats
drop policy if exists "chats_read_participants" on public.chats;
create policy "chats_read_participants" on public.chats for select
  using (user_1::text = public.vanish_user_id() or user_2::text = public.vanish_user_id());

drop policy if exists "chats_insert_self" on public.chats;
create policy "chats_insert_self" on public.chats for insert
  with check (user_1::text = public.vanish_user_id() or user_2::text = public.vanish_user_id());

drop policy if exists "chats_update_participants" on public.chats;
create policy "chats_update_participants" on public.chats for update
  using (user_1::text = public.vanish_user_id() or user_2::text = public.vanish_user_id())
  with check (user_1::text = public.vanish_user_id() or user_2::text = public.vanish_user_id());

-- --------------------------------------------------------------- messages
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

-- ------------------------------------------------------------------- media
-- Public bucket so recipients can fetch chunks without a signed URL. Object
-- paths are {sender-id}/{media-id}/{part}, and writes are RLS-scoped to that
-- first folder.
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

drop policy if exists "media_read" on storage.objects;
create policy "media_read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'media');

drop policy if exists "media_insert_own_folder" on storage.objects;
create policy "media_insert_own_folder" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = public.vanish_user_id());

drop policy if exists "media_delete_own_folder" on storage.objects;
create policy "media_delete_own_folder" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = public.vanish_user_id());

-- ----------------------------------------------------------------- cleanup
-- The app deletes expired rows while it is open. Schedule this function with
-- Supabase Cron (pg_cron) to guarantee expiry even when nobody is online.
create or replace function public.delete_expired_messages() returns integer
language plpgsql security definer as $$
declare removed integer;
begin
  delete from public.messages where expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;
