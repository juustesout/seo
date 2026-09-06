-- ============================================================================
-- SEO Platform - project-scoped media library (Content Studio Phase F)
--
-- seo_media holds metadata only - image bytes live in the project's object
-- storage bucket under a random key (`seo-media/<project_id>/<random>.ext`),
-- never in Postgres. Content documents reference library items by id inside
-- the Phase B Tiptap model (`image` nodes carry attrs.mediaId); the document
-- remains the source of truth for WHERE media is used while the library owns
-- the asset and its metadata.
--
-- seo_content_media is a denormalized reference index kept in sync on every
-- content write. It exists so deletion can refuse to remove a library item
-- while any document still uses it - and its RESTRICT foreign key enforces
-- that even if application code regresses. Deleting a content row cascades the
-- index rows only; the media item itself is never auto-deleted.
-- ============================================================================

create table public.seo_media (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  filename      text not null,
  mime_type     text not null,
  size          integer not null check (size >= 0),
  storage_key   text not null unique,
  width         integer,
  height        integer,
  alt_text      text not null default '',
  caption       text not null default '',
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint seo_media_mime_check
    check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  constraint seo_media_filename_not_blank check (length(btrim(filename)) > 0),
  constraint seo_media_dimensions_check
    check (
      (width is null and height is null)
      or (width is not null and height is not null and width > 0 and height > 0 and width <= 20000 and height <= 20000)
    )
);

create index seo_media_project_idx on public.seo_media (project_id);
create index seo_media_project_updated_idx on public.seo_media (project_id, updated_at desc);

create trigger seo_media_touch_updated_at
  before update on public.seo_media
  for each row execute function public.seo_touch_updated_at();

-- Reference index: which content documents use which library items. Deleting a
-- document removes its index rows (cascade); media items stay until explicitly
-- removed, and only once nothing references them (restrict).
create table public.seo_content_media (
  content_id uuid not null references public.seo_content (id) on delete cascade,
  media_id   uuid not null references public.seo_media (id) on delete restrict,
  primary key (content_id, media_id)
);

create index seo_content_media_media_idx on public.seo_content_media (media_id);
create index seo_content_media_content_idx on public.seo_content_media (content_id);

-- ----------------------------------------------------------------------------
-- RLS. The API writes with the service role (bypasses RLS after its own access
-- checks); these policies are the boundary for any browser-side / PostgREST
-- traffic: members read, editors+ manage the library, owners/admins delete.
-- ----------------------------------------------------------------------------

alter table public.seo_media enable row level security;

drop policy if exists seo_media_select on public.seo_media;
create policy seo_media_select on public.seo_media
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_media_insert on public.seo_media;
create policy seo_media_insert on public.seo_media
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_media_update on public.seo_media;
create policy seo_media_update on public.seo_media
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_media_delete on public.seo_media;
create policy seo_media_delete on public.seo_media
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));

alter table public.seo_content_media enable row level security;

drop policy if exists seo_content_media_select on public.seo_content_media;
create policy seo_content_media_select on public.seo_content_media
  for select using (
    exists (
      select 1 from public.seo_media m
      where m.id = media_id and public.seo_is_member(m.project_id, auth.uid())
    )
  );

drop policy if exists seo_content_media_insert on public.seo_content_media;
create policy seo_content_media_insert on public.seo_content_media
  for insert with check (
    exists (
      select 1 from public.seo_media m
      where m.id = media_id and public.seo_has_role(m.project_id, array['owner', 'admin', 'editor'])
    )
  );

drop policy if exists seo_content_media_update on public.seo_content_media;
create policy seo_content_media_update on public.seo_content_media
  for update using (
    exists (
      select 1 from public.seo_media m
      where m.id = media_id and public.seo_has_role(m.project_id, array['owner', 'admin', 'editor'])
    )
  );

drop policy if exists seo_content_media_delete on public.seo_content_media;
create policy seo_content_media_delete on public.seo_content_media
  for delete using (
    exists (
      select 1 from public.seo_media m
      where m.id = media_id and public.seo_has_role(m.project_id, array['owner', 'admin', 'editor'])
    )
  );
