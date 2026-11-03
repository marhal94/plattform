// Kunden- & Produktkatalog je Unternehmen: gemeinsamer Cache (für die Picker
// im Rechnungseditor) + Verwaltungs-Oberflächen + Auto-Speichern aus Rechnungen.
import { sb, esc, fmtEUR } from "./db.js";
import { modal, showErr } from "./ui.js";

const K = { companyId: null, customers: [], products: [], userId: null };

export function customers() { return K.customers; }
export function products() { return K.products; }

async function ensureUser() { if (!K.userId) { const u = await sb.auth.getUser(); K.userId = u.data && u.data.user ? u.data.user.id : null; } }

export async function loadKatalog(companyId, force) {
  await ensureUser();
  if (K.companyId === companyId && !force) return;
  K.companyId = companyId;
  const [cu, pr] = await Promise.all([
    sb.from("customers").select("*").eq("company_id", companyId).order("name"),
    sb.from("products").select("*").eq("company_id", companyId).order("bezeichnung"),
  ]);
  K.customers = cu.error ? [] : (cu.data || []);
  K.products = pr.error ? [] : (pr.data || []);
}

// ---------- Auto-Speichern aus einer gespeicherten Rechnung ----------
export async function upsertCustomerFromInvoice(companyId, draft) {
  const name = (draft.kunde || "").trim();
  if (!name) return;
  const exists = K.customers.some((c) => (c.name || "").trim().toLowerCase() === name.toLowerCase());
  if (exists) return;
  await sb.from("customers").insert({
    company_id: companyId, name, adresse: (draft.kunde_adresse || "").trim() || null,
    uid: (draft.kunde_uid || "").trim() || null, created_by: K.userId,
  });
}
export async function upsertProductsFromPositions(companyId, positionen) {
  const have = new Set(K.products.map((p) => (p.bezeichnung || "").trim().toLowerCase()));
  const neu = [];
  for (const p of positionen) {
    const bez = (p.bezeichnung || "").trim();
    if (!bez) continue;
    const key = bez.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    neu.push({ company_id: companyId, bezeichnung: bez, einheit: p.einheit || "Stk", einzelpreis: +p.einzelpreis || 0, created_by: K.userId });
  }
  if (neu.length) await sb.from("products").insert(neu);
}

