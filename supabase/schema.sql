-- ============================================================
-- TecnoFutbol Plattform — Schema Modul 1 (Finanzen + Login + Rechte)
-- Im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.
-- ============================================================

-- ---------- Tabellen ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text not null default 'mitarbeiter' check (role in ('admin','mitarbeiter')),
  created_at timestamptz not null default now()
);

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  key text unique,
  name text not null,
  form text,
  strasse text, plz text, ort text, land text default 'Österreich',
  tax_mode text default 'verein' check (tax_mode in ('verein','klein','regel')),
  uid text, email text, tel text, bank text, iban text, bic text, reg text,
  design jsonb not null default '{}'::jsonb,
  numbering jsonb not null default '{}'::jsonb,
  umsatzziel numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.company_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  primary key (user_id, company_id)
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  typ text not null default 'ausgang' check (typ in ('ausgang','eingang')),
  nummer text,
  kunde text, kunde_adresse text, kunde_uid text,
  datum date, faelligkeit date, leistung_von date, leistung_bis date,
  betreff text, kostenstelle text,
  positionen jsonb not null default '[]'::jsonb,
  netto numeric default 0, ust numeric default 0, brutto numeric default 0,
  rabatt jsonb,
  steuer_vermerk text,
  status text not null default 'offen' check (status in ('offen','bezahlt')),
  bezahlt_am date,
  beleg_url text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- Hilfsfunktionen (SECURITY DEFINER = umgehen RLS, keine Rekursion) ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.has_company_access(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or exists (select 1 from public.company_access where user_id = auth.uid() and company_id = cid);
$$;

-- ---------- Neuer Auth-User -> Profil anlegen ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_access enable row level security;
alter table public.invoices enable row level security;

-- profiles: eigenes Profil oder Admin sieht alle; nur Admin ändert Rollen
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (id = auth.uid() or public.is_admin());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (public.is_admin()) with check (public.is_admin());

-- companies: sichtbar bei Zugriff; nur Admin verwaltet
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies for select using (public.has_company_access(id));
drop policy if exists companies_admin on public.companies;
create policy companies_admin on public.companies for all using (public.is_admin()) with check (public.is_admin());

-- company_access: eigene Freigaben sichtbar; nur Admin verwaltet
drop policy if exists access_select on public.company_access;
create policy access_select on public.company_access for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists access_admin on public.company_access;
create policy access_admin on public.company_access for all using (public.is_admin()) with check (public.is_admin());

-- invoices: nur Unternehmen mit Zugriff (Admin = alle)
drop policy if exists invoices_all on public.invoices;
create policy invoices_all on public.invoices for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

-- ---------- Startdaten: die 4 Unternehmen ----------
insert into public.companies (key, name, form, plz, ort, tax_mode, design, numbering) values
  ('tfc','TecnoFutbol College Weiz','Verein','8160','Weiz','verein',
    '{"accent":"#2C6A57","headerStyle":"band","font":"serif"}','{"prefix":"TFC","useYear":true,"sep":"-","pad":4,"next":1}'),
  ('scw','SC Weiz','Verein','8160','Weiz','verein',
    '{"accent":"#184437","headerStyle":"classic","font":"serif"}','{"prefix":"SCW","useYear":true,"sep":"-","pad":4,"next":1}'),
  ('mhe','Martin Halper e.U.','Einzelunternehmen','8160','Weiz','klein',
    '{"accent":"#A67C3D","headerStyle":"minimal","font":"sans"}','{"prefix":"MH","useYear":true,"sep":"-","pad":4,"next":1}'),
  ('shg','Strobl-Halper GesbR','GesbR','8160','Weiz','klein',
    '{"accent":"#8A4453","headerStyle":"classic","font":"serif"}','{"prefix":"SHG","useYear":true,"sep":"-","pad":4,"next":1}')
on conflict (key) do nothing;

-- ---------- NACH dem ersten Login einmalig ausführen (dich zum Admin machen): ----------
-- update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'martin_halper@tecnofutbol.at');
