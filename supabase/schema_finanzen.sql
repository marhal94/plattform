-- ============================================================
-- TecnoFutbol Plattform — Finanzen (Einnahmen-Ausgaben-Rechnung)
-- Ergänzung zu schema.sql. Im Supabase SQL-Editor einfügen und ausführen.
-- Baut auf has_company_access() aus schema.sql auf.
-- ============================================================

-- ---------- Kostenstellen (je Unternehmen, wiederverwendbar) ----------
create table if not exists public.cost_centers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- ---------- Buchungszeilen (Einnahmen / Ausgaben) ----------
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  datum date not null,
  typ text not null check (typ in ('einnahme','ausgabe')),
  betrag numeric not null check (betrag >= 0),          -- immer positiv; Richtung steckt in typ
  text text,                                            -- Verwendungszweck / Buchungstext
  gegenkonto text,                                      -- Zahler / Empfänger
  kostenstelle text,
  kategorie text,
  quelle text not null default 'manuell' check (quelle in ('manuell','pdf-import','rechnung')),
  beleg_url text,
  invoice_id uuid references public.invoices(id) on delete set null,
  import_batch uuid,                                    -- gruppiert einen PDF-Import
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists bookings_company_datum on public.bookings(company_id, datum);

-- ---------- Budgets (Soll-Werte je Jahr/Kostenstelle/Richtung) ----------
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  jahr int not null,
  kostenstelle text not null default '(gesamt)',
  typ text not null check (typ in ('einnahme','ausgabe')),
  soll numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, jahr, kostenstelle, typ)
);

-- ---------- Row Level Security ----------
alter table public.cost_centers enable row level security;
alter table public.bookings enable row level security;
alter table public.budgets enable row level security;

drop policy if exists cc_all on public.cost_centers;
create policy cc_all on public.cost_centers for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

drop policy if exists bk_all on public.bookings;
create policy bk_all on public.bookings for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

drop policy if exists bg_all on public.budgets;
create policy bg_all on public.budgets for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));
