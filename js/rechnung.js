// Rechnungsmodul: Ausgangsrechnungen erstellen, speichern, drucken (PDF),
// mit Unternehmens-Design, Positionen/Rabatten, Nummernkreis, SEPA-QR.
// Bezahlte Rechnungen werden als Einnahme in die EAR gebucht.
import { sb, esc, fmtEUR, fmtDate, todayISO, uuid, fyStartMonth, fyRange, fyLabel } from "./db.js";
import { modal, showErr } from "./ui.js";
import { loadKatalog, customers, products, upsertCustomerFromInvoice, upsertProductsFromPositions } from "./katalog.js";

const R = { company: null, year: null, refresh: null, view: "list", invoices: [], draft: null, userId: null, err: null };

// ---------- PDF-Bibliotheken (lazy) ----------
let _qr = null, _jspdf = null;
async function qrLib() { if (!_qr) { const m = await import("https://esm.sh/qrcode@1.5.3"); _qr = m.default || m; } return _qr; }
async function jsPDFLib() { if (!_jspdf) { const m = await import("https://esm.sh/jspdf@2.5.1"); _jspdf = m.jsPDF || (m.default && m.default.jsPDF) || m.default; } return _jspdf; }
function hexRgb(hex) { hex = String(hex || "#184437").replace("#", ""); if (hex.length === 3) hex = hex.split("").map((c) => c + c).join(""); return [parseInt(hex.slice(0, 2), 16) || 0, parseInt(hex.slice(2, 4), 16) || 0, parseInt(hex.slice(4, 6), 16) || 0]; }
// Betrag fürs PDF: 1.234,56 (eigene Formatierung, da Standard-Helvetica kein €-Glyph hat
// und toLocaleString je nach Umgebung schmale Leerzeichen als Tausendertrenner liefert)
function fmtDe(n) {
  const neg = (Number(n) || 0) < 0;
  const s = Math.abs(Math.round((Number(n) || 0) * 100) / 100).toFixed(2).split(".");
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + s[0] + "," + s[1];
}
const eur = (n) => fmtDe(n) + " EUR";

// ---------- Helfer ----------
function defaultSteuer(c) {
  if (c.design && c.design.steuer) return c.design.steuer;
  if (c.tax_mode === "klein") return "Gemäß § 6 Abs. 1 Z 27 UStG (Kleinunternehmerregelung) wird keine Umsatzsteuer berechnet.";
  if (c.tax_mode === "verein") return "Es wird keine Umsatzsteuer ausgewiesen (nicht unternehmerischer Bereich).";
  return "";
}
function nbOf(c) { const n = c.numbering || {}; return { prefix: n.prefix || "RE", useYear: n.useYear !== false, sep: n.sep || "-", pad: n.pad || 4, next: n.next || 1 }; }
function formatNummer(c, year, n) {
  const nb = nbOf(c); const num = String(n).padStart(nb.pad, "0");
  return nb.useYear ? `${nb.prefix}${nb.sep}${year}${nb.sep}${num}` : `${nb.prefix}${nb.sep}${num}`;
}
const lineNet = (p) => (+p.menge || 0) * (+p.einzelpreis || 0) * (1 - (+p.rabatt || 0) / 100);
function calcTotals(positionen, gesamtrabatt, taxMode) {
  let zwischen = 0;
  const pos = positionen.map((p) => { const netto = Math.round(lineNet(p) * 100) / 100; zwischen += netto; return { ...p, netto }; });
  const rab = Math.round(zwischen * ((+gesamtrabatt || 0) / 100) * 100) / 100;
  const netto = Math.round((zwischen - rab) * 100) / 100;
  const ustSatz = taxMode === "regel" ? 20 : 0;
  const ust = Math.round(netto * ustSatz) / 100;
  const brutto = Math.round((netto + ust) * 100) / 100;
  return { pos, zwischen, rab, netto, ust, ustSatz, brutto };
}
function epcPayload(c, brutto, verwendung) {
  const name = (c.name || "").slice(0, 70);
  const iban = (c.iban || "").replace(/\s/g, "");
  const bic = (c.bic || "").replace(/\s/g, "");
  return ["BCD", "002", "1", "SCT", bic, name, iban, "EUR" + Number(brutto).toFixed(2), "", "", (verwendung || "").slice(0, 140), ""].join("\n");
}
function addDays(iso, days) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

