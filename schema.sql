create extension if not exists pgcrypto;

-- 1. Server-side Secrets (Client ko kabhi nahi dikhega)
create table if not exists public.app_secrets (
  key text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;

insert into public.app_secrets (key, value) values
  ('admin_passcode', 'CHANGE_THIS_ADMIN_PASSCODE'),
  ('faculty_passcode', 'CHANGE_THIS_FACULTY_PASSCODE')
on conflict (key) do nothing;

-- 2. Profiles Table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,
  photo_url text,
  role text not null default 'student' check (role in ('student', 'faculty', 'admin')),
  legacy_firebase_uid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. Questions Table
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  subject text default 'General',
  image_url text,
  audio_url text,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  author_role text not null default 'student',
  author_photo text,
  upvotes_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_questions_created on public.questions (created_at desc);

-- 4. Question Upvotes Table
create table if not exists public.question_upvotes (
  question_id uuid references public.questions(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (question_id, user_id)
);

-- 5. Answers Table
create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  body text not null,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  author_role text not null default 'student',
  author_photo text,
  created_at timestamptz not null default now()
);
create index if not exists idx_answers_question on public.answers (question_id, created_at asc);

-- 6. Study Materials Table (Ab URLs store hongi, Base64 nahi!)
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text not null,
  file_url text not null,
  file_path text,
  file_name text not null,
  file_size bigint default 0,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  author_role text not null default 'faculty',
  created_at timestamptz not null default now()
);
create index if not exists idx_materials_created on public.materials (created_at desc);

-- 7. Push Subscriptions (Web Push / FCM Tokens)
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text unique not null,
  subscription_json jsonb not null,
  created_at timestamptz not null default now()
);

-- 8. Zero-Miss Notification Outbox
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  title text not null,
  body text not null,
  target_user_id uuid, -- null = broadcast to all users
  author_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  next_retry_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_outbox_pending on public.notification_outbox (status, next_retry_at);

