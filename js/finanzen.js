// Finanzen-Modul: Einnahmen-Ausgaben-Rechnung (EAR), Buchungen,
// Kontoauszug-PDF-Import, Soll-Ist-Vergleich, Kostenstellen.
import { sb, esc, fmtEUR, fmtNum, fmtDate, todayISO, uuid, fyStartMonth, fyLabel, fyRange, currentFYStartYear } from "./db.js";
import { parseFile, parseBudgetFile, parseBudgetBuffer } from "./pdfimport.js";
import { modal, closeModal, showErr } from "./ui.js";
import { renderRechnungen } from "./rechnung.js";
import { renderStammdaten } from "./stammdaten.js";
import { renderKunden, renderProdukte } from "./katalog.js";

const F = {
  companies: [], companyId: null,
  year: new Date().getFullYear(),
  tab: "uebersicht",
  bookings: [], costCenters: [], budgets: [], konten: [],
  konto: "", // "" = alle Konten/Kassen; sonst Name (z. B. "Handkassa")
  showSoll: false, // Soll-Ist-Vergleich in der Übersicht einblenden
  budgetDocs: [], budgetDocsKey: null, budgetDocsErr: null, // hochgeladene Budgetplanungs-PDFs
  userId: null, root: null, err: null,
};
const DEFAULT_KONTO = "Bankkonto";

const TABS = [
  { id: "uebersicht", label: "Übersicht (EAR)" },
  { id: "buchungen", label: "Buchungen" },
  { id: "rechnungen", label: "Rechnungen" },
  { id: "kunden", label: "Kunden" },
  { id: "produkte", label: "Produkte" },
  { id: "import", label: "Kontoauszug einlesen" },
  { id: "sollist", label: "Soll-Ist" },
  { id: "kostenstellen", label: "Kostenstellen & Kassen" },
  { id: "stammdaten", label: "Stammdaten" },
];

const schemaHint = (msg) => `<div class="card"><div class="msg err">${esc(msg)}</div>
  <p class="note">Falls Tabellen fehlen: <code>supabase/schema_finanzen.sql</code> im Supabase-SQL-Editor ausführen.</p></div>`;

// ---------- Datenzugriff ----------
async function loadCompanies() {
  // alle Spalten: Rechnungen/Stammdaten/QR brauchen numbering, iban, bic, Adresse, logo …
  const { data, error } = await sb.from("companies").select("*").order("name");
  if (error) return error.message;
  F.companies = data || [];
  return null;
}
async function loadData() {
  F.err = null;
  const [from, to] = fyRange(F.year, fyStartMonth(company()));
  const [bk, cc, bg, kn, usr] = await Promise.all([
    sb.from("bookings").select("*").eq("company_id", F.companyId).gte("datum", from).lte("datum", to).order("datum", { ascending: false }),
    sb.from("cost_centers").select("*").eq("company_id", F.companyId).order("name"),
    sb.from("budgets").select("*").eq("company_id", F.companyId).eq("jahr", F.year),
    sb.from("konten").select("*").eq("company_id", F.companyId).order("sort").order("name"),
    F.userId ? Promise.resolve(null) : sb.auth.getUser(),
  ]);
  if (usr && usr.data) F.userId = usr.data.user ? usr.data.user.id : null;
  if (bk.error) { F.err = bk.error.message; return; }
  F.bookings = bk.data || [];
  F.costCenters = cc.error ? [] : (cc.data || []);
  F.budgets = bg.error ? [] : (bg.data || []);
  F.konten = kn.error ? [] : (kn.data || []);
}