// ---------- Einstieg ----------
export async function renderRechnungen(body, company, year, refresh) {
  if (R.company && (R.company.id !== company.id || R.year !== year)) R.view = "list";
  R.company = company; R.year = year; R.refresh = refresh; R.body = body;
  if (!R.userId) { const u = await sb.auth.getUser(); R.userId = u.data && u.data.user ? u.data.user.id : null; }
  await loadKatalog(company.id);
  if (R.view === "edit") return renderEditor();
  await loadInvoices();
  renderList();
}
async function loadInvoices() {
  const { data, error } = await sb.from("invoices").select("*").eq("company_id", R.company.id).eq("typ", "ausgang")
    .gte("datum", fyRange(R.year, fyStartMonth(R.company))[0]).lte("datum", fyRange(R.year, fyStartMonth(R.company))[1]).order("datum", { ascending: false });
  R.err = error ? error.message : null;
  R.invoices = data || [];
}

// ---------- Liste ----------
function renderList() {
  const body = R.body;
  if (R.err) { body.innerHTML = `<div class="card"><div class="msg err">${esc(R.err)}</div></div>`; return; }
  body.innerHTML = `
    <div class="row-between" style="margin-bottom:12px">
      <div class="filters">
        <select id="fStatus"><option value="">Alle</option><option value="offen">Offen</option><option value="bezahlt">Bezahlt</option></select>
        <input id="fSuche" placeholder="Suche Nr./Kunde/Betreff …" style="width:220px">
      </div>
      <button class="btn primary" id="newInv">+ Neue Rechnung</button>
    </div>
    <div class="muted" id="invSum" style="margin-bottom:10px"></div>
    <div class="card" id="invWrap"></div>`;
  const draw = () => {
    const status = body.querySelector("#fStatus").value;
    const q = body.querySelector("#fSuche").value.trim().toLowerCase();
    let rows = R.invoices.slice();
    if (status) rows = rows.filter((i) => i.status === status);
    if (q) rows = rows.filter((i) => ((i.nummer || "") + " " + (i.kunde || "") + " " + (i.betreff || "")).toLowerCase().includes(q));
    const sumOffen = R.invoices.filter((i) => i.status === "offen").reduce((s, i) => s + (+i.brutto || 0), 0);
    const sumBez = R.invoices.filter((i) => i.status === "bezahlt").reduce((s, i) => s + (+i.brutto || 0), 0);
    body.querySelector("#invSum").innerHTML = `${R.invoices.length} Rechnung(en) ${fyLabel(R.year, fyStartMonth(R.company))} · offen <b class="neg">${fmtEUR(sumOffen)}</b> · bezahlt <b class="pos">${fmtEUR(sumBez)}</b>`;
    body.querySelector("#invWrap").innerHTML = rows.length ? `
      <table class="tbl">
        <thead><tr><th>Nr.</th><th>Datum</th><th>Kunde</th><th>Betreff</th><th class="num">Brutto</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((i) => `<tr>
          <td><b>${esc(i.nummer || "")}</b></td><td>${fmtDate(i.datum)}</td><td>${esc(i.kunde || "")}</td>
          <td>${esc(i.betreff || "")}</td><td class="num">${fmtEUR(i.brutto)}</td>
          <td><span class="pill ${i.status === "bezahlt" ? "einnahme" : "ausgabe"}">${i.status === "bezahlt" ? "bezahlt" : "offen"}</span></td>
          <td class="act">
            <button class="lnk" data-open="${i.id}">Öffnen</button>
            <button class="lnk" data-print="${i.id}">PDF</button>
            ${i.status === "offen" ? `<button class="lnk" data-paid="${i.id}">bezahlt</button>` : ""}
            <button class="lnk del" data-del="${i.id}">Löschen</button>
          </td></tr>`).join("")}</tbody>
      </table>` : `<div class="empty">${R.invoices.length ? "Keine Treffer für diesen Filter." : `Noch keine Rechnungen in ${fyLabel(R.year, fyStartMonth(R.company))}. Lege die erste mit „+ Neue Rechnung" an.`}</div>`;
    body.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => startEditor(R.invoices.find((x) => x.id === el.dataset.open))));
    body.querySelectorAll("[data-print]").forEach((el) => el.addEventListener("click", () => genInvoicePDF(R.invoices.find((x) => x.id === el.dataset.print), el)));
    body.querySelectorAll("[data-paid]").forEach((el) => el.addEventListener("click", () => markPaid(R.invoices.find((x) => x.id === el.dataset.paid))));
    body.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => delInvoice(el.dataset.del)));
  };
  body.querySelector("#newInv").addEventListener("click", () => startEditor(null));
  body.querySelector("#fStatus").addEventListener("change", draw);
  body.querySelector("#fSuche").addEventListener("input", draw);
  draw();
}

