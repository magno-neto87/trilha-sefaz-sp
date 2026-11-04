create table if not exists public.user_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_progress enable row level security;

revoke all on table public.user_progress from anon, public;
grant select, insert, update on table public.user_progress to authenticated;

drop policy if exists "Users can read their own progress" on public.user_progress;
create policy "Users can read their own progress"
  on public.user_progress
  for select
  to authenticated
  using (
    (select auth.uid()) = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
    and user_id = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
  );

drop policy if exists "Users can create their own progress" on public.user_progress;
create policy "Users can create their own progress"
  on public.user_progress
  for insert
  to authenticated
  with check (
    (select auth.uid()) = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
    and user_id = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
  );

drop policy if exists "Users can update their own progress" on public.user_progress;
create policy "Users can update their own progress"
  on public.user_progress
  for update
  to authenticated
  using (
    (select auth.uid()) = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
    and user_id = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
  )
  with check (
    (select auth.uid()) = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
    and user_id = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
  );

insert into storage.buckets (id, name, public, file_size_limit)
values ('study-materials', 'study-materials', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists "Authenticated users can read study materials" on storage.objects;
create policy "Authenticated users can read study materials"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'study-materials'
    and (select auth.uid()) = 'c8ec6d1a-b031-42f9-8ef5-98a6dfcc6313'
  );