// ---------- Berechnungen ----------
const company = () => F.companies.find((c) => c.id === F.companyId) || {};
const fyl = () => fyLabel(F.year, fyStartMonth(company())); // Anzeige-Label des Wirtschaftsjahres
const kontoName = (b) => (b.konto || "").trim() || DEFAULT_KONTO;
// Buchungen gefiltert auf das aktuell gewählte Konto/die Kassa ("" = alle)
const kb = () => (F.konto ? F.bookings.filter((b) => kontoName(b) === F.konto) : F.bookings);
// Alle vorhandenen Konto-/Kassennamen (Bankkonto + verwaltete + in Buchungen vorkommende)
function kontoNames() {
  const s = new Set([DEFAULT_KONTO, ...F.konten.map((k) => k.name), ...F.bookings.map(kontoName)]);
  return [...s];
}
function kontoOptions(selected) {
  return kontoNames().map((n) => `<option value="${esc(n)}" ${n === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
}
// true, wenn der Fehler daran liegt, dass die konto-Spalte/-Constraint noch fehlt (schema_kassen.sql nicht ausgeführt)
const isKontoMissing = (err) => err && /konto/i.test(err.message || "") && /(column|schema cache|does not exist|constraint)/i.test(err.message || "");
function totals(rows = F.bookings) {
  let ein = 0, aus = 0;
  for (const b of rows) { if (b.typ === "einnahme") ein += +b.betrag || 0; else aus += +b.betrag || 0; }
  return { ein, aus, saldo: ein - aus };
}
function byKostenstelle(rows = F.bookings) {
  const m = new Map();
  for (const b of rows) {
    const k = (b.kostenstelle || "").trim() || "(ohne Kostenstelle)";
    if (!m.has(k)) m.set(k, { ein: 0, aus: 0 });
    const o = m.get(k);
    if (b.typ === "einnahme") o.ein += +b.betrag || 0; else o.aus += +b.betrag || 0;
  }
  return [...m.entries()].map(([k, v]) => ({ k, ...v, saldo: v.ein - v.aus })).sort((a, b) => (b.ein + b.aus) - (a.ein + a.aus));
}
// Saldo je Konto/Kassa (immer über ALLE Buchungen, für die getrennte Ausweisung)
function byKonto() {
  const m = new Map();
  for (const n of kontoNames()) m.set(n, { ein: 0, aus: 0 });
  for (const b of F.bookings) {
    const k = kontoName(b); if (!m.has(k)) m.set(k, { ein: 0, aus: 0 });
    const o = m.get(k); if (b.typ === "einnahme") o.ein += +b.betrag || 0; else o.aus += +b.betrag || 0;
  }
  return [...m.entries()].map(([k, v]) => ({ k, ...v, saldo: v.ein - v.aus }));
}
// Ist für Soll-Ist = ZUSAMMENGERECHNET über alle Konten & Kassen (Budget gilt gesamt)
function istFor(kostenstelle, typ) {
  return F.bookings.filter((b) => b.typ === typ && ((b.kostenstelle || "").trim() || "(ohne Kostenstelle)") === kostenstelle)
    .reduce((s, b) => s + (+b.betrag || 0), 0);
}
// Soll = globales Budget je Kostenstelle (über alle Kassen hinweg)
function sollFor(kostenstelle, typ) {
  return F.budgets.filter((b) => b.kostenstelle === kostenstelle && b.typ === typ).reduce((s, b) => s + (+b.soll || 0), 0);
}

// ---------- Haupt-Render ----------
export async function renderFinanzen(root) {
  F.root = root;
  F.err = null;
  root.innerHTML = `<h2 class="page-title">Finanzen</h2><div class="page-sub">Einnahmen-Ausgaben-Rechnung, Buchungen und Soll-Ist.</div><div class="empty">Lädt …</div>`;
  if (!F.companies.length) {
    const coErr = await loadCompanies();
    if (coErr) {
      root.querySelector(".empty").outerHTML = `<div class="card"><div class="msg err">Konnte Unternehmen nicht laden: ${esc(coErr)}</div>
        <p class="note">Falls die Tabelle fehlt: <code>supabase/schema.sql</code> im Supabase-SQL-Editor ausführen.</p></div>`;
      return;
    }
  }
  if (!F.companies.length) { root.querySelector(".empty").outerHTML = `<div class="empty">Noch keine Unternehmen freigeschaltet.</div>`; return; }
  if (!F.companyId || !F.companies.some((c) => c.id === F.companyId)) F.companyId = F.companies[0].id;
  if (F._yearCompany !== F.companyId) { F.year = currentFYStartYear(fyStartMonth(company())); F._yearCompany = F.companyId; }
  await loadData();
  renderShell();
}

function renderShell() {
  const root = F.root;
  const c = company();
  const accent = (c.design && c.design.accent) || "var(--brand)";
  root.innerHTML = `
    <div class="fin-head">
      <div>
        <h2 class="page-title" style="margin:0">Finanzen</h2>
        <div class="page-sub" style="margin:2px 0 0">Einnahmen-Ausgaben-Rechnung · ${esc(c.name || "")}</div>
      </div>
      <div class="fin-pickers">
        <label class="inline">Unternehmen
          <select id="finCo">${F.companies.map((co) => `<option value="${co.id}" ${co.id === F.companyId ? "selected" : ""}>${esc(co.name)}</option>`).join("")}</select>
        </label>
        <label class="inline">Konto/Kassa
          <select id="finKonto"><option value="" ${F.konto === "" ? "selected" : ""}>Alle</option>${kontoOptions(F.konto)}</select>
        </label>
        <label class="inline">Wirtschaftsjahr
          <select id="finYear">${yearOptions()}</select>
        </label>
      </div>
    </div>
    <div class="subnav">${TABS.map((t) => `<button data-tab="${t.id}" class="${F.tab === t.id ? "active" : ""}">${t.label}</button>`).join("")}</div>
    <div id="finBody"></div>`;
  root.style.setProperty("--co-accent", accent);
  root.querySelector("#finCo").addEventListener("change", async (e) => { F.companyId = e.target.value; F.konto = ""; F.year = currentFYStartYear(fyStartMonth(company())); F._yearCompany = F.companyId; await loadData(); renderShell(); });
  root.querySelector("#finKonto").addEventListener("change", (e) => { F.konto = e.target.value; renderShell(); });
  root.querySelector("#finYear").addEventListener("change", async (e) => { F.year = +e.target.value; await loadData(); renderShell(); });
  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { F.tab = b.dataset.tab; renderShell(); }));
  renderTab();
}

function yearOptions() {
  const start = fyStartMonth(company());
  const cur = currentFYStartYear(start);
  const years = [];
  for (let y = cur + 1; y >= cur - 4; y--) years.push(y);
  if (!years.includes(F.year)) years.push(F.year);
  return years.sort((a, b) => b - a).map((y) => `<option value="${y}" ${y === F.year ? "selected" : ""}>${fyLabel(y, start)}</option>`).join("");
}

function renderTab() {
  const body = F.root.querySelector("#finBody");
  if (F.err) { body.innerHTML = schemaHint("Fehler: " + F.err); return; }
  if (F.tab === "buchungen") return renderBuchungen(body);
  if (F.tab === "rechnungen") return renderRechnungen(body, company(), F.year, async () => { await loadData(); });
  if (F.tab === "kunden") return renderKunden(body, company(), () => {});
  if (F.tab === "produkte") return renderProdukte(body, company(), () => {});
  if (F.tab === "import") return renderImport(body);
  if (F.tab === "sollist") return renderSollIst(body);
  if (F.tab === "kostenstellen") return renderKostenstellen(body);
  if (F.tab === "stammdaten") return renderStammdaten(body, company(), reloadAll);
  return renderUebersicht(body);
}

async function reloadAll() {
  F.companies = [];
  await loadCompanies();
  if (!F.companies.some((c) => c.id === F.companyId)) F.companyId = F.companies[0] && F.companies[0].id;
  await loadData();
  renderShell();
}

// ---------- Übersicht (EAR) ----------
function renderUebersicht(body) {
  const scope = kb();
  const t = totals(scope);
  const rows = byKostenstelle(scope);
  const c = company();
  const ziel = c.umsatzziel ? +c.umsatzziel : 0;
  const zielPct = ziel ? Math.min(100, Math.round((t.ein / ziel) * 100)) : 0;
  const konten = byKonto();
  body.innerHTML = `
    ${F.konto ? `<div class="scope-badge">Ansicht: <b>${esc(F.konto)}</b> <button class="lnk" id="scopeAll">· alle anzeigen</button></div>` : ""}
    <div class="stat-row">
      ${stat("Einnahmen", fmtEUR(t.ein), "good")}
      ${stat("Ausgaben", fmtEUR(t.aus), "crit")}
      ${stat(t.saldo >= 0 ? "Überschuss" : "Abgang", fmtEUR(t.saldo), t.saldo >= 0 ? "good" : "crit")}
      ${stat("Buchungen", String(scope.length), "plain")}
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px"><h3 class="card-title">Kassenstände</h3><span class="muted">${fyl()} · jede Kassa getrennt</span></div>
      <table class="tbl"><thead><tr><th>Konto / Kassa</th><th class="num">Einnahmen</th><th class="num">Ausgaben</th><th class="num">Saldo</th></tr></thead>
        <tbody>${konten.map((k) => `<tr><td>${esc(k.k)}${F.konto === k.k ? ' <span class="tag">aktiv</span>' : ""}</td>
          <td class="num pos">${fmtEUR(k.ein)}</td><td class="num neg">${fmtEUR(k.aus)}</td><td class="num ${k.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(k.saldo)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Gesamt</td><td class="num pos">${fmtEUR(totals(F.bookings).ein)}</td><td class="num neg">${fmtEUR(totals(F.bookings).aus)}</td><td class="num ${totals(F.bookings).saldo >= 0 ? "pos" : "neg"}">${fmtEUR(totals(F.bookings).saldo)}</td></tr></tfoot>
      </table>
    </div>
    ${ziel ? `<div class="card" style="margin-top:14px"><div class="row-between"><label style="margin:0">Umsatzziel ${fyl()}</label><span class="muted">${fmtEUR(t.ein)} / ${fmtEUR(ziel)} · ${zielPct}%</span></div>
      <div class="bar" style="margin-top:8px"><span style="width:${zielPct}%;background:var(--good)"></span></div></div>` : ""}
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px"><h3 class="card-title">Nach Kostenstelle${F.konto ? " · " + esc(F.konto) : ""}</h3><span class="muted">${fyl()}</span></div>
      ${rows.length ? `<table class="tbl">
        <thead><tr><th>Kostenstelle</th><th class="num">Einnahmen</th><th class="num">Ausgaben</th><th class="num">Saldo</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.k)}</td><td class="num pos">${fmtEUR(r.ein)}</td><td class="num neg">${fmtEUR(r.aus)}</td>
          <td class="num ${r.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(r.saldo)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Summe</td><td class="num pos">${fmtEUR(t.ein)}</td><td class="num neg">${fmtEUR(t.aus)}</td><td class="num ${t.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(t.saldo)}</td></tr></tfoot>
      </table>` : `<div class="empty">Noch keine Buchungen in ${fyl()}. Lege welche unter „Buchungen" an oder lies einen Kontoauszug ein.</div>`}
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row-between">
        <h3 class="card-title">Soll-Ist-Vergleich <span class="muted" style="font-weight:400">· Budget vs. alle Konten &amp; Kassen</span></h3>
        <button class="btn sm" id="toggleSoll">${F.showSoll ? "ausblenden" : "einblenden"}</button>
      </div>
      ${F.showSoll ? `<div class="note" style="margin:8px 0 0">Zusammengerechnet über Bankkonto + alle Kassen. Soll-Werte erfassen und PDF-Export im Reiter <b>Soll-Ist</b>.</div>
        ${sollIstSection("einnahme", "Einnahmen — Soll-Ist", false)}
        ${sollIstSection("ausgabe", "Ausgaben — Soll-Ist", false)}` : ""}
    </div>`;
  const sa = body.querySelector("#scopeAll");
  if (sa) sa.addEventListener("click", () => { F.konto = ""; renderShell(); });
  body.querySelector("#toggleSoll").addEventListener("click", () => { F.showSoll = !F.showSoll; renderUebersicht(body); });
}
function stat(label, value, tone) {
  return `<div class="stat ${tone}"><div class="stat-l">${esc(label)}</div><div class="stat-v">${esc(value)}</div></div>`;
}

// ---------- Buchungen ----------
function renderBuchungen(body) {
  body.innerHTML = `
    <div class="row-between" style="margin-bottom:12px">
      <div class="filters">
        <select id="fTyp"><option value="">Alle</option><option value="einnahme">Nur Einnahmen</option><option value="ausgabe">Nur Ausgaben</option></select>
        <input id="fSuche" placeholder="Suche Text/Gegenkonto …" style="width:220px">
      </div>
      <button class="btn primary" id="newBk">+ Neue Buchung</button>
    </div>
    <div class="card" id="bkTableWrap"></div>`;
  const draw = () => {
    const typ = body.querySelector("#fTyp").value;
    const q = body.querySelector("#fSuche").value.trim().toLowerCase();
    let rows = kb().slice();
    if (typ) rows = rows.filter((b) => b.typ === typ);
    if (q) rows = rows.filter((b) => ((b.text || "") + " " + (b.gegenkonto || "") + " " + (b.kostenstelle || "")).toLowerCase().includes(q));
    const t = totals(rows);
    body.querySelector("#bkTableWrap").innerHTML = rows.length ? `
      <table class="tbl">
        <thead><tr><th>Datum</th><th>Typ</th><th class="num">Betrag</th><th>Text</th><th>Gegenkonto</th><th>Kostenstelle</th><th>Konto/Kassa</th><th></th></tr></thead>
        <tbody>${rows.map((b) => `<tr>
          <td>${fmtDate(b.datum)}</td>
          <td><span class="pill ${b.typ}">${b.typ === "einnahme" ? "Einnahme" : "Ausgabe"}</span></td>
          <td class="num ${b.typ === "einnahme" ? "pos" : "neg"}">${fmtEUR(b.betrag)}</td>
          <td>${esc(b.text || "")}${b.quelle === "pdf-import" ? ' <span class="tag">PDF</span>' : ""}</td>
          <td>${esc(b.gegenkonto || "")}</td>
          <td>${esc(b.kostenstelle || "")}</td>
          <td>${esc(kontoName(b))}</td>
          <td class="act"><button class="lnk" data-edit="${b.id}">Bearbeiten</button><button class="lnk del" data-del="${b.id}">Löschen</button></td>
        </tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="2">Summe (${rows.length})</td><td class="num">${fmtEUR(t.ein)} − ${fmtEUR(t.aus)} = <b class="${t.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(t.saldo)}</b></td><td colspan="5"></td></tr></tfoot>
      </table>` : `<div class="empty">Keine Buchungen${typ || q ? " für diesen Filter" : ` in ${fyl()}`}${F.konto ? " in " + esc(F.konto) : ""}.</div>`;
    body.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => openBookingForm(F.bookings.find((x) => x.id === el.dataset.edit))));
    body.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => delBooking(el.dataset.del)));
  };
  body.querySelector("#fTyp").addEventListener("change", draw);
  body.querySelector("#fSuche").addEventListener("input", draw);
  body.querySelector("#newBk").addEventListener("click", () => openBookingForm(null));
  draw();
}