-- 9. Helper Function: Check if current user is Admin
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- 10. Server-Side Profile + Passcode Verification RPC
create or replace function public.set_user_profile(
  p_name text,
  p_role text,
  p_passcode text default ''
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_expected text;
  v_user auth.users%rowtype;
  v_profile public.profiles;
begin
  if v_uid is null then raise exception 'Unauthorized'; end if;
  if p_role not in ('student', 'faculty', 'admin') then raise exception 'Invalid role'; end if;

  if p_role = 'admin' then
    select value into v_expected from public.app_secrets where key = 'admin_passcode';
    if coalesce(p_passcode, '') <> coalesce(v_expected, '') then
      raise exception 'Invalid admin passcode.';
    end if;
  elsif p_role = 'faculty' then
    select value into v_expected from public.app_secrets where key = 'faculty_passcode';
    if coalesce(p_passcode, '') <> coalesce(v_expected, '') then
      raise exception 'Invalid faculty passcode.';
    end if;
  end if;

  select * into v_user from auth.users where id = v_uid;

  insert into public.profiles (id, name, email, photo_url, role, updated_at)
  values (
    v_uid,
    trim(p_name),
    v_user.email,
    coalesce(v_user.raw_user_meta_data->>'avatar_url', v_user.raw_user_meta_data->>'picture', ''),
    p_role,
    now()
  )
  on conflict (id) do update set
    name = excluded.name,
    role = excluded.role,
    photo_url = excluded.photo_url,
    updated_at = now()
  returning * into v_profile;

  return v_profile;
end;
$$;
grant execute on function public.set_user_profile(text, text, text) to authenticated;

-- 11. Upvote Toggle RPC
create or replace function public.toggle_question_upvote(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Unauthorized'; end if;
  if exists (select 1 from public.question_upvotes where question_id = p_question_id and user_id = v_uid) then
    delete from public.question_upvotes where question_id = p_question_id and user_id = v_uid;
    update public.questions set upvotes_count = greatest(0, upvotes_count - 1) where id = p_question_id;
  else
    insert into public.question_upvotes (question_id, user_id) values (p_question_id, v_uid);
    update public.questions set upvotes_count = upvotes_count + 1 where id = p_question_id;
  end if;
end;
$$;
grant execute on function public.toggle_question_upvote(uuid) to authenticated;

-- 12. Automatic Zero-Miss Notification Triggers
create or replace function public.queue_question_notification()
returns trigger language plpgsql security definer as $$
begin
  insert into public.notification_outbox (event_type, title, body, author_id)
  values ('new_question', 'New Question on MewarHelpNots', NEW.author_name || ': ' || NEW.title, NEW.author_id);
  return NEW;
end;
$$;

create or replace function public.queue_answer_notification()
returns trigger language plpgsql security definer as $$
declare
  v_q_author uuid;
  v_q_title text;
begin
  select author_id, title into v_q_author, v_q_title from public.questions where id = NEW.question_id;
  if v_q_author is not null and v_q_author <> NEW.author_id then
    insert into public.notification_outbox (event_type, title, body, target_user_id, author_id)
    values ('new_answer', 'New Reply on Your Question', NEW.author_name || ' replied to "' || left(v_q_title, 60) || '"', v_q_author, NEW.author_id);
  end if;
  return NEW;
end;
$$;

create or replace function public.queue_material_notification()
returns trigger language plpgsql security definer as $$
begin
  insert into public.notification_outbox (event_type, title, body, author_id)
  values ('new_material', 'New Study Material: ' || NEW.subject, NEW.author_name || ' uploaded ' || NEW.title, NEW.author_id);
  return NEW;
end;
$$;

drop trigger if exists trg_q_notif on public.questions;
create trigger trg_q_notif after insert on public.questions for each row execute function public.queue_question_notification();

drop trigger if exists trg_a_notif on public.answers;
create trigger trg_a_notif after insert on public.answers for each row execute function public.queue_answer_notification();

drop trigger if exists trg_m_notif on public.materials;
create trigger trg_m_notif after insert on public.materials for each row execute function public.queue_material_notification();

-- 13. Row Level Security (RLS)
alter table public.profiles enable row level security;
alter table public.questions enable row level security;
alter table public.question_upvotes enable row level security;
alter table public.answers enable row level security;
alter table public.materials enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_outbox enable row level security;

create policy "Authenticated read profiles" on public.profiles for select to authenticated using (true);
create policy "Authenticated read questions" on public.questions for select to authenticated using (true);
create policy "Authenticated insert questions" on public.questions for insert to authenticated with check (author_id = auth.uid());
create policy "Owner or Admin delete questions" on public.questions for delete to authenticated using (author_id = auth.uid() or public.is_admin());

create policy "Read upvotes" on public.question_upvotes for select to authenticated using (true);
create policy "Read answers" on public.answers for select to authenticated using (true);
create policy "Insert answers" on public.answers for insert to authenticated with check (author_id = auth.uid());
create policy "Owner or Admin delete answers" on public.answers for delete to authenticated using (author_id = auth.uid() or public.is_admin());

create policy "Read materials" on public.materials for select to authenticated using (true);
create policy "Faculty/Admin insert materials" on public.materials for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('faculty', 'admin')));
create policy "Owner or Admin update materials" on public.materials for update to authenticated using (author_id = auth.uid() or public.is_admin());
create policy "Owner or Admin delete materials" on public.materials for delete to authenticated using (author_id = auth.uid() or public.is_admin());

create policy "Manage own push subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Admin read/update outbox" on public.notification_outbox for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 14. Storage Buckets (media + materials)
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('materials', 'materials', true) on conflict do nothing;

create policy "Public read media" on storage.objects for select using (bucket_id in ('media', 'materials'));
create policy "Auth upload media" on storage.objects for insert to authenticated with check (bucket_id in ('media', 'materials'));
create policy "Owner or Admin delete media" on storage.objects for delete to authenticated
  using (bucket_id in ('media', 'materials') and (owner = auth.uid() or public.is_admin()));

-- 15. Enable Realtime
alter publication supabase_realtime add table public.questions, public.answers, public.materials, public.notification_outbox;