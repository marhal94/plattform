# TecnoFutbol · Plattform

Zentrale Web-Plattform für die Vereine/Unternehmen von Martin Halper.
Bau-frei (reines HTML/JS + Supabase per CDN) — keine Installation nötig.

**Module (Roadmap):** 1) Finanzen · 2) Mitglieder · 3) Kommunikation · 4) Betreuung · 5) Social Media.
Aktueller Stand: **Fundament** (Login + Rechte + Unternehmen) steht; Finanzen/Mitglieder im Aufbau.

## Einrichtung (einmalig)

### 1. Supabase-Projekt anlegen
1. Auf **supabase.com** kostenlos registrieren → **New project**.
2. Name z. B. `tecnofutbol-plattform`, Region **Central EU (Frankfurt)**, ein **Datenbank-Passwort** vergeben (notieren, bleibt bei dir).
3. 1–2 Minuten warten, bis das Projekt bereit ist.

### 2. Zugangsdaten holen
Im Projekt: **Project Settings → API**. Kopiere:
- **Project URL** (z. B. `https://abcd.supabase.co`)
- **anon public** key (langer Schlüssel; ist öffentlich, kein Geheimnis)

Diese beiden Werte in `js/config.js` eintragen (oder Claude geben, er trägt sie ein).

### 3. Datenbank aufsetzen
Im Projekt: **SQL Editor → New query** → nacheinander ausführen:
1. [`supabase/schema.sql`](supabase/schema.sql) — Tabellen, Zugriffsregeln, die 4 Unternehmen.
2. [`supabase/schema_finanzen.sql`](supabase/schema_finanzen.sql) — Finanzen-Modul: Buchungen, Kostenstellen, Budgets (Einnahmen-Ausgaben-Rechnung, Soll-Ist, PDF-Import).

### 4. Admin-Zugang anlegen
1. **Authentication → Users → Add user** → deine E-Mail + Passwort (E-Mail bestätigt setzen).
2. Danach im **SQL Editor** einmalig ausführen (macht dich zum Admin):
   ```sql
   update public.profiles set role = 'admin'
     where id = (select id from auth.users where email = 'martin_halper@tecnofutbol.at');
   ```

### 5. Lokal starten
Im Ordner `plattform/`:
```bash
python3 -m http.server 5173
```
Dann im Browser **http://localhost:5173** öffnen und mit deinem Admin-Zugang anmelden.

## Mitarbeiter anlegen (als Admin)
Vorerst in Supabase: **Authentication → Add user** (E-Mail+Passwort), dann in `company_access`
die freigeschalteten Unternehmen eintragen. Eine Oberfläche dafür baut Claude als Nächstes.

## Veröffentlichen (später)
Statische Dateien zu **Vercel/Netlify/Cloudflare Pages** → echte URL. `js/config.js` bleibt dabei dabei
(anon key ist öffentlich). Jede Erweiterung: Dateien ändern → neu deployen.