function ccOptions(selected) {
  const names = [...new Set([...F.costCenters.map((c) => c.name), ...F.bookings.map((b) => (b.kostenstelle || "").trim()).filter(Boolean)])].sort();
  return `<option value="">— keine —</option>` + names.map((n) => `<option value="${esc(n)}" ${n === selected ? "selected" : ""}>${esc(n)}</option>`).join("");
}

function openBookingForm(b) {
  const edit = !!b;
  const o = b || { datum: todayISO(), typ: "ausgabe", betrag: "", text: "", gegenkonto: "", kostenstelle: "", kategorie: "" };
  const kontoSel = edit ? kontoName(b) : (F.konto || DEFAULT_KONTO);
  const el = modal(`${edit ? "Buchung bearbeiten" : "Neue Buchung"}`, `
    <div class="form-grid">
      <label>Datum<input id="m_datum" type="date" value="${esc(o.datum)}"></label>
      <label>Art<select id="m_typ"><option value="ausgabe" ${o.typ === "ausgabe" ? "selected" : ""}>Ausgabe</option><option value="einnahme" ${o.typ === "einnahme" ? "selected" : ""}>Einnahme</option></select></label>
      <label>Betrag (€)<input id="m_betrag" type="number" step="0.01" min="0" value="${esc(o.betrag)}"></label>
      <label>Konto / Kassa<select id="m_konto">${kontoOptions(kontoSel)}</select></label>
      <label>Kostenstelle<select id="m_ks">${ccOptions(o.kostenstelle)}</select></label>
      <label class="col2">Text / Verwendungszweck<input id="m_text" value="${esc(o.text || "")}"></label>
      <label>Gegenkonto<input id="m_geg" value="${esc(o.gegenkonto || "")}"></label>
      <label>Kategorie<input id="m_kat" value="${esc(o.kategorie || "")}"></label>
    </div>
    <div id="m_err" class="msg err" hidden></div>`,
    [{ label: "Abbrechen", cls: "btn", close: true }, { label: edit ? "Speichern" : "Anlegen", cls: "btn primary", id: "m_save" }]);
  el.querySelector("#m_save").addEventListener("click", async () => {
    const rec = {
      company_id: F.companyId,
      datum: el.querySelector("#m_datum").value,
      typ: el.querySelector("#m_typ").value,
      betrag: Math.abs(parseFloat(el.querySelector("#m_betrag").value) || 0),
      text: el.querySelector("#m_text").value.trim() || null,
      gegenkonto: el.querySelector("#m_geg").value.trim() || null,
      kostenstelle: el.querySelector("#m_ks").value || null,
      konto: el.querySelector("#m_konto").value || null,
      kategorie: el.querySelector("#m_kat").value.trim() || null,
    };
    if (!rec.datum || !rec.betrag) { showErr(el, "Datum und Betrag (> 0) sind nötig."); return; }
    const btn = el.querySelector("#m_save"); btn.disabled = true; btn.textContent = "Speichert …";
    if (!edit) { rec.quelle = "manuell"; rec.created_by = F.userId; }
    const run = () => (edit ? sb.from("bookings").update(rec).eq("id", b.id) : sb.from("bookings").insert(rec));
    let { error } = await run();
    if (error && isKontoMissing(error)) { delete rec.konto; ({ error } = await run()); }
    if (error) { showErr(el, error.message); btn.disabled = false; btn.textContent = edit ? "Speichern" : "Anlegen"; return; }
    closeModal(el); await loadData(); renderShell();
  });
}
async function delBooking(id) {
  if (!confirm("Diese Buchung wirklich löschen?")) return;
  const { error } = await sb.from("bookings").delete().eq("id", id);
  if (error) { alert("Löschen fehlgeschlagen: " + error.message); return; }
  await loadData(); renderShell();
}

