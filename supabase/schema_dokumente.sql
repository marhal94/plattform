-- ============================================================
-- TecnoFutbol Plattform — Datei-Speicher (Budgetplanung & Belege)
-- Legt einen privaten Storage-Bucket "dokumente" an.
-- Pfad-Konvention: <company_id>/<kategorie>/<jahr>/<datei>
-- Zugriff nur für eingeloggte Nutzer mit Zugriff auf das Unternehmen
-- (erster Pfadteil = company_id). Im Supabase SQL-Editor ausführen.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('dokumente', 'dokumente', false)
on conflict (id) do nothing;

-- Lesen (Liste + signierte URLs)
drop policy if exists dok_select on storage.objects;
create policy dok_select on storage.objects for select to authenticated
  using (bucket_id = 'dokumente' and public.has_company_access(((storage.foldername(name))[1])::uuid));

-- Hochladen
drop policy if exists dok_insert on storage.objects;
create policy dok_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumente' and public.has_company_access(((storage.foldername(name))[1])::uuid));

-- Ersetzen (Upsert)
drop policy if exists dok_update on storage.objects;
create policy dok_update on storage.objects for update to authenticated
  using (bucket_id = 'dokumente' and public.has_company_access(((storage.foldername(name))[1])::uuid));

-- Löschen
drop policy if exists dok_delete on storage.objects;
create policy dok_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dokumente' and public.has_company_access(((storage.foldername(name))[1])::uuid));
