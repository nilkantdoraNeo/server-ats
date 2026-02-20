create extension if not exists pgcrypto;

create table if not exists public.candidates (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  skills text[] not null default '{}',
  resume_url text,
  created_at timestamptz not null default now()
);

alter table public.candidates add column if not exists name text;
alter table public.candidates add column if not exists email text;
alter table public.candidates add column if not exists phone text;
alter table public.candidates add column if not exists skills text[] not null default '{}';
alter table public.candidates add column if not exists resume_url text;
alter table public.candidates add column if not exists created_at timestamptz not null default now();

create index if not exists idx_candidates_skills_gin
  on public.candidates
  using gin (skills);

create unique index if not exists uq_candidates_email_ci
  on public.candidates (lower(email))
  where email is not null and btrim(email) <> '';

create unique index if not exists uq_candidates_phone
  on public.candidates (phone)
  where phone is not null and btrim(phone) <> '';

create unique index if not exists uq_candidates_resume_url
  on public.candidates (resume_url)
  where resume_url is not null and btrim(resume_url) <> '';

create or replace function public.search_candidates_by_skills_partial(search_terms text[])
returns setof public.candidates
language sql
stable
as $$
  select c.*
  from public.candidates c
  where exists (
    select 1
    from unnest(c.skills) s
    join unnest(search_terms) term on lower(s) like '%' || lower(term) || '%'
  )
  order by c.created_at desc;
$$;
