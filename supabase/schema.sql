-- Rotulado: tablas, reglas de privacidad y almacenamiento de fotos.
-- Cómo usarlo: Supabase → SQL Editor → New query → pega TODO este archivo → Run.
-- Se puede ejecutar más de una vez sin problema.

-- 1) Carpetas -------------------------------------------------------------
create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- 2) Imágenes (los rótulos y el progreso van en la columna "labels") --------
create table if not exists public.images (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  deck_id     uuid not null references public.decks(id) on delete cascade,
  title       text not null default '',
  path        text not null,            -- ruta de la foto en Storage
  width       int  not null,
  height      int  not null,
  labels      jsonb not null default '[]'::jsonb,
  label_size  real not null default 1,
  created_at  timestamptz not null default now()
);
create index if not exists images_deck_idx on public.images(deck_id);

-- 3) Privacidad: cada usuario ve y modifica SOLO lo suyo -------------------
alter table public.decks  enable row level security;
alter table public.images enable row level security;

drop policy if exists "decks: solo el dueño" on public.decks;
create policy "decks: solo el dueño" on public.decks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "images: solo el dueño" on public.images;
create policy "images: solo el dueño" on public.images
  for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid())
  );

-- 4) Fotos: bucket privado, cada usuario en su propia carpeta --------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('radiografias', 'radiografias', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "fotos: leer las propias"  on storage.objects;
drop policy if exists "fotos: subir las propias" on storage.objects;
drop policy if exists "fotos: borrar las propias" on storage.objects;

create policy "fotos: leer las propias" on storage.objects
  for select to authenticated
  using (bucket_id = 'radiografias' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "fotos: subir las propias" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'radiografias' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "fotos: borrar las propias" on storage.objects
  for delete to authenticated
  using (bucket_id = 'radiografias' and (storage.foldername(name))[1] = auth.uid()::text);

-- 5) Vocabulario (mazos de términos y definiciones) -------------------------
create table if not exists public.vocab_decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  cards       jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.vocab_decks enable row level security;
drop policy if exists "vocab: solo el dueño" on public.vocab_decks;
create policy "vocab: solo el dueño" on public.vocab_decks
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