// ---------- Kontoauszug einlesen (PDF) ----------
let IMPORT = { rows: [], fileName: "" };
function renderImport(body) {
  body.innerHTML = `
    <div class="card dropzone" id="dz">
      <div class="dz-inner">
        <div class="dz-ic">⬆︎</div>
        <div><b>Kontoauszug als PDF hier ablegen</b> oder <label class="lnk" for="pdfInput">Datei wählen</label></div>
        <div class="note" style="margin-top:4px">Die Buchungszeilen werden automatisch erkannt. Du prüfst und ergänzt Kostenstellen, bevor gespeichert wird.</div>
        <input id="pdfInput" type="file" accept="application/pdf,.pdf" hidden>
      </div>
    </div>
    <div id="importResult"></div>`;
  const dz = body.querySelector("#dz");
  const input = body.querySelector("#pdfInput");
  input.addEventListener("change", () => input.files[0] && handleFile(input.files[0]));
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
}
async function handleFile(file) {
  const res = F.root.querySelector("#importResult");
  res.innerHTML = `<div class="card"><div class="empty">„${esc(file.name)}" wird gelesen … (PDF-Leser wird geladen)</div></div>`;
  try {
    const { rows } = await parseFile(file);
    IMPORT = { rows: rows.map((r, i) => ({ ...r, _id: i, include: true })), fileName: file.name, konto: F.konto || DEFAULT_KONTO };
    if (!rows.length) { res.innerHTML = `<div class="card"><div class="msg info">Keine Buchungszeilen erkannt. Der Auszug hat evtl. ein ungewöhnliches Format — du kannst Buchungen unter „Buchungen" manuell erfassen.</div></div>`; return; }
    drawReview();
  } catch (e) {
    res.innerHTML = `<div class="card"><div class="msg err">PDF konnte nicht gelesen werden: ${esc(e.message || e)}</div>
      <p class="note">Ist es ein echtes PDF (kein Scan-Bild)? Bei gescannten Auszügen ohne Textebene funktioniert die Erkennung nicht.</p></div>`;
  }
}
function drawReview() {
  const res = F.root.querySelector("#importResult");
  const inc = IMPORT.rows.filter((r) => r.include);
  const t = totals(inc.map((r) => ({ typ: r.typ, betrag: r.betrag })));
  res.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="card-title">${IMPORT.rows.length} Zeilen erkannt aus „${esc(IMPORT.fileName)}"</h3>
        <span class="muted">${inc.length} ausgewählt · Einnahmen ${fmtEUR(t.ein)} · Ausgaben ${fmtEUR(t.aus)}</span>
      </div>
      <label class="inline" style="margin-bottom:12px">Importieren in Konto / Kassa
        <select id="impKonto">${kontoOptions(IMPORT.konto)}</select>
      </label>
      <div class="tbl-scroll"><table class="tbl import">
        <thead><tr><th><input type="checkbox" id="chkAll" checked></th><th>Datum</th><th>Art</th><th class="num">Betrag</th><th>Text</th><th>Gegenkonto</th><th>Kostenstelle</th></tr></thead>
        <tbody>${IMPORT.rows.map((r) => `<tr class="${r.include ? "" : "off"}" data-row="${r._id}">
          <td><input type="checkbox" data-inc="${r._id}" ${r.include ? "checked" : ""}></td>
          <td><input type="date" data-f="datum" data-row="${r._id}" value="${esc(r.datum || "")}"></td>
          <td><select data-f="typ" data-row="${r._id}"><option value="ausgabe" ${r.typ === "ausgabe" ? "selected" : ""}>Ausgabe</option><option value="einnahme" ${r.typ === "einnahme" ? "selected" : ""}>Einnahme</option></select></td>
          <td><input type="number" step="0.01" min="0" class="num" data-f="betrag" data-row="${r._id}" value="${r.betrag}"></td>
          <td><input data-f="text" data-row="${r._id}" value="${esc(r.text || "")}" title="${esc(r.raw || "")}"></td>
          <td><input data-f="gegenkonto" data-row="${r._id}" value="${esc(r.gegenkonto || "")}"></td>
          <td><select data-f="kostenstelle" data-row="${r._id}">${ccOptions(r.kostenstelle)}</select></td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="row-between" style="margin-top:14px">
        <button class="btn" id="impCancel">Verwerfen</button>
        <button class="btn primary" id="impSave">${inc.length} Buchungen importieren</button>
      </div>
    </div>`;
  const getRow = (id) => IMPORT.rows.find((r) => r._id == id);
  res.querySelector("#impKonto").addEventListener("change", (e) => { IMPORT.konto = e.target.value; });
  res.querySelector("#chkAll").addEventListener("change", (e) => { IMPORT.rows.forEach((r) => (r.include = e.target.checked)); drawReview(); });
  res.querySelectorAll("[data-inc]").forEach((el) => el.addEventListener("change", () => { getRow(el.dataset.inc).include = el.checked; drawReview(); }));
  res.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => {
    const r = getRow(el.dataset.row); const f = el.dataset.f;
    r[f] = f === "betrag" ? Math.abs(parseFloat(el.value) || 0) : el.value;
  }));
  res.querySelector("#impCancel").addEventListener("click", () => { IMPORT = { rows: [], fileName: "" }; renderTab(); });
  res.querySelector("#impSave").addEventListener("click", importRows);
}
async function importRows(e) {
  const btn = e.target; const inc = IMPORT.rows.filter((r) => r.include && r.datum && r.betrag);
  if (!inc.length) { alert("Keine gültigen Zeilen (Datum + Betrag) ausgewählt."); return; }
  btn.disabled = true; btn.textContent = "Importiert …";
  const batch = uuid();
  const konto = IMPORT.konto || DEFAULT_KONTO;
  const recs = inc.map((r) => ({
    company_id: F.companyId, datum: r.datum, typ: r.typ, betrag: Math.abs(+r.betrag || 0),
    text: (r.text || "").trim() || null, gegenkonto: (r.gegenkonto || "").trim() || null,
    kostenstelle: r.kostenstelle || null, konto, quelle: "pdf-import", import_batch: batch, created_by: F.userId,
  }));
  let { error } = await sb.from("bookings").insert(recs);
  if (error && isKontoMissing(error)) { recs.forEach((r) => delete r.konto); ({ error } = await sb.from("bookings").insert(recs)); }
  if (error) { alert("Import fehlgeschlagen: " + error.message); btn.disabled = false; btn.textContent = inc.length + " Buchungen importieren"; return; }
  IMPORT = { rows: [], fileName: "" };
  F.tab = "buchungen"; F.konto = konto; await loadData(); renderShell();
}

