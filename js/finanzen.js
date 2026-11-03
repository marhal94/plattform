// Finanzen-Modul: Einnahmen-Ausgaben-Rechnung (EAR), Buchungen,
// Kontoauszug-PDF-Import, Soll-Ist-Vergleich, Kostenstellen.
import { sb, esc, fmtEUR, fmtNum, fmtDate, todayISO, uuid } from "./db.js";
import { parseFile } from "./pdfimport.js";

const F = {
  companies: [], companyId: null,
  year: new Date().getFullYear(),
  tab: "uebersicht",
  bookings: [], costCenters: [], budgets: [],
  userId: null, root: null, err: null,
};

const TABS = [
  { id: "uebersicht", label: "Übersicht (EAR)" },
  { id: "buchungen", label: "Buchungen" },
  { id: "import", label: "Kontoauszug einlesen" },
  { id: "sollist", label: "Soll-Ist" },
  { id: "kostenstellen", label: "Kostenstellen" },
];

const schemaHint = (msg) => `<div class="card"><div class="msg err">${esc(msg)}</div>
  <p class="note">Falls Tabellen fehlen: <code>supabase/schema_finanzen.sql</code> im Supabase-SQL-Editor ausführen.</p></div>`;

// ---------- Datenzugriff ----------
async function loadCompanies() {
  const { data, error } = await sb.from("companies").select("id,key,name,form,plz,ort,tax_mode,design,umsatzziel").order("name");
  if (error) return error.message;
  F.companies = data || [];
  return null;
}
async function loadData() {
  F.err = null;
  const from = `${F.year}-01-01`, to = `${F.year}-12-31`;
  const [bk, cc, bg, usr] = await Promise.all([
    sb.from("bookings").select("*").eq("company_id", F.companyId).gte("datum", from).lte("datum", to).order("datum", { ascending: false }),
    sb.from("cost_centers").select("*").eq("company_id", F.companyId).order("name"),
    sb.from("budgets").select("*").eq("company_id", F.companyId).eq("jahr", F.year),
    F.userId ? Promise.resolve(null) : sb.auth.getUser(),
  ]);
  if (usr && usr.data) F.userId = usr.data.user ? usr.data.user.id : null;
  if (bk.error) { F.err = bk.error.message; return; }
  F.bookings = bk.data || [];
  F.costCenters = cc.error ? [] : (cc.data || []);
  F.budgets = bg.error ? [] : (bg.data || []);
}

