-- PostFlowX Supabase Setup
-- Run this in your Supabase dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. User profiles table (plan + metadata)
create table if not exists public.user_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  plan            text not null default 'free'
                    check (plan in ('free', 'pro', 'enterprise')),
  plan_expires_at timestamptz,
  display_name    text,
  avatar_url      text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- 2. Row Level Security — users can only read/update their own profile
alter table public.user_profiles enable row level security;

create policy "Users can read own profile"
  on public.user_profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.user_profiles for update
  using (auth.uid() = id);

-- 3. Auto-create profile on new user signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, plan, display_name, avatar_url)
  values (
    new.id,
    'free',
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. (Optional) Upgrade a user to Pro — run manually in SQL editor
-- update public.user_profiles set plan = 'pro' where id = '<user-uuid>';
