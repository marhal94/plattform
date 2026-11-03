-- ============================================================
-- TecnoFutbol Plattform — Mitgliederbereich (zunächst SC Weiz)
-- Im Supabase SQL-Editor einfügen und ausführen.
-- ============================================================

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vorname text, nachname text,
  email text, tel text,
  strasse text, plz text, ort text,
  geburtsdatum date,
  mitglied_seit date default current_date,
  typ text,                              -- Mitgliedschaftsart (Aktiv, Unterstützend, Jugend …)
  beitrag numeric default 0,             -- Jahresbeitrag
  zahlart text not null default 'ueberweisung' check (zahlart in ('sepa','ueberweisung','bar')),
  -- SEPA-Lastschrift
  sepa_iban text, sepa_bic text, sepa_inhaber text, sepa_mandat text, sepa_mandat_datum date,
  status text not null default 'offen' check (status in ('offen','aktiv','inaktiv')),
  notiz text,
  quelle text not null default 'manuell' check (quelle in ('manuell','online')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists members_company on public.members(company_id, nachname);

create table if not exists public.member_payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  datum date not null default current_date,
  betrag numeric not null,
  zahlart text not null check (zahlart in ('sepa','ueberweisung','bar')),
  jahr int,
  notiz text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists member_payments_member on public.member_payments(member_id);

-- ---------- Row Level Security ----------
alter table public.members enable row level security;
alter table public.member_payments enable row level security;

-- Team (eingeloggt, mit Zugriff aufs Unternehmen) sieht/bearbeitet alles
drop policy if exists members_team on public.members;
create policy members_team on public.members for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

-- Öffentliche Online-Anmeldung: NICHT eingeloggt darf nur anlegen (offen, online), nicht lesen
drop policy if exists members_public_insert on public.members;
create policy members_public_insert on public.members for insert to anon
  with check (quelle = 'online' and status = 'offen');

drop policy if exists mp_team on public.member_payments;
create policy mp_team on public.member_payments for all to authenticated
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

notify pgrst, 'reload schema';
