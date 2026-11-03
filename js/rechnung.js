// Rechnungsmodul: Ausgangsrechnungen erstellen, speichern, drucken (PDF),
// mit Unternehmens-Design, Positionen/Rabatten, Nummernkreis, SEPA-QR.
// Bezahlte Rechnungen werden als Einnahme in die EAR gebucht.
import { sb, esc, fmtEUR, fmtDate, todayISO, uuid } from "./db.js";
import { modal, showErr } from "./ui.js";
import { loadKatalog, customers, products, upsertCustomerFromInvoice, upsertProductsFromPositions } from "./katalog.js";

const R = { company: null, year: null, refresh: null, view: "list", invoices: [], draft: null, userId: null, err: null };

// ---------- QR (lazy) ----------
let _qr = null;
async function qrSvg(payload) {
  if (!_qr) { const m = await import("https://esm.sh/qrcode@1.5.3"); _qr = m.default || m; }
  return _qr.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 0 });
}

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
    .gte("datum", R.year + "-01-01").lte("datum", R.year + "-12-31").order("datum", { ascending: false });
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
    body.querySelector("#invSum").innerHTML = `${R.invoices.length} Rechnung(en) ${R.year} · offen <b class="neg">${fmtEUR(sumOffen)}</b> · bezahlt <b class="pos">${fmtEUR(sumBez)}</b>`;
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
      </table>` : `<div class="empty">${R.invoices.length ? "Keine Treffer für diesen Filter." : `Noch keine Rechnungen in ${R.year}. Lege die erste mit „+ Neue Rechnung" an.`}</div>`;
    body.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => startEditor(R.invoices.find((x) => x.id === el.dataset.open))));
    body.querySelectorAll("[data-print]").forEach((el) => el.addEventListener("click", () => printInvoice(R.invoices.find((x) => x.id === el.dataset.print))));
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
  if (thenPrint && saved) printInvoice(saved);
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

// ---------- Druck / PDF ----------
async function printInvoice(inv) {
  const c = R.company;
  let qr = "";
  if (c.iban && +inv.brutto > 0) { try { qr = await qrSvg(epcPayload(c, inv.brutto, "Rechnung " + inv.nummer)); } catch (e) { qr = ""; } }
  const holder = document.createElement("div");
  holder.id = "print-doc";
  holder.innerHTML = buildPrintDoc(c, inv, qr);
  document.body.appendChild(holder);
  const cleanup = () => { holder.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  setTimeout(() => window.print(), 60);
}
function buildPrintDoc(c, inv, qrSvgStr) {
  const accent = (c.design && c.design.accent) || "#184437";
  const logo = c.design && c.design.logo;
  const addr = [c.strasse, [c.plz, c.ort].filter(Boolean).join(" "), c.land].filter(Boolean);
  const contact = [c.email, c.tel].filter(Boolean).join(" · ");
  const legal = [c.uid ? "UID: " + c.uid : "", c.reg ? c.reg : ""].filter(Boolean).join(" · ");
  const pos = inv.positionen || [];
  const rab = inv.rabatt && inv.rabatt.gesamt ? +inv.rabatt.gesamt : 0;
  const zwischen = pos.reduce((s, p) => s + (+p.netto || 0), 0);
  const rabBetrag = Math.round(zwischen * (rab / 100) * 100) / 100;
  const period = (inv.leistung_von || inv.leistung_bis) ? `Leistungszeitraum: ${inv.leistung_von ? fmtDate(inv.leistung_von) : ""}${inv.leistung_bis ? " – " + fmtDate(inv.leistung_bis) : ""}` : "";
  return `
  <style>
    @page { size: A4; margin: 16mm; }
    #print-doc{ font-family: Helvetica, Arial, sans-serif; color:#1a211c; font-size:11pt; line-height:1.45; }
    #print-doc *{ box-sizing:border-box; }
    #print-doc .pd-top{ display:flex; justify-content:space-between; align-items:flex-start; gap:20px; border-bottom:3px solid ${accent}; padding-bottom:12px; }
    #print-doc .pd-iss{ max-width:60%; }
    #print-doc .pd-logo{ max-height:60px; max-width:230px; margin-bottom:6px; }
    #print-doc .pd-name{ font-size:15pt; font-weight:700; color:${accent}; }
    #print-doc .pd-sub{ font-size:9pt; color:#555; }
    #print-doc .pd-title{ text-align:right; }
    #print-doc .pd-title h1{ font-size:20pt; margin:0 0 4px; color:${accent}; letter-spacing:.02em; }
    #print-doc .pd-meta{ font-size:9.5pt; color:#333; }
    #print-doc .pd-to{ margin:26px 0 6px; }
    #print-doc .pd-to .lbl{ font-size:8pt; text-transform:uppercase; letter-spacing:.08em; color:#888; }
    #print-doc .pd-betreff{ font-weight:700; margin:16px 0 4px; }
    #print-doc table.pd-pos{ width:100%; border-collapse:collapse; margin-top:10px; font-size:10pt; }
    #print-doc table.pd-pos th{ text-align:left; background:${accent}; color:#fff; padding:6px 8px; font-size:8.5pt; text-transform:uppercase; letter-spacing:.03em; }
    #print-doc table.pd-pos td{ padding:6px 8px; border-bottom:1px solid #e3e0d6; vertical-align:top; }
    #print-doc .num{ text-align:right; white-space:nowrap; }
    #print-doc .pd-sums{ width:300px; margin-left:auto; margin-top:12px; font-size:10.5pt; }
    #print-doc .pd-sums div{ display:flex; justify-content:space-between; padding:3px 0; }
    #print-doc .pd-sums .tot{ border-top:2px solid ${accent}; margin-top:4px; padding-top:6px; font-weight:700; font-size:12pt; color:${accent}; }
    #print-doc .pd-note{ margin-top:18px; font-size:9.5pt; color:#444; }
    #print-doc .pd-pay{ margin-top:18px; display:flex; justify-content:space-between; gap:20px; border-top:1px solid #e3e0d6; padding-top:12px; align-items:flex-start; }
    #print-doc .pd-pay .k{ font-size:9.5pt; }
    #print-doc .pd-qr{ width:110px; height:110px; flex:none; }
    #print-doc .pd-qr svg{ width:110px; height:110px; }
    #print-doc .pd-foot{ margin-top:22px; border-top:1px solid #e3e0d6; padding-top:8px; font-size:8pt; color:#888; text-align:center; }
  </style>
  <div class="pd-top">
    <div class="pd-iss">
      ${logo ? `<img class="pd-logo" src="${esc(logo)}" alt="">` : `<div class="pd-name">${esc(c.name)}</div>`}
      <div class="pd-sub">${logo ? esc(c.name) + "<br>" : ""}${addr.map(esc).join(" · ")}${contact ? "<br>" + esc(contact) : ""}${legal ? "<br>" + esc(legal) : ""}</div>
    </div>
    <div class="pd-title">
      <h1>RECHNUNG</h1>
      <div class="pd-meta"><b>Nr. ${esc(inv.nummer)}</b><br>Datum: ${fmtDate(inv.datum)}${inv.faelligkeit ? "<br>Fällig: " + fmtDate(inv.faelligkeit) : ""}</div>
    </div>
  </div>
  <div class="pd-to">
    <div class="lbl">Rechnung an</div>
    <div><b>${esc(inv.kunde || "")}</b></div>
    <div style="white-space:pre-line">${esc(inv.kunde_adresse || "")}</div>
    ${inv.kunde_uid ? `<div class="pd-sub">UID: ${esc(inv.kunde_uid)}</div>` : ""}
  </div>
  ${inv.betreff ? `<div class="pd-betreff">${esc(inv.betreff)}</div>` : ""}
  ${period ? `<div class="pd-sub">${esc(period)}</div>` : ""}
  <table class="pd-pos">
    <thead><tr><th style="width:36px">Pos</th><th>Bezeichnung</th><th class="num">Menge</th><th>Einh.</th><th class="num">Einzelpr.</th><th class="num">Rabatt</th><th class="num">Betrag</th></tr></thead>
    <tbody>${pos.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.bezeichnung || "")}</td><td class="num">${esc(String(p.menge))}</td><td>${esc(p.einheit || "")}</td>
      <td class="num">${fmtEUR(p.einzelpreis)}</td><td class="num">${(+p.rabatt ? p.rabatt + " %" : "–")}</td><td class="num">${fmtEUR(p.netto)}</td></tr>`).join("")}</tbody>
  </table>
  <div class="pd-sums">
    <div><span>Zwischensumme</span><span>${fmtEUR(zwischen)}</span></div>
    ${rab ? `<div><span>Gesamtrabatt ${rab} %</span><span>− ${fmtEUR(rabBetrag)}</span></div>` : ""}
    <div><span>Nettobetrag</span><span>${fmtEUR(inv.netto)}</span></div>
    ${+inv.ust ? `<div><span>USt</span><span>${fmtEUR(inv.ust)}</span></div>` : ""}
    <div class="tot"><span>Gesamtbetrag</span><span>${fmtEUR(inv.brutto)}</span></div>
  </div>
  ${inv.steuer_vermerk ? `<div class="pd-note">${esc(inv.steuer_vermerk)}</div>` : ""}
  <div class="pd-pay">
    <div class="k">
      <b>Zahlbar${inv.faelligkeit ? " bis " + fmtDate(inv.faelligkeit) : " nach Erhalt"}</b><br>
      ${c.iban ? `${esc(c.bank || "")}${c.bank ? "<br>" : ""}IBAN: ${esc(c.iban)}${c.bic ? "<br>BIC: " + esc(c.bic) : ""}` : "Zahlungsdaten auf Anfrage."}
      ${c.iban ? `<br><span class="pd-sub">Bitte Rechnungsnummer als Verwendungszweck angeben.</span>` : ""}
    </div>
    ${qrSvgStr ? `<div class="pd-qr">${qrSvgStr}<div class="pd-sub" style="text-align:center">Scan &amp; Pay</div></div>` : ""}
  </div>
  <div class="pd-foot">${esc(c.name)}${addr.length ? " · " + esc(addr.join(", ")) : ""}${c.iban ? " · " + esc(c.iban) : ""}</div>`;
}