// ---------- Editor ----------
function startEditor(inv) {
  const c = R.company;
  if (inv) {
    R.editId = inv.id;
    R.draft = {
      nummer: inv.nummer || "", datum: inv.datum || todayISO(), faelligkeit: inv.faelligkeit || "",
      von: inv.leistung_von || "", bis: inv.leistung_bis || "",
      kunde: inv.kunde || "", kunde_adresse: inv.kunde_adresse || "", kunde_uid: inv.kunde_uid || "",
      betreff: inv.betreff || "", kostenstelle: inv.kostenstelle || "",
      gesamtrabatt: (inv.rabatt && inv.rabatt.gesamt) || 0,
      steuer_vermerk: inv.steuer_vermerk || defaultSteuer(c),
      positionen: (inv.positionen && inv.positionen.length ? inv.positionen : [emptyPos()]).map((p) => ({ ...p })),
    };
  } else {
    R.editId = null;
    const nb = nbOf(c); const today = todayISO();
    R.draft = {
      nummer: formatNummer(c, R.year, nb.next), datum: today, faelligkeit: addDays(today, 14),
      von: "", bis: "", kunde: "", kunde_adresse: "", kunde_uid: "", betreff: "", kostenstelle: "",
      gesamtrabatt: 0, steuer_vermerk: defaultSteuer(c), positionen: [emptyPos()],
    };
  }
  R.view = "edit";
  renderEditor();
}
const emptyPos = () => ({ menge: 1, einheit: "Stk", bezeichnung: "", einzelpreis: 0, rabatt: 0 });

function syncDraft() {
  const b = R.body;
  const g = (k) => { const el = b.querySelector(`[data-k="${k}"]`); return el ? el.value : R.draft[k]; };
  ["nummer", "datum", "faelligkeit", "von", "bis", "kunde", "kunde_adresse", "kunde_uid", "betreff", "kostenstelle", "gesamtrabatt", "steuer_vermerk"].forEach((k) => (R.draft[k] = g(k)));
  R.draft.positionen = [...b.querySelectorAll("[data-pos]")].map((row) => ({
    menge: row.querySelector('[data-pk="menge"]').value,
    einheit: row.querySelector('[data-pk="einheit"]').value,
    bezeichnung: row.querySelector('[data-pk="bezeichnung"]').value,
    einzelpreis: row.querySelector('[data-pk="einzelpreis"]').value,
    rabatt: row.querySelector('[data-pk="rabatt"]').value,
  }));
}