// ---------- Kundenverwaltung ----------
export async function renderKunden(body, company, onChange) {
  await loadKatalog(company.id);
  const draw = () => {
    const list = K.customers;
    body.innerHTML = `
      <div class="row-between" style="margin-bottom:12px">
        <div class="muted">${list.length} Kund(e)n · ${esc(company.name)}</div>
        <button class="btn primary" id="newCust">+ Neuer Kunde</button>
      </div>
      <div class="card">${list.length ? `
        <table class="tbl"><thead><tr><th>Name</th><th>Adresse</th><th>UID</th><th>E-Mail</th><th>Tel.</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr>
          <td><b>${esc(c.name)}</b></td><td>${esc((c.adresse || "").replace(/\n/g, ", "))}</td>
          <td>${esc(c.uid || "")}</td><td>${esc(c.email || "")}</td><td>${esc(c.tel || "")}</td>
          <td class="act"><button class="lnk" data-edit="${c.id}">Bearbeiten</button><button class="lnk del" data-del="${c.id}">Löschen</button></td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">Noch keine Kunden. Sie werden auch automatisch gespeichert, sobald du sie auf einer Rechnung verwendest.</div>`}
      </div>`;
    body.querySelector("#newCust").addEventListener("click", () => editCustomer(company, null, draw, onChange));
    body.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => editCustomer(company, K.customers.find((x) => x.id === el.dataset.edit), draw, onChange)));
    body.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async () => {
      if (!confirm("Kunde löschen?")) return;
      await sb.from("customers").delete().eq("id", el.dataset.del);
      await loadKatalog(company.id, true); draw(); if (onChange) onChange();
    }));
  };
  draw();
}
function editCustomer(company, c, draw, onChange) {
  const o = c || { name: "", adresse: "", uid: "", email: "", tel: "", notiz: "" };
  const el = modal(c ? "Kunde bearbeiten" : "Neuer Kunde", `
    <div class="form-grid">
      <label class="col2">Name<input id="c_name" value="${esc(o.name)}"></label>
      <label class="col2">Adresse<textarea id="c_adr" rows="2" placeholder="Straße\n PLZ Ort">${esc(o.adresse || "")}</textarea></label>
      <label>UID<input id="c_uid" value="${esc(o.uid || "")}"></label>
      <label>E-Mail<input id="c_mail" value="${esc(o.email || "")}"></label>
      <label>Telefon<input id="c_tel" value="${esc(o.tel || "")}"></label>
      <label>Notiz<input id="c_notiz" value="${esc(o.notiz || "")}"></label>
    </div><div id="m_err" class="msg err" hidden></div>`,
    [{ label: "Abbrechen", cls: "btn", close: true }, { label: c ? "Speichern" : "Anlegen", cls: "btn primary", id: "c_save" }]);
  el.querySelector("#c_save").addEventListener("click", async () => {
    const rec = {
      company_id: company.id, name: el.querySelector("#c_name").value.trim(),
      adresse: el.querySelector("#c_adr").value.trim() || null, uid: el.querySelector("#c_uid").value.trim() || null,
      email: el.querySelector("#c_mail").value.trim() || null, tel: el.querySelector("#c_tel").value.trim() || null,
      notiz: el.querySelector("#c_notiz").value.trim() || null,
    };
    if (!rec.name) { showErr(el, "Name fehlt."); return; }
    const btn = el.querySelector("#c_save"); btn.disabled = true;
    let error;
    if (c) ({ error } = await sb.from("customers").update(rec).eq("id", c.id));
    else { rec.created_by = K.userId; ({ error } = await sb.from("customers").insert(rec)); }
    if (error) { showErr(el, error.message); btn.disabled = false; return; }
    el.remove(); await loadKatalog(company.id, true); draw(); if (onChange) onChange();
  });
}

// ---------- Produktverwaltung ----------
export async function renderProdukte(body, company, onChange) {
  await loadKatalog(company.id);
  const draw = () => {
    const list = K.products;
    body.innerHTML = `
      <div class="row-between" style="margin-bottom:12px">
        <div class="muted">${list.length} Produkt(e)/Leistung(en) · ${esc(company.name)}</div>
        <button class="btn primary" id="newProd">+ Neues Produkt</button>
      </div>
      <div class="card">${list.length ? `
        <table class="tbl"><thead><tr><th>Bezeichnung</th><th>Einheit</th><th class="num">Einzelpreis</th><th>Kategorie</th><th></th></tr></thead>
        <tbody>${list.map((p) => `<tr>
          <td><b>${esc(p.bezeichnung)}</b></td><td>${esc(p.einheit || "")}</td><td class="num">${fmtEUR(p.einzelpreis)}</td><td>${esc(p.kategorie || "")}</td>
          <td class="act"><button class="lnk" data-edit="${p.id}">Bearbeiten</button><button class="lnk del" data-del="${p.id}">Löschen</button></td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">Noch keine Produkte. Sie werden auch automatisch angelegt, sobald du sie auf einer Rechnung verwendest.</div>`}
      </div>`;
    body.querySelector("#newProd").addEventListener("click", () => editProduct(company, null, draw, onChange));
    body.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => editProduct(company, K.products.find((x) => x.id === el.dataset.edit), draw, onChange)));
    body.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", async () => {
      if (!confirm("Produkt löschen?")) return;
      await sb.from("products").delete().eq("id", el.dataset.del);
      await loadKatalog(company.id, true); draw(); if (onChange) onChange();
    }));
  };
  draw();
}
function editProduct(company, p, draw, onChange) {
  const o = p || { bezeichnung: "", einheit: "Stk", einzelpreis: "", kategorie: "" };
  const el = modal(p ? "Produkt bearbeiten" : "Neues Produkt", `
    <div class="form-grid">
      <label class="col2">Bezeichnung<input id="p_bez" value="${esc(o.bezeichnung)}"></label>
      <label>Einheit<input id="p_einh" value="${esc(o.einheit || "Stk")}"></label>
      <label>Einzelpreis (€)<input id="p_preis" type="number" step="0.01" value="${esc(o.einzelpreis)}"></label>
      <label class="col2">Kategorie<input id="p_kat" value="${esc(o.kategorie || "")}"></label>
    </div><div id="m_err" class="msg err" hidden></div>`,
    [{ label: "Abbrechen", cls: "btn", close: true }, { label: p ? "Speichern" : "Anlegen", cls: "btn primary", id: "p_save" }]);
  el.querySelector("#p_save").addEventListener("click", async () => {
    const rec = {
      company_id: company.id, bezeichnung: el.querySelector("#p_bez").value.trim(),
      einheit: el.querySelector("#p_einh").value.trim() || "Stk",
      einzelpreis: parseFloat(el.querySelector("#p_preis").value) || 0,
      kategorie: el.querySelector("#p_kat").value.trim() || null,
    };
    if (!rec.bezeichnung) { showErr(el, "Bezeichnung fehlt."); return; }
    const btn = el.querySelector("#p_save"); btn.disabled = true;
    let error;
    if (p) ({ error } = await sb.from("products").update(rec).eq("id", p.id));
    else { rec.created_by = K.userId; ({ error } = await sb.from("products").insert(rec)); }
    if (error) { showErr(el, error.message); btn.disabled = false; return; }
    el.remove(); await loadKatalog(company.id, true); draw(); if (onChange) onChange();
  });
}
