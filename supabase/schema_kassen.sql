-- ============================================================
-- TecnoFutbol Plattform — Konten/Kassen (Bankkonto, Handkassa, Jugendkassa …)
-- Ergänzung. Im Supabase SQL-Editor einfügen und ausführen.
-- ============================================================

-- Liste der Konten/Kassen je Unternehmen (Bankkonto ist implizit immer vorhanden)
create table if not exists public.konten (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  typ text not null default 'kassa' check (typ in ('bank','kassa')),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- Zuordnung der Buchung zu einem Konto/einer Kassa (leer = Bankkonto)
alter table public.bookings add column if not exists konto text;

-- Budgets zusätzlich je Konto/Kassa (Soll-Ist getrennt pro Kassa)
alter table public.budgets add column if not exists konto text not null default 'Bankkonto';
-- alte Unique (ohne konto) entfernen, neue inkl. konto als Index
alter table public.budgets drop constraint if exists budgets_company_id_jahr_kostenstelle_typ_key;
create unique index if not exists budgets_uniq on public.budgets (company_id, jahr, konto, kostenstelle, typ);

-- RLS
alter table public.konten enable row level security;
drop policy if exists konten_all on public.konten;
create policy konten_all on public.konten for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

notify pgrst, 'reload schema';