function renderEditor() {
  const c = R.company, d = R.draft;
  const t = calcTotals(d.positionen, d.gesamtrabatt, c.tax_mode);
  R.body.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <h3 class="card-title">${R.editId ? "Rechnung bearbeiten" : "Neue Rechnung"} · ${esc(c.name)}</h3>
      <button class="lnk" id="backList">← Zur Liste</button>
    </div>
    <div class="card">
      <div class="form-grid">
        <label>Rechnungsnummer<input data-k="nummer" value="${esc(d.nummer)}"></label>
        <label>Kostenstelle<input data-k="kostenstelle" value="${esc(d.kostenstelle)}" placeholder="optional"></label>
        <label>Rechnungsdatum<input type="date" data-k="datum" value="${esc(d.datum)}"></label>
        <label>Fällig bis<input type="date" data-k="faelligkeit" value="${esc(d.faelligkeit)}"></label>
        <label>Leistung von<input type="date" data-k="von" value="${esc(d.von)}"></label>
        <label>Leistung bis<input type="date" data-k="bis" value="${esc(d.bis)}"></label>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <h4 class="sec">Rechnungsempfänger</h4>
      <div class="form-grid">
        <label class="col2">Aus Kundendatenbank<select id="kundeSelect"><option value="">— neuer Kunde / manuell —</option>${customers().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
        <label>Name<input data-k="kunde" value="${esc(d.kunde)}"></label>
        <label>UID (falls vorhanden)<input data-k="kunde_uid" value="${esc(d.kunde_uid)}"></label>
        <label class="col2">Adresse<textarea data-k="kunde_adresse" rows="2">${esc(d.kunde_adresse)}</textarea></label>
        <label class="col2">Betreff / Leistungsbeschreibung<input data-k="betreff" value="${esc(d.betreff)}"></label>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <h4 class="sec">Positionen</h4>
      <datalist id="prodList">${products().map((p) => `<option value="${esc(p.bezeichnung)}"></option>`).join("")}</datalist>
      <div class="tbl-scroll"><table class="tbl pos-tbl">
        <thead><tr><th style="width:70px">Menge</th><th style="width:70px">Einheit</th><th>Bezeichnung</th><th style="width:110px" class="num">Einzelpreis</th><th style="width:80px" class="num">Rabatt %</th><th style="width:110px" class="num">Betrag</th><th></th></tr></thead>
        <tbody id="posRows">${d.positionen.map((p, i) => posRow(p, i)).join("")}</tbody>
      </table></div>
      <button class="btn sm" id="addPos" style="margin-top:10px">+ Position</button>
      <div class="sums">
        <div><span>Zwischensumme</span><b id="s_zw">${fmtEUR(t.zwischen)}</b></div>
        <div class="rabrow"><span>Gesamtrabatt <input type="number" step="0.01" min="0" data-k="gesamtrabatt" value="${esc(d.gesamtrabatt)}" style="width:70px"> %</span><b id="s_rab">− ${fmtEUR(t.rab)}</b></div>
        <div><span>Netto</span><b id="s_net">${fmtEUR(t.netto)}</b></div>
        ${t.ustSatz ? `<div><span>USt ${t.ustSatz}%</span><b id="s_ust">${fmtEUR(t.ust)}</b></div>` : ""}
        <div class="total"><span>Gesamtbetrag</span><b id="s_bru">${fmtEUR(t.brutto)}</b></div>
      </div>
    </div>
    <div class="card" style="margin-top:12px">
      <label>Steuerlicher Hinweis<textarea data-k="steuer_vermerk" rows="2">${esc(d.steuer_vermerk)}</textarea></label>
      ${c.iban ? `<p class="note">Zahlungsdaten (IBAN ${esc(c.iban)}) kommen automatisch aufs PDF, inkl. SEPA-QR-Code.</p>`
        : `<p class="note" style="color:var(--warn)">Kein IBAN im Unternehmen hinterlegt → auf dem PDF fehlen Zahlungsdaten & QR. Unter „Stammdaten" ergänzen.</p>`}
    </div>
    <div class="row-between" style="margin-top:16px">
      <button class="btn" id="cancelEdit">Abbrechen</button>
      <div style="display:flex;gap:10px">
        <button class="btn" id="saveInv">Speichern</button>
        <button class="btn primary" id="savePrint">Speichern & PDF</button>
      </div>
    </div>
    <div id="inv_err" class="msg err" hidden style="margin-top:10px"></div>`;

  const b = R.body;
  b.querySelector("#backList").addEventListener("click", () => { R.view = "list"; renderRechnungen(R.body, R.company, R.year, R.refresh); });
  b.querySelector("#cancelEdit").addEventListener("click", () => { R.view = "list"; renderRechnungen(R.body, R.company, R.year, R.refresh); });
  b.querySelector("#addPos").addEventListener("click", () => { syncDraft(); R.draft.positionen.push(emptyPos()); renderEditor(); });
  b.querySelectorAll("[data-posdel]").forEach((el) => el.addEventListener("click", () => { syncDraft(); R.draft.positionen.splice(+el.dataset.posdel, 1); if (!R.draft.positionen.length) R.draft.positionen.push(emptyPos()); renderEditor(); }));
  b.addEventListener("input", (e) => { if (e.target.matches("[data-pk],[data-k='gesamtrabatt']")) recalc(); });
  const kundeSel = b.querySelector("#kundeSelect");
  if (kundeSel) kundeSel.addEventListener("change", () => applyCustomer(kundeSel.value));
  b.addEventListener("change", (e) => { if (e.target.matches('[data-pk="bezeichnung"]')) applyProduct(e.target); });
  b.querySelector("#saveInv").addEventListener("click", () => saveInvoice(false));
  b.querySelector("#savePrint").addEventListener("click", () => saveInvoice(true));
}
function applyCustomer(id) {
  const c = customers().find((x) => x.id === id);
  if (!c) return;
  const set = (k, v) => { const el = R.body.querySelector(`[data-k="${k}"]`); if (el) el.value = v || ""; };
  set("kunde", c.name); set("kunde_adresse", c.adresse || ""); set("kunde_uid", c.uid || "");
}
function applyProduct(input) {
  const bez = input.value.trim().toLowerCase();
  const p = products().find((x) => (x.bezeichnung || "").trim().toLowerCase() === bez);
  if (!p) return;
  const row = input.closest("[data-pos]");
  const unit = row.querySelector('[data-pk="einheit"]'), price = row.querySelector('[data-pk="einzelpreis"]');
  if (unit && !unit.value.trim()) unit.value = p.einheit || "Stk";
  if (price && (!price.value || +price.value === 0)) price.value = p.einzelpreis || 0;
  recalc();
}
function posRow(p, i) {
  return `<tr data-pos data-i="${i}">
    <td><input class="num" data-pk="menge" type="number" step="0.01" value="${esc(p.menge)}"></td>
    <td><input data-pk="einheit" value="${esc(p.einheit || "")}"></td>
    <td><input data-pk="bezeichnung" list="prodList" value="${esc(p.bezeichnung || "")}" placeholder="Leistung / Artikel"></td>
    <td><input class="num" data-pk="einzelpreis" type="number" step="0.01" value="${esc(p.einzelpreis)}"></td>
    <td><input class="num" data-pk="rabatt" type="number" step="0.01" min="0" value="${esc(p.rabatt || 0)}"></td>
    <td class="num linesum">${fmtEUR(lineNet(p))}</td>
    <td class="act"><button class="lnk del" data-posdel="${i}">✕</button></td>
  </tr>`;
}
function recalc() {
  syncDraft();
  const t = calcTotals(R.draft.positionen, R.draft.gesamtrabatt, R.company.tax_mode);
  const b = R.body;
  [...b.querySelectorAll("[data-pos]")].forEach((row, i) => { const el = row.querySelector(".linesum"); if (el) el.textContent = fmtEUR(t.pos[i].netto); });
  const set = (id, v) => { const el = b.querySelector("#" + id); if (el) el.textContent = v; };
  set("s_zw", fmtEUR(t.zwischen)); set("s_rab", "− " + fmtEUR(t.rab)); set("s_net", fmtEUR(t.netto));
  if (t.ustSatz) set("s_ust", fmtEUR(t.ust)); set("s_bru", fmtEUR(t.brutto));
}

async function saveInvoice(thenPrint) {
  syncDraft();
  const c = R.company, d = R.draft;
  if (!d.nummer.trim()) { showErr(R.body, "Bitte eine Rechnungsnummer angeben.", "inv_err"); return; }
  if (!d.kunde.trim()) { showErr(R.body, "Bitte den Rechnungsempfänger angeben.", "inv_err"); return; }
  const t = calcTotals(d.positionen, d.gesamtrabatt, c.tax_mode);
  if (t.brutto <= 0) { showErr(R.body, "Die Rechnung hat keinen Betrag (> 0).", "inv_err"); return; }
  const rec = {
    company_id: c.id, typ: "ausgang", nummer: d.nummer.trim(),
    kunde: d.kunde.trim(), kunde_adresse: d.kunde_adresse.trim() || null, kunde_uid: d.kunde_uid.trim() || null,
    datum: d.datum || todayISO(), faelligkeit: d.faelligkeit || null, leistung_von: d.von || null, leistung_bis: d.bis || null,
    betreff: d.betreff.trim() || null, kostenstelle: d.kostenstelle.trim() || null,
    positionen: t.pos, netto: t.netto, ust: t.ust, brutto: t.brutto,
    rabatt: { gesamt: +d.gesamtrabatt || 0 }, steuer_vermerk: d.steuer_vermerk.trim() || null,
  };
  const btnIds = ["#saveInv", "#savePrint"].map((s) => R.body.querySelector(s));
  btnIds.forEach((x) => x && (x.disabled = true));
  let saved, error;
  if (R.editId) ({ data: saved, error } = await sb.from("invoices").update(rec).eq("id", R.editId).select().single());
  else { rec.status = "offen"; rec.created_by = R.userId; ({ data: saved, error } = await sb.from("invoices").insert(rec).select().single()); }
  if (error) { showErr(R.body, error.message, "inv_err"); btnIds.forEach((x) => x && (x.disabled = false)); return; }
  if (!R.editId) await bumpNumbering(c, d.nummer);
  // Kunde & Produkte automatisch in den Katalog übernehmen
  try { await upsertCustomerFromInvoice(c.id, d); await upsertProductsFromPositions(c.id, t.pos); await loadKatalog(c.id, true); } catch (e) { /* nicht blockierend */ }
  R.view = "list"; R.editId = null;
  await loadInvoices();
  renderList();
  if (thenPrint && saved) genInvoicePDF(saved);
}
async function bumpNumbering(c, nummer) {
  const m = String(nummer).match(/(\d+)\s*$/);
  const used = m ? parseInt(m[1], 10) : null;
  const nb = nbOf(c);
  const next = used != null ? used + 1 : nb.next + 1;
  const numbering = { ...nb, next };
  const { error } = await sb.from("companies").update({ numbering }).eq("id", c.id);
  if (!error) c.numbering = numbering;
}

async function delInvoice(id) {
  const inv = R.invoices.find((x) => x.id === id);
  if (!confirm(`Rechnung ${inv ? inv.nummer : ""} wirklich löschen?`)) return;
  const { error } = await sb.from("invoices").delete().eq("id", id);
  if (error) { alert("Löschen fehlgeschlagen: " + error.message); return; }
  await loadInvoices(); renderList();
}

// ---------- Als bezahlt markieren -> Einnahme buchen ----------
function markPaid(inv) {
  const el = modal("Rechnung als bezahlt markieren", `
    <p class="note" style="margin:0 0 12px">${esc(inv.nummer)} · ${fmtEUR(inv.brutto)} — wird als Einnahme in der EAR verbucht.</p>
    <label>Bezahlt am<input id="paidDate" type="date" value="${todayISO()}"></label>
    <div id="m_err" class="msg err" hidden style="margin-top:10px"></div>`,
    [{ label: "Abbrechen", cls: "btn", close: true }, { label: "Bezahlt & buchen", cls: "btn primary", id: "paidOk" }]);
  el.querySelector("#paidOk").addEventListener("click", async () => {
    const date = el.querySelector("#paidDate").value || todayISO();
    const btn = el.querySelector("#paidOk"); btn.disabled = true; btn.textContent = "Speichert …";
    const up = await sb.from("invoices").update({ status: "bezahlt", bezahlt_am: date }).eq("id", inv.id);
    if (up.error) { showErr(el, up.error.message); btn.disabled = false; btn.textContent = "Bezahlt & buchen"; return; }
    // Einnahme nur buchen, wenn noch keine für diese Rechnung existiert
    const ex = await sb.from("bookings").select("id").eq("invoice_id", inv.id).limit(1);
    if (!ex.error && (!ex.data || !ex.data.length)) {
      await sb.from("bookings").insert({
        company_id: inv.company_id, datum: date, typ: "einnahme", betrag: inv.brutto,
        text: `Rechnung ${inv.nummer}${inv.betreff ? " – " + inv.betreff : ""}`, gegenkonto: inv.kunde,
        kostenstelle: inv.kostenstelle || null, quelle: "rechnung", invoice_id: inv.id, created_by: R.userId,
      });
    }
    el.remove();
    await loadInvoices(); renderList();
    if (R.refresh) R.refresh(); // EAR/Buchungen aktualisieren
  });
}

// ---------- PDF erzeugen & herunterladen ----------
async function genInvoicePDF(inv, btn) {
  if (!inv) return;
  const txt = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "PDF …"; }
  try {
    const c = R.company;
    const JsPDF = await jsPDFLib();
    let qrUrl = null;
    if (c.iban && +inv.brutto > 0) {
      try {
        const Q = await Promise.race([qrLib(), new Promise((_, r) => setTimeout(() => r(new Error("qr")), 2500))]);
        qrUrl = await Q.toDataURL(epcPayload(c, inv.brutto, "Rechnung " + (inv.nummer || "")), { margin: 0, width: 240, errorCorrectionLevel: "M" });
      } catch (e) { qrUrl = null; }
    }
    const doc = buildInvoicePdfDoc(JsPDF, c, inv, qrUrl);
    doc.save(`Rechnung-${String(inv.nummer || "Rechnung").replace(/[^\w\-]+/g, "_")}.pdf`);
  } catch (e) {
    alert("PDF konnte nicht erzeugt werden: " + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = txt; }
  }
}

function buildInvoicePdfDoc(JsPDF, c, inv, qrDataUrl) {
  const doc = new JsPDF({ unit: "mm", format: "a4" });
  const [ar, ag, ab] = hexRgb(c.design && c.design.accent);
  const L = 16, R = 194, W = R - L, PH = 297;
  let y = 18;

  // Absender
  doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(ar, ag, ab);
  doc.text(String(c.name || ""), L, y);
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(105);
  let yi = y + 5.5;
  [String(c.strasse || ""), [c.plz, c.ort].filter(Boolean).join(" "), [c.email, c.tel].filter(Boolean).join("   ·   "), [c.uid ? "UID: " + c.uid : null, c.reg || null].filter(Boolean).join("   ·   ")]
    .filter((l) => l && l.trim()).forEach((l) => { doc.text(l, L, yi); yi += 4; });

  // Titel + Metadaten rechts
  doc.setFont("helvetica", "bold").setFontSize(21).setTextColor(ar, ag, ab);
  doc.text("RECHNUNG", R, y, { align: "right" });
  doc.setFontSize(9.5).setTextColor(55);
  let yr = y + 7;
  doc.text("Nr. " + String(inv.nummer || ""), R, yr, { align: "right" }); yr += 4.6;
  doc.setFont("helvetica", "normal");
  doc.text("Datum: " + fmtDate(inv.datum), R, yr, { align: "right" }); yr += 4.6;
  if (inv.faelligkeit) { doc.text("Fällig: " + fmtDate(inv.faelligkeit), R, yr, { align: "right" }); yr += 4.6; }

  y = Math.max(yi, yr) + 1;
  doc.setDrawColor(ar, ag, ab).setLineWidth(0.6).line(L, y, R, y);
  y += 8;

  // Empfänger
  doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(150);
  doc.text("RECHNUNG AN", L, y); y += 4.6;
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(30);
  doc.text(String(inv.kunde || ""), L, y);
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(65);
  if (inv.kunde_adresse) doc.splitTextToSize(String(inv.kunde_adresse), 95).forEach((l) => { y += 4.4; doc.text(l, L, y); });
  if (inv.kunde_uid) { y += 4.4; doc.setFontSize(8.5).setTextColor(105); doc.text("UID: " + inv.kunde_uid, L, y); }

  // Betreff + Leistungszeitraum
  if (inv.betreff) { y += 8.5; doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(30); doc.splitTextToSize(String(inv.betreff), W).forEach((l) => { doc.text(l, L, y); y += 5; }); }
  if (inv.leistung_von || inv.leistung_bis) {
    y += inv.betreff ? 0 : 8.5;
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(105);
    doc.text("Leistungszeitraum: " + (inv.leistung_von ? fmtDate(inv.leistung_von) : "") + (inv.leistung_bis ? " – " + fmtDate(inv.leistung_bis) : ""), L, y); y += 2;
  }

  // Positionstabelle
  y += 7;
  const cBez = L + 10, cMenge = L + 120, cEinh = L + 123, cPreis = L + 156, cBetrag = R - 1;
  doc.setFillColor(ar, ag, ab).rect(L, y - 4.2, W, 6.2, "F");
  doc.setFont("helvetica", "bold").setFontSize(7.6).setTextColor(255);
  doc.text("POS", L + 1.5, y); doc.text("BEZEICHNUNG", cBez, y);
  doc.text("MENGE", cMenge, y, { align: "right" }); doc.text("EINH.", cEinh, y);
  doc.text("EINZELPR.", cPreis, y, { align: "right" }); doc.text("BETRAG EUR", cBetrag, y, { align: "right" });
  y += 3;
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(40);
  (inv.positionen || []).forEach((p, i) => {
    const bez = doc.splitTextToSize(String(p.bezeichnung || ""), 100);
    y += 4.5;
    doc.text(String(i + 1), L + 1.5, y);
    bez.forEach((l, li) => doc.text(l, cBez, y + li * 4.3));
    doc.text(String(p.menge == null ? "" : p.menge), cMenge, y, { align: "right" });
    doc.text(String(p.einheit || ""), cEinh, y);
    doc.text(fmtDe(p.einzelpreis), cPreis, y, { align: "right" });
    doc.text(fmtDe(p.netto), cBetrag, y, { align: "right" });
    y += Math.max((bez.length - 1) * 4.3, 0) + 2.5;
    doc.setDrawColor(226).setLineWidth(0.2).line(L, y, R, y);
  });

  // Summen (rechts)
  const pos = inv.positionen || [];
  const zwischen = pos.reduce((s, p) => s + (+p.netto || 0), 0);
  const rab = inv.rabatt && inv.rabatt.gesamt ? +inv.rabatt.gesamt : 0;
  const rabBetrag = Math.round(zwischen * (rab / 100) * 100) / 100;
  const ustRate = +inv.ust && +inv.netto ? Math.round((+inv.ust / +inv.netto) * 100) : 0;
  const tL = L + 96, tV = R;
  y += 8;
  const srow = (label, val) => { doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(70); doc.text(label, tL, y); doc.text(val, tV, y, { align: "right" }); y += 5.4; };
  srow("Zwischensumme", eur(zwischen));
  if (rab) srow("Gesamtrabatt " + rab + " %", "- " + eur(rabBetrag));
  srow("Nettobetrag", eur(inv.netto));
  if (+inv.ust) srow("USt " + (ustRate || 20) + " %", eur(inv.ust));
  doc.setDrawColor(ar, ag, ab).setLineWidth(0.5).line(tL, y - 1.5, tV, y - 1.5);
  y += 2;
  doc.setFont("helvetica", "bold").setFontSize(12.5).setTextColor(ar, ag, ab);
  doc.text("Gesamtbetrag", tL, y); doc.text(eur(inv.brutto), tV, y, { align: "right" });
  y += 8;

  // Steuerhinweis
  if (inv.steuer_vermerk) {
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(70);
    doc.splitTextToSize(String(inv.steuer_vermerk), W).forEach((l) => { y += 4.4; doc.text(l, L, y); });
    y += 2;
  }

  // Zahlung + QR (unten)
  let py = Math.max(y + 10, PH - 55);
  doc.setDrawColor(226).setLineWidth(0.3).line(L, py, R, py); py += 6;
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(40);
  doc.text("Zahlbar" + (inv.faelligkeit ? " bis " + fmtDate(inv.faelligkeit) : " nach Erhalt"), L, py);
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(70);
  let qy = py + 5;
  if (c.iban) {
    if (c.bank) { doc.text(String(c.bank), L, qy); qy += 4.4; }
    doc.text("IBAN: " + c.iban, L, qy); qy += 4.4;
    if (c.bic) { doc.text("BIC: " + c.bic, L, qy); qy += 4.4; }
    doc.setFontSize(8.5).setTextColor(120); doc.text("Bitte Rechnungsnummer als Verwendungszweck angeben.", L, qy);
  } else { doc.text("Zahlungsdaten auf Anfrage.", L, qy); }
  if (qrDataUrl) {
    try {
      doc.addImage(qrDataUrl, "PNG", R - 26, py - 1, 26, 26);
      doc.setFontSize(7).setTextColor(120); doc.text("Scan & Pay", R - 13, py + 28, { align: "center" });
    } catch (e) { /* QR optional */ }
  }

  // Fußzeile
  doc.setFontSize(7.5).setTextColor(150);
  const foot = [c.name, [c.strasse, [c.plz, c.ort].filter(Boolean).join(" ")].filter(Boolean).join(", "), c.iban].filter(Boolean).join("   ·   ");
  doc.text(foot, 105, PH - 10, { align: "center", maxWidth: W });
  return doc;
}
// zum Testen im Browser:
export { buildInvoicePdfDoc, jsPDFLib, epcPayload };