// ---------- Berechnungen ----------
const company = () => F.companies.find((c) => c.id === F.companyId) || {};
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
function istFor(kostenstelle, typ) {
  return F.bookings.filter((b) => b.typ === typ && ((b.kostenstelle || "").trim() || "(ohne Kostenstelle)") === kostenstelle)
    .reduce((s, b) => s + (+b.betrag || 0), 0);
}
const sollFor = (kostenstelle, typ) => { const r = F.budgets.find((b) => b.kostenstelle === kostenstelle && b.typ === typ); return r ? +r.soll : 0; };

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
        <label class="inline">Jahr
          <select id="finYear">${yearOptions()}</select>
        </label>
      </div>
    </div>
    <div class="subnav">${TABS.map((t) => `<button data-tab="${t.id}" class="${F.tab === t.id ? "active" : ""}">${t.label}</button>`).join("")}</div>
    <div id="finBody"></div>`;
  root.style.setProperty("--co-accent", accent);
  root.querySelector("#finCo").addEventListener("change", async (e) => { F.companyId = e.target.value; await loadData(); renderShell(); });
  root.querySelector("#finYear").addEventListener("change", async (e) => { F.year = +e.target.value; await loadData(); renderShell(); });
  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { F.tab = b.dataset.tab; renderShell(); }));
  renderTab();
}

function yearOptions() {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now + 1; y >= now - 5; y--) years.push(y);
  if (!years.includes(F.year)) years.push(F.year);
  return years.sort((a, b) => b - a).map((y) => `<option value="${y}" ${y === F.year ? "selected" : ""}>${y}</option>`).join("");
}

function renderTab() {
  const body = F.root.querySelector("#finBody");
  if (F.err) { body.innerHTML = schemaHint("Fehler: " + F.err); return; }
  if (F.tab === "buchungen") return renderBuchungen(body);
  if (F.tab === "import") return renderImport(body);
  if (F.tab === "sollist") return renderSollIst(body);
  if (F.tab === "kostenstellen") return renderKostenstellen(body);
  return renderUebersicht(body);
}

// ---------- Übersicht (EAR) ----------
function renderUebersicht(body) {
  const t = totals();
  const rows = byKostenstelle();
  const c = company();
  const ziel = c.umsatzziel ? +c.umsatzziel : 0;
  const zielPct = ziel ? Math.min(100, Math.round((t.ein / ziel) * 100)) : 0;
  body.innerHTML = `
    <div class="stat-row">
      ${stat("Einnahmen", fmtEUR(t.ein), "good")}
      ${stat("Ausgaben", fmtEUR(t.aus), "crit")}
      ${stat(t.saldo >= 0 ? "Überschuss" : "Abgang", fmtEUR(t.saldo), t.saldo >= 0 ? "good" : "crit")}
      ${stat("Buchungen", String(F.bookings.length), "plain")}
    </div>
    ${ziel ? `<div class="card" style="margin-top:14px"><div class="row-between"><label style="margin:0">Umsatzziel ${F.year}</label><span class="muted">${fmtEUR(t.ein)} / ${fmtEUR(ziel)} · ${zielPct}%</span></div>
      <div class="bar" style="margin-top:8px"><span style="width:${zielPct}%;background:var(--good)"></span></div></div>` : ""}
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px"><h3 class="card-title">Nach Kostenstelle</h3><span class="muted">${F.year}</span></div>
      ${rows.length ? `<table class="tbl">
        <thead><tr><th>Kostenstelle</th><th class="num">Einnahmen</th><th class="num">Ausgaben</th><th class="num">Saldo</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td>${esc(r.k)}</td><td class="num pos">${fmtEUR(r.ein)}</td><td class="num neg">${fmtEUR(r.aus)}</td>
          <td class="num ${r.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(r.saldo)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Summe</td><td class="num pos">${fmtEUR(t.ein)}</td><td class="num neg">${fmtEUR(t.aus)}</td><td class="num ${t.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(t.saldo)}</td></tr></tfoot>
      </table>` : `<div class="empty">Noch keine Buchungen in ${F.year}. Lege welche unter „Buchungen" an oder lies einen Kontoauszug ein.</div>`}
    </div>`;
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
    let rows = F.bookings.slice();
    if (typ) rows = rows.filter((b) => b.typ === typ);
    if (q) rows = rows.filter((b) => ((b.text || "") + " " + (b.gegenkonto || "") + " " + (b.kostenstelle || "")).toLowerCase().includes(q));
    const t = totals(rows);
    body.querySelector("#bkTableWrap").innerHTML = rows.length ? `
      <table class="tbl">
        <thead><tr><th>Datum</th><th>Typ</th><th class="num">Betrag</th><th>Text</th><th>Gegenkonto</th><th>Kostenstelle</th><th></th></tr></thead>
        <tbody>${rows.map((b) => `<tr>
          <td>${fmtDate(b.datum)}</td>
          <td><span class="pill ${b.typ}">${b.typ === "einnahme" ? "Einnahme" : "Ausgabe"}</span></td>
          <td class="num ${b.typ === "einnahme" ? "pos" : "neg"}">${fmtEUR(b.betrag)}</td>
          <td>${esc(b.text || "")}${b.quelle === "pdf-import" ? ' <span class="tag">PDF</span>' : ""}</td>
          <td>${esc(b.gegenkonto || "")}</td>
          <td>${esc(b.kostenstelle || "")}</td>
          <td class="act"><button class="lnk" data-edit="${b.id}">Bearbeiten</button><button class="lnk del" data-del="${b.id}">Löschen</button></td>
        </tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="2">Summe (${rows.length})</td><td class="num">${fmtEUR(t.ein)} − ${fmtEUR(t.aus)} = <b class="${t.saldo >= 0 ? "pos" : "neg"}">${fmtEUR(t.saldo)}</b></td><td colspan="4"></td></tr></tfoot>
      </table>` : `<div class="empty">Keine Buchungen${typ || q ? " für diesen Filter" : ` in ${F.year}`}.</div>`;
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
  const el = modal(`${edit ? "Buchung bearbeiten" : "Neue Buchung"}`, `
    <div class="form-grid">
      <label>Datum<input id="m_datum" type="date" value="${esc(o.datum)}"></label>
      <label>Art<select id="m_typ"><option value="ausgabe" ${o.typ === "ausgabe" ? "selected" : ""}>Ausgabe</option><option value="einnahme" ${o.typ === "einnahme" ? "selected" : ""}>Einnahme</option></select></label>
      <label>Betrag (€)<input id="m_betrag" type="number" step="0.01" min="0" value="${esc(o.betrag)}"></label>
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
      kategorie: el.querySelector("#m_kat").value.trim() || null,
    };
    if (!rec.datum || !rec.betrag) { showErr(el, "Datum und Betrag (> 0) sind nötig."); return; }
    const btn = el.querySelector("#m_save"); btn.disabled = true; btn.textContent = "Speichert …";
    let error;
    if (edit) ({ error } = await sb.from("bookings").update(rec).eq("id", b.id));
    else { rec.quelle = "manuell"; rec.created_by = F.userId; ({ error } = await sb.from("bookings").insert(rec)); }
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
    IMPORT = { rows: rows.map((r, i) => ({ ...r, _id: i, include: true })), fileName: file.name };
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
  const recs = inc.map((r) => ({
    company_id: F.companyId, datum: r.datum, typ: r.typ, betrag: Math.abs(+r.betrag || 0),
    text: (r.text || "").trim() || null, gegenkonto: (r.gegenkonto || "").trim() || null,
    kostenstelle: r.kostenstelle || null, quelle: "pdf-import", import_batch: batch, created_by: F.userId,
  }));
  const { error } = await sb.from("bookings").insert(recs);
  if (error) { alert("Import fehlgeschlagen: " + error.message); btn.disabled = false; btn.textContent = inc.length + " Buchungen importieren"; return; }
  IMPORT = { rows: [], fileName: "" };
  F.tab = "buchungen"; await loadData(); renderShell();
}

// ---------- Soll-Ist ----------
function renderSollIst(body) {
  const cats = (typ) => {
    const names = [...new Set([
      ...F.costCenters.map((c) => c.name),
      ...F.bookings.filter((b) => b.typ === typ).map((b) => (b.kostenstelle || "").trim() || "(ohne Kostenstelle)"),
      ...F.budgets.filter((b) => b.typ === typ).map((b) => b.kostenstelle),
    ])].filter(Boolean).sort();
    return names;
  };
  const section = (typ, title) => {
    const names = cats(typ);
    const rowsHtml = names.map((k) => {
      const soll = sollFor(k, typ), ist = istFor(k, typ);
      return sollIstRow(k, typ, soll, ist);
    }).join("");
    const soll = names.reduce((s, k) => s + sollFor(k, typ), 0);
    const ist = names.reduce((s, k) => s + istFor(k, typ), 0);
    return `<div class="card" style="margin-top:14px">
      <h3 class="card-title" style="margin-bottom:10px">${title}</h3>
      <table class="tbl sollist">
        <thead><tr><th>Kostenstelle</th><th class="num">Soll</th><th class="num">Ist</th><th class="num">Abweichung</th><th class="barcol">Erreichung</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="5" class="empty" style="padding:16px">Keine Kostenstellen. Lege welche an oder erfasse Buchungen.</td></tr>`}</tbody>
        <tfoot>${sollIstRow("Gesamt", typ, soll, ist, true)}</tfoot>
      </table>
    </div>`;
  };
  body.innerHTML = `<div class="note" style="margin-bottom:2px">Trage je Kostenstelle den <b>Soll-Wert (Budget)</b> für ${F.year} ein. Der Ist-Wert wird automatisch aus den Buchungen berechnet.</div>
    ${section("einnahme", "Einnahmen — Soll-Ist")}
    ${section("ausgabe", "Ausgaben — Soll-Ist")}`;
  body.querySelectorAll("[data-soll]").forEach((el) => el.addEventListener("change", () => saveBudget(el.dataset.soll, el.dataset.typ, el.value, el)));
}
function sollIstRow(k, typ, soll, ist, isFoot) {
  const diff = typ === "einnahme" ? ist - soll : soll - ist; // positiv = günstig
  const pct = soll > 0 ? Math.round((ist / soll) * 100) : (ist > 0 ? 100 : 0);
  const good = diff >= 0;
  const barColor = typ === "einnahme" ? (good ? "var(--good)" : "var(--warn)") : (ist <= soll ? "var(--good)" : "var(--crit)");
  const sollCell = isFoot
    ? `<td class="num">${fmtEUR(soll)}</td>`
    : `<td class="num"><input type="number" step="0.01" min="0" class="soll-inp" data-soll="${esc(k)}" data-typ="${typ}" value="${soll || ""}" placeholder="0,00"></td>`;
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
  const rec = { company_id: F.companyId, jahr: F.year, kostenstelle, typ, soll };
  const { error } = await sb.from("budgets").upsert(rec, { onConflict: "company_id,jahr,kostenstelle,typ" });
  if (error) { el.classList.add("saveerr"); el.title = error.message; return; }
  const existing = F.budgets.find((b) => b.kostenstelle === kostenstelle && b.typ === typ);
  if (existing) existing.soll = soll; else F.budgets.push(rec);
  el.classList.remove("saveerr"); el.classList.add("saved");
  setTimeout(() => el.classList.remove("saved"), 900);
  // Abweichung/Bar live aktualisieren
  renderSollIst(F.root.querySelector("#finBody"));
}

// ---------- Kostenstellen ----------
function renderKostenstellen(body) {
  body.innerHTML = `
    <div class="card" style="max-width:520px">
      <h3 class="card-title" style="margin-bottom:10px">Kostenstellen · ${esc(company().name || "")}</h3>
      <div class="ks-add"><input id="ksName" placeholder="z. B. Spielbetrieb, Nachwuchs, Verwaltung"><button class="btn primary" id="ksAdd">Hinzufügen</button></div>
      <div id="ksList" class="ks-list">${ksListHtml()}</div>
      <p class="note">Kostenstellen helfen, Einnahmen/Ausgaben zu gliedern und Soll-Ist je Bereich zu vergleichen. Du kannst sie bei jeder Buchung und beim PDF-Import zuordnen.</p>
    </div>`;
  const add = async () => {
    const name = body.querySelector("#ksName").value.trim();
    if (!name) return;
    const { error } = await sb.from("cost_centers").insert({ company_id: F.companyId, name });
    if (error) { alert(error.message.includes("duplicate") ? "Gibt es schon." : error.message); return; }
    body.querySelector("#ksName").value = "";
    await loadData(); renderKostenstellen(body);
  };
  body.querySelector("#ksAdd").addEventListener("click", add);
  body.querySelector("#ksName").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  body.querySelectorAll("[data-ksdel]").forEach((el) => el.addEventListener("click", async () => {
    if (!confirm("Kostenstelle löschen? Bereits gebuchte Zeilen behalten den Namen als Text.")) return;
    await sb.from("cost_centers").delete().eq("id", el.dataset.ksdel);
    await loadData(); renderKostenstellen(body);
  }));
}
function ksListHtml() {
  if (!F.costCenters.length) return `<div class="empty" style="padding:16px">Noch keine Kostenstellen.</div>`;
  return F.costCenters.map((c) => `<div class="ks-row"><span>${esc(c.name)}</span><button class="lnk del" data-ksdel="${c.id}">entfernen</button></div>`).join("");
}

// ---------- Mini-Modal ----------
function modal(title, inner, actions) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" aria-label="Schließen">✕</button></div>
    <div class="modal-body">${inner}</div>
    <div class="modal-foot">${actions.map((a) => `<button class="${a.cls}" ${a.id ? `id="${a.id}"` : ""} ${a.close ? 'data-close="1"' : ""}>${esc(a.label)}</button>`).join("")}</div></div>`;
  document.body.appendChild(back);
  const close = () => closeModal(back);
  back.querySelector(".modal-x").addEventListener("click", close);
  back.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  let downOnBack = false;
  back.addEventListener("mousedown", (e) => { downOnBack = e.target === back; });
  back.addEventListener("mouseup", (e) => { if (downOnBack && e.target === back) close(); });
  return back;
}
function closeModal(el) { el.remove(); }
function showErr(el, msg) { const e = el.querySelector("#m_err"); if (e) { e.textContent = msg; e.hidden = false; } }
