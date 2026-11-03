-- ============================================================
-- TecnoFutbol Plattform — Kunden & Produkte (für Rechnungen)
-- Ergänzung. Im Supabase SQL-Editor einfügen und ausführen.
-- ============================================================

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  adresse text,
  uid text,
  email text,
  tel text,
  notiz text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists customers_company_name on public.customers(company_id, name);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bezeichnung text not null,
  einheit text default 'Stk',
  einzelpreis numeric default 0,
  kategorie text,
  aktiv boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists products_company_bez on public.products(company_id, bezeichnung);

alter table public.customers enable row level security;
alter table public.products enable row level security;

drop policy if exists cust_all on public.customers;
create policy cust_all on public.customers for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

drop policy if exists prod_all on public.products;
create policy prod_all on public.products for all
  using (public.has_company_access(company_id)) with check (public.has_company_access(company_id));

notify pgrst, 'reload schema';