// ---------- Soll-Ist (globales Budget vs. alle Konten & Kassen zusammengerechnet) ----------
function sollIstCats(typ) {
  return [...new Set([
    ...F.costCenters.map((c) => c.name),
    ...F.bookings.filter((b) => b.typ === typ).map((b) => (b.kostenstelle || "").trim() || "(ohne Kostenstelle)"),
    ...F.budgets.filter((b) => b.typ === typ).map((b) => b.kostenstelle),
  ])].filter(Boolean).sort();
}
function sollIstSection(typ, title, editable) {
  const names = sollIstCats(typ);
  const rowsHtml = names.map((k) => sollIstRow(k, typ, sollFor(k, typ), istFor(k, typ), false, editable)).join("");
  const soll = names.reduce((s, k) => s + sollFor(k, typ), 0);
  const ist = names.reduce((s, k) => s + istFor(k, typ), 0);
  return `<div class="card" style="margin-top:14px">
    <h3 class="card-title" style="margin-bottom:10px">${title}</h3>
    <table class="tbl sollist">
      <thead><tr><th>Kostenstelle</th><th class="num">Soll (Budget)</th><th class="num">Ist (alle Kassen)</th><th class="num">Abweichung</th><th class="barcol">Erreichung</th></tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="5" class="empty" style="padding:16px">Keine Kostenstellen. Lege welche an oder erfasse Buchungen.</td></tr>`}</tbody>
      <tfoot>${sollIstRow("Gesamt", typ, soll, ist, true, false)}</tfoot>
    </table>
  </div>`;
}
function renderSollIst(body) {
  body.innerHTML = `
    <div class="row-between" style="margin-bottom:6px">
      <div class="scope-badge">Budget vs. <b>alle Konten &amp; Kassen</b> (zusammengerechnet) · ${fyl()}</div>
      <button class="btn sm" id="sollPdf">PDF exportieren</button>
    </div>
    <div class="note" style="margin-bottom:2px">Das <b>Budget (Soll)</b> gilt gesamt über Bankkonto und alle Kassen. Der <b>Ist-Wert</b> ist die Summe aller Buchungen (Bankkonto + Kassen) je Kostenstelle.</div>
    ${sollIstSection("einnahme", "Einnahmen — Soll-Ist", true)}
    ${sollIstSection("ausgabe", "Ausgaben — Soll-Ist", true)}
    <div class="card" style="margin-top:14px" id="budgetDocCard"><div class="empty">Lädt …</div></div>
    <div id="budgetParseResult"></div>`;
  body.querySelectorAll("[data-soll]").forEach((el) => el.addEventListener("change", () => saveBudget(el.dataset.soll, el.dataset.typ, el.value, el)));
  body.querySelector("#sollPdf").addEventListener("click", () => printSollIst());
  if (F.budgetDocsKey === `${F.companyId}:${F.year}`) renderBudgetDocs();
  else loadBudgetDocs().then(renderBudgetDocs);
}

// ---------- Budgetplanung (PDF-Upload im Storage) ----------
const budgetDir = () => `${F.companyId}/budget/${F.year}`;
async function loadBudgetDocs() {
  const r = await sb.storage.from("dokumente").list(budgetDir(), { limit: 100, sortBy: { column: "created_at", order: "desc" } });
  F.budgetDocsKey = `${F.companyId}:${F.year}`;
  F.budgetDocsErr = r.error ? r.error.message : null;
  F.budgetDocs = r.error ? [] : (r.data || []).filter((f) => f.id);
}
function renderBudgetDocs() {
  const card = F.root && F.root.querySelector("#budgetDocCard");
  if (!card) return;
  const files = F.budgetDocs || [];
  card.innerHTML = `
    <div class="row-between" style="margin-bottom:10px">
      <h3 class="card-title">Budgetplanung (PDF) · ${fyl()}</h3>
      <label class="btn sm" style="cursor:pointer;margin:0">+ PDF hochladen<input id="budgetUp" type="file" accept="application/pdf,.pdf" hidden></label>
    </div>
    ${F.budgetDocsErr
      ? `<div class="msg err">${esc(F.budgetDocsErr)}</div><p class="note">Falls der Datei-Speicher noch fehlt: <code>supabase/schema_dokumente.sql</code> im Supabase-SQL-Editor ausführen.</p>`
      : (files.length ? `<table class="tbl"><tbody>${files.map((f) => `<tr>
          <td>📄 ${esc(f.name.replace(/^\d+-/, ""))}</td>
          <td class="muted">${f.created_at ? fmtDate(f.created_at.slice(0, 10)) : ""}</td>
          <td class="num muted">${f.metadata && f.metadata.size ? Math.round(f.metadata.size / 1024) + " KB" : ""}</td>
          <td class="act"><button class="lnk" data-dopen="${esc(f.name)}">Öffnen</button><button class="lnk" data-dparse="${esc(f.name)}">Kostenstellen einlesen</button><button class="lnk del" data-ddel="${esc(f.name)}">Löschen</button></td>
        </tr>`).join("")}</tbody></table>`
        : `<div class="empty">Noch keine Budgetplanung für ${fyl()} hochgeladen.</div>`)}
    <div id="budgetUpErr" class="msg err" hidden style="margin-top:8px"></div>`;
  const up = card.querySelector("#budgetUp");
  if (up) up.addEventListener("change", () => up.files[0] && uploadBudgetDoc(up.files[0]));
  card.querySelectorAll("[data-dopen]").forEach((el) => el.addEventListener("click", () => openBudgetDoc(el.dataset.dopen)));
  card.querySelectorAll("[data-dparse]").forEach((el) => el.addEventListener("click", () => budgetParseFromStored(el.dataset.dparse)));
  card.querySelectorAll("[data-ddel]").forEach((el) => el.addEventListener("click", () => delBudgetDoc(el.dataset.ddel)));
}
async function uploadBudgetDoc(file) {
  const errEl = F.root.querySelector("#budgetUpErr");
  const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
  if (!/pdf/i.test(file.type || "") && !/\.pdf$/i.test(file.name)) { fail("Bitte eine PDF-Datei wählen."); return; }
  if (file.size > 15 * 1024 * 1024) { fail("Die Datei ist größer als 15 MB."); return; }
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const r = await sb.storage.from("dokumente").upload(`${budgetDir()}/${Date.now()}-${safe}`, file, { contentType: "application/pdf", upsert: false });
  if (r.error) { fail("Upload fehlgeschlagen: " + r.error.message); return; }
  await loadBudgetDocs(); renderBudgetDocs();
  // Kostenstellen + Soll-Werte aus dem PDF erkennen
  budgetParseFromFile(file);
}

// ---------- Budget aus PDF erkennen -> Soll-Ist übernehmen ----------
let BUDGETIMP = { rows: [] };
async function budgetParseFromFile(file) {
  const res = F.root.querySelector("#budgetParseResult");
  if (res) res.innerHTML = `<div class="card" style="margin-top:14px"><div class="empty">Budgetplanung wird ausgewertet …</div></div>`;
  try { const { rows } = await parseBudgetFile(file); showBudgetParse(rows); }
  catch (e) { if (res) res.innerHTML = `<div class="card" style="margin-top:14px"><div class="msg err">Auswertung fehlgeschlagen: ${esc(e.message || e)}</div></div>`; }
}
async function budgetParseFromStored(name) {
  const res = F.root.querySelector("#budgetParseResult");
  if (res) res.innerHTML = `<div class="card" style="margin-top:14px"><div class="empty">„${esc(name.replace(/^\d+-/, ""))}" wird ausgewertet …</div></div>`;
  try {
    const sig = await sb.storage.from("dokumente").createSignedUrl(`${budgetDir()}/${name}`, 120);
    if (sig.error || !sig.data) throw new Error(sig.error ? sig.error.message : "kein Link");
    const buf = await (await fetch(sig.data.signedUrl)).arrayBuffer();
    const { rows } = await parseBudgetBuffer(buf);
    showBudgetParse(rows);
  } catch (e) { if (res) res.innerHTML = `<div class="card" style="margin-top:14px"><div class="msg err">Auswertung fehlgeschlagen: ${esc(e.message || e)}</div></div>`; }
}
function showBudgetParse(rows) {
  BUDGETIMP = { rows: rows.map((r, i) => ({ ...r, _id: i, include: true })) };
  renderBudgetParse();
}
function renderBudgetParse() {
  const res = F.root.querySelector("#budgetParseResult");
  if (!res) return;
  const rows = BUDGETIMP.rows;
  if (!rows.length) {
    res.innerHTML = `<div class="card" style="margin-top:14px"><div class="msg info">Aus dem PDF konnten keine Kostenstellen mit Beträgen erkannt werden. Du kannst die Soll-Werte oben manuell eintragen.</div></div>`;
    return;
  }
  const ccNames = [...new Set([...F.costCenters.map((c) => c.name), ...F.bookings.map((b) => (b.kostenstelle || "").trim()).filter(Boolean)])].sort();
  const ccOpts = (sel) => ccNames.map((n) => `<option value="${esc(n)}" ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("");
  res.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="card-title">${rows.length} Kostenstellen aus der Budgetplanung erkannt</h3>
        <span class="muted">prüfen, dann übernehmen</span>
      </div>
      <p class="note" style="margin:0 0 10px">Neue Kostenstellen werden angelegt, der Soll-Wert wird für <b>${fyl()}</b> gesetzt. Namen/Art/Betrag kannst du vorher korrigieren; per Liste wählst du einen bestehenden Namen.</p>
      <div class="tbl-scroll"><table class="tbl import">
        <thead><tr><th><input type="checkbox" id="bpAll" checked></th><th>Kostenstelle</th><th>bestehende wählen</th><th>Art</th><th class="num">Soll (€)</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.include ? "" : "off"}">
          <td><input type="checkbox" data-bpinc="${r._id}" ${r.include ? "checked" : ""}></td>
          <td><input data-bpf="kostenstelle" data-row="${r._id}" value="${esc(r.kostenstelle)}"></td>
          <td><select data-bpf="pick" data-row="${r._id}"><option value="">— neu —</option>${ccOpts("")}</select></td>
          <td><select data-bpf="typ" data-row="${r._id}"><option value="ausgabe" ${r.typ === "ausgabe" ? "selected" : ""}>Ausgabe</option><option value="einnahme" ${r.typ === "einnahme" ? "selected" : ""}>Einnahme</option></select></td>
          <td><input class="num" type="number" step="0.01" data-bpf="soll" data-row="${r._id}" value="${r.soll}"></td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="row-between" style="margin-top:14px">
        <button class="btn" id="bpCancel">Verwerfen</button>
        <button class="btn primary" id="bpApply">Ins Budget übernehmen</button>
      </div>
      <div id="bpErr" class="msg err" hidden style="margin-top:10px"></div>
    </div>`;
  const get = (id) => BUDGETIMP.rows.find((r) => r._id == id);
  res.querySelector("#bpAll").addEventListener("change", (e) => { BUDGETIMP.rows.forEach((r) => (r.include = e.target.checked)); renderBudgetParse(); });
  res.querySelectorAll("[data-bpinc]").forEach((el) => el.addEventListener("change", () => { get(el.dataset.bpinc).include = el.checked; renderBudgetParse(); }));
  res.querySelectorAll("[data-bpf]").forEach((el) => el.addEventListener("change", () => {
    const r = get(el.dataset.row), f = el.dataset.bpf;
    if (f === "pick") { if (el.value) { r.kostenstelle = el.value; renderBudgetParse(); } }
    else r[f] = f === "soll" ? Math.abs(parseFloat(el.value) || 0) : el.value;
  }));
  res.querySelector("#bpCancel").addEventListener("click", () => { BUDGETIMP = { rows: [] }; res.innerHTML = ""; });
  res.querySelector("#bpApply").addEventListener("click", applyBudgetParse);
}
async function applyBudgetParse(e) {
  const btn = e.target;
  const rows = BUDGETIMP.rows.filter((r) => r.include && (r.kostenstelle || "").trim() && r.soll > 0);
  if (!rows.length) { const er = F.root.querySelector("#bpErr"); if (er) { er.textContent = "Keine gültigen Zeilen (Name + Soll > 0)."; er.hidden = false; } return; }
  btn.disabled = true; btn.textContent = "Übernimmt …";
  // 1) fehlende Kostenstellen anlegen
  const names = [...new Set(rows.map((r) => r.kostenstelle.trim()))];
  const ccRecs = names.map((name) => ({ company_id: F.companyId, name }));
  await sb.from("cost_centers").upsert(ccRecs, { onConflict: "company_id,name", ignoreDuplicates: true });
  // 2) Soll-Werte (Budget) setzen – pro Kostenstelle+Art der letzte Wert gewinnt
  const bgMap = new Map();
  for (const r of rows) {
    const key = r.kostenstelle.trim() + "|" + r.typ;
    if (bgMap.has(key)) bgMap.get(key).soll = Math.round((bgMap.get(key).soll + r.soll) * 100) / 100;
    else bgMap.set(key, { company_id: F.companyId, jahr: F.year, konto: "ALLE", kostenstelle: r.kostenstelle.trim(), typ: r.typ, soll: r.soll });
  }
  const bgRecs = [...bgMap.values()];
  let { error } = await sb.from("budgets").upsert(bgRecs, { onConflict: "company_id,jahr,konto,kostenstelle,typ" });
  if (error && isKontoMissing(error)) { bgRecs.forEach((b) => delete b.konto); ({ error } = await sb.from("budgets").upsert(bgRecs, { onConflict: "company_id,jahr,kostenstelle,typ" })); }
  if (error) { const er = F.root.querySelector("#bpErr"); if (er) { er.textContent = "Übernahme fehlgeschlagen: " + error.message; er.hidden = false; } btn.disabled = false; btn.textContent = "Ins Budget übernehmen"; return; }
  BUDGETIMP = { rows: [] };
  await loadData();
  renderSollIst(F.root.querySelector("#finBody"));
}
async function openBudgetDoc(name) {
  const w = window.open("", "_blank");
  const r = await sb.storage.from("dokumente").createSignedUrl(`${budgetDir()}/${name}`, 120);
  if (r.error || !r.data) { if (w) w.close(); alert("Konnte Datei nicht öffnen: " + (r.error ? r.error.message : "")); return; }
  if (w) w.location.href = r.data.signedUrl; else window.open(r.data.signedUrl, "_blank");
}
async function delBudgetDoc(name) {
  if (!confirm("Diese Budgetplanung wirklich löschen?")) return;
  const r = await sb.storage.from("dokumente").remove([`${budgetDir()}/${name}`]);
  if (r.error) { alert("Löschen fehlgeschlagen: " + r.error.message); return; }
  await loadBudgetDocs(); renderBudgetDocs();
}
function sollIstRow(k, typ, soll, ist, isFoot, editable) {
  const diff = typ === "einnahme" ? ist - soll : soll - ist; // positiv = günstig
  const pct = soll > 0 ? Math.round((ist / soll) * 100) : (ist > 0 ? 100 : 0);
  const good = diff >= 0;
  const barColor = typ === "einnahme" ? (good ? "var(--good)" : "var(--warn)") : (ist <= soll ? "var(--good)" : "var(--crit)");
  const sollCell = (!isFoot && editable)
    ? `<td class="num"><input type="number" step="0.01" min="0" class="soll-inp" data-soll="${esc(k)}" data-typ="${typ}" value="${soll || ""}" placeholder="0,00"></td>`
    : `<td class="num">${fmtEUR(soll)}</td>`;
  return `<tr class="${isFoot ? "foot" : ""}">
    <td>${esc(k)}</td>
    ${sollCell}
    <td class="num">${fmtEUR(ist)}</td>
    <td class="num ${good ? "pos" : "neg"}">${diff >= 0 ? "+" : ""}${fmtEUR(diff)}</td>
    <td class="barcol"><div class="bar"><span style="width:${Math.min(100, pct)}%;background:${barColor}"></span></div><span class="pctlbl">${soll > 0 ? pct + "%" : "–"}</span></td>
  </tr>`;
}
async function saveBudget(kostenstelle, typ, value, el) {
  const soll = parseFloat(value) || 0;
  const konto = "ALLE"; // globales Budget (ein Wert über alle Konten/Kassen)
  const rec = { company_id: F.companyId, jahr: F.year, konto, kostenstelle, typ, soll };
  let { error } = await sb.from("budgets").upsert(rec, { onConflict: "company_id,jahr,konto,kostenstelle,typ" });
  if (error && isKontoMissing(error)) { delete rec.konto; ({ error } = await sb.from("budgets").upsert(rec, { onConflict: "company_id,jahr,kostenstelle,typ" })); }
  if (error) { el.classList.add("saveerr"); el.title = error.message; return; }
  const existing = F.budgets.find((b) => b.kostenstelle === kostenstelle && b.typ === typ);
  if (existing) existing.soll = soll; else F.budgets.push(rec);
  el.classList.remove("saveerr"); el.classList.add("saved");
  setTimeout(() => el.classList.remove("saved"), 900);
  renderSollIst(F.root.querySelector("#finBody"));
}

// ---------- Soll-Ist als PDF ----------
function printSollIst() {
  const c = company();
  const scopeLabel = "Budget vs. alle Konten & Kassen (zusammengerechnet)";
  const sec = (typ, title) => {
    const names = sollIstCats(typ);
    const body = names.map((k) => {
      const soll = sollFor(k, typ), ist = istFor(k, typ), diff = typ === "einnahme" ? ist - soll : soll - ist;
      return `<tr><td>${esc(k)}</td><td class="n">${fmtEUR(soll)}</td><td class="n">${fmtEUR(ist)}</td><td class="n">${diff >= 0 ? "+" : ""}${fmtEUR(diff)}</td></tr>`;
    }).join("");
    const soll = names.reduce((s, k) => s + sollFor(k, typ), 0), ist = names.reduce((s, k) => s + istFor(k, typ), 0);
    const diff = typ === "einnahme" ? ist - soll : soll - ist;
    return `<h3>${title}</h3><table class="p"><thead><tr><th>Kostenstelle</th><th class="n">Soll</th><th class="n">Ist</th><th class="n">Abweichung</th></tr></thead>
      <tbody>${body || `<tr><td colspan="4">—</td></tr>`}</tbody>
      <tfoot><tr><td>Gesamt</td><td class="n">${fmtEUR(soll)}</td><td class="n">${fmtEUR(ist)}</td><td class="n">${diff >= 0 ? "+" : ""}${fmtEUR(diff)}</td></tr></tfoot></table>`;
  };
  const accent = (c.design && c.design.accent) || "#184437";
  const html = `
    <style>
      @page{ size:A4; margin:16mm; }
      #print-doc{ font-family:Helvetica,Arial,sans-serif; color:#1a211c; }
      #print-doc h1{ color:${accent}; font-size:18pt; margin:0 0 2px; }
      #print-doc .sub{ color:#555; font-size:10pt; margin-bottom:14px; }
      #print-doc h3{ color:${accent}; font-size:12pt; margin:16px 0 4px; }
      #print-doc table.p{ width:100%; border-collapse:collapse; font-size:10pt; }
      #print-doc table.p th{ text-align:left; background:${accent}; color:#fff; padding:5px 8px; font-size:8.5pt; }
      #print-doc table.p td{ padding:5px 8px; border-bottom:1px solid #e3e0d6; }
      #print-doc table.p .n{ text-align:right; white-space:nowrap; }
      #print-doc table.p tfoot td{ font-weight:700; border-top:2px solid ${accent}; }
    </style>
    <h1>Soll-Ist-Vergleich ${fyl()}</h1>
    <div class="sub">${esc(c.name || "")} · ${esc(scopeLabel)} · erstellt ${fmtDate(todayISO())}</div>
    ${sec("einnahme", "Einnahmen")}
    ${sec("ausgabe", "Ausgaben")}`;
  const holder = document.createElement("div");
  holder.id = "print-doc"; holder.innerHTML = html;
  document.body.appendChild(holder);
  const cleanup = () => { holder.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  setTimeout(() => window.print(), 60);
}

// ---------- Kostenstellen & Kassen ----------
function renderKostenstellen(body) {
  body.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start">
      <div class="card">
        <h3 class="card-title" style="margin-bottom:10px">Kostenstellen · ${esc(company().name || "")}</h3>
        <div class="ks-add"><input id="ksName" placeholder="z. B. Spielbetrieb, Nachwuchs, Verwaltung"><button class="btn primary" id="ksAdd">Hinzufügen</button></div>
        <div id="ksList" class="ks-list">${ksListHtml()}</div>
        <p class="note">Gliedern Einnahmen/Ausgaben und Soll-Ist je Bereich. Bei jeder Buchung und beim PDF-Import zuordenbar.</p>
      </div>
      <div class="card">
        <h3 class="card-title" style="margin-bottom:10px">Konten / Kassen</h3>
        <div class="ks-add"><input id="koName" placeholder="z. B. Handkassa, Jugendkassa"><button class="btn primary" id="koAdd">Hinzufügen</button></div>
        <div class="ks-list">${kontenListHtml()}</div>
        <p class="note">„Bankkonto" ist immer vorhanden. Jede Kassa wird im Überblick & Soll-Ist getrennt ausgewiesen und kann eigene Buchungen/PDF-Importe haben.</p>
      </div>
    </div>`;
  const addKs = async () => {
    const name = body.querySelector("#ksName").value.trim();
    if (!name) return;
    const { error } = await sb.from("cost_centers").insert({ company_id: F.companyId, name });
    if (error) { alert(error.message.includes("duplicate") ? "Gibt es schon." : error.message); return; }
    body.querySelector("#ksName").value = ""; await loadData(); renderKostenstellen(body);
  };
  body.querySelector("#ksAdd").addEventListener("click", addKs);
  body.querySelector("#ksName").addEventListener("keydown", (e) => { if (e.key === "Enter") addKs(); });
  body.querySelectorAll("[data-ksdel]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Kostenstelle löschen? Bereits gebuchte Zeilen behalten den Namen als Text.")) return;
    await sb.from("cost_centers").delete().eq("id", el.dataset.ksdel); await loadData(); renderKostenstellen(body);
  }));
  const addKo = async () => {
    const name = body.querySelector("#koName").value.trim();
    if (!name) return;
    if (name.toLowerCase() === DEFAULT_KONTO.toLowerCase()) { alert("Bankkonto gibt es bereits."); return; }
    const { error } = await sb.from("konten").insert({ company_id: F.companyId, name, sort: F.konten.length + 1 });
    if (error) { alert(error.message.includes("duplicate") ? "Gibt es schon." : error.message); return; }
    body.querySelector("#koName").value = ""; await loadData(); renderKostenstellen(body);
  };
  body.querySelector("#koAdd").addEventListener("click", addKo);
  body.querySelector("#koName").addEventListener("keydown", (e) => { if (e.key === "Enter") addKo(); });
  body.querySelectorAll("[data-kodel]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Kasse löschen? Bereits gebuchte Zeilen behalten den Namen als Text.")) return;
    await sb.from("konten").delete().eq("id", el.dataset.kodel); await loadData(); renderKostenstellen(body);
  }));
}
function ksListHtml() {
  if (!F.costCenters.length) return `<div class="empty" style="padding:16px">Noch keine Kostenstellen.</div>`;
  return F.costCenters.map((c) => `<div class="ks-row"><span>${esc(c.name)}</span><button class="lnk del" data-ksdel="${c.id}">entfernen</button></div>`).join("");
}
function kontenListHtml() {
  const rows = [`<div class="ks-row"><span>${esc(DEFAULT_KONTO)} <span class="tag">Standard</span></span></div>`];
  for (const k of F.konten) rows.push(`<div class="ks-row"><span>${esc(k.name)}</span><button class="lnk del" data-kodel="${k.id}">entfernen</button></div>`);
  return rows.join("");
}

// (Modal/Fehler-Helfer liegen in ui.js)
