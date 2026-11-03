// Stammdaten eines Unternehmens: Absenderdaten, IBAN/BIC, Logo, Nummernkreis,
// Design (Akzentfarbe), steuerlicher Standard-Hinweis. Nur Admin kann speichern (RLS).
import { sb, esc } from "./db.js";

export function renderStammdaten(body, c, onSaved) {
  const dz = c.design || {}, nb = c.numbering || {};
  body.innerHTML = `
    <div class="card" style="max-width:760px">
      <h3 class="card-title" style="margin-bottom:12px">Stammdaten · ${esc(c.name)}</h3>
      <h4 class="sec">Absender</h4>
      <div class="form-grid">
        <label class="col2">Name<input data-s="name" value="${esc(c.name || "")}"></label>
        <label>Rechtsform<input data-s="form" value="${esc(c.form || "")}"></label>
        <label>Steuerstatus<select data-s="tax_mode">
          <option value="verein" ${c.tax_mode === "verein" ? "selected" : ""}>Verein (ohne USt)</option>
          <option value="klein" ${c.tax_mode === "klein" ? "selected" : ""}>Kleinunternehmer (ohne USt)</option>
          <option value="regel" ${c.tax_mode === "regel" ? "selected" : ""}>Regelbesteuerung (20% USt)</option>
        </select></label>
        <label class="col2">Straße<input data-s="strasse" value="${esc(c.strasse || "")}"></label>
        <label>PLZ<input data-s="plz" value="${esc(c.plz || "")}"></label>
        <label>Ort<input data-s="ort" value="${esc(c.ort || "")}"></label>
        <label>Land<input data-s="land" value="${esc(c.land || "Österreich")}"></label>
        <label>UID (falls vorhanden)<input data-s="uid" value="${esc(c.uid || "")}"></label>
        <label>E-Mail<input data-s="email" value="${esc(c.email || "")}"></label>
        <label>Telefon<input data-s="tel" value="${esc(c.tel || "")}"></label>
        <label class="col2">Register / ZVR / FN (optional)<input data-s="reg" value="${esc(c.reg || "")}"></label>
      </div>

      <h4 class="sec">Bankverbindung (für Zahlung & SEPA-QR)</h4>
      <div class="form-grid">
        <label>Bank<input data-s="bank" value="${esc(c.bank || "")}"></label>
        <label>Umsatzziel ${new Date().getFullYear()} (€)<input data-s="umsatzziel" type="number" step="0.01" value="${esc(c.umsatzziel || "")}"></label>
        <label>IBAN<input data-s="iban" value="${esc(c.iban || "")}" placeholder="AT.."></label>
        <label>BIC<input data-s="bic" value="${esc(c.bic || "")}"></label>
      </div>

      <h4 class="sec">Rechnungsnummer</h4>
      <div class="form-grid">
        <label>Präfix<input data-n="prefix" value="${esc(nb.prefix || "RE")}"></label>
        <label>Nächste Nummer<input data-n="next" type="number" min="1" value="${esc(nb.next || 1)}"></label>
        <label>Stellen (führende Nullen)<input data-n="pad" type="number" min="1" max="8" value="${esc(nb.pad || 4)}"></label>
        <label>Trennzeichen<input data-n="sep" value="${esc(nb.sep || "-")}" maxlength="2"></label>
        <label class="col2"><input type="checkbox" data-n="useYear" ${nb.useYear !== false ? "checked" : ""} style="width:auto;margin-right:6px">Jahr in der Nummer verwenden</label>
      </div>

      <h4 class="sec">Design & Hinweis</h4>
      <div class="form-grid">
        <label>Akzentfarbe<input data-d="accent" type="color" value="${esc(dz.accent || "#184437")}" style="height:40px;padding:3px"></label>
        <label>Logo${dz.logo ? ' <span class="tag">gesetzt</span>' : ""}<input id="logoFile" type="file" accept="image/*"></label>
        <label class="col2">Steuerlicher Standard-Hinweis<textarea data-d="steuer" rows="2" placeholder="z. B. Kleinunternehmerregelung …">${esc(dz.steuer || "")}</textarea></label>
      </div>
      ${dz.logo ? `<div style="margin-top:8px"><img src="${esc(dz.logo)}" style="max-height:54px;max-width:220px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff"> <button class="lnk del" id="logoDel">Logo entfernen</button></div>` : ""}

      <div class="row-between" style="margin-top:18px">
        <span class="note" id="sd_hint">Änderungen wirken sofort auf neue Rechnungen.</span>
        <button class="btn primary" id="sdSave">Stammdaten speichern</button>
      </div>
      <div id="sd_err" class="msg err" hidden style="margin-top:10px"></div>
      <div id="sd_ok" class="msg ok" hidden style="margin-top:10px">Gespeichert.</div>
    </div>`;

  const newDesign = { ...dz };
  // Logo-Upload
  const logoInput = body.querySelector("#logoFile");
  logoInput.addEventListener("change", () => {
    const f = logoInput.files[0]; if (!f) return;
    if (f.size > 500 * 1024) { setMsg(body, "sd_err", "Logo ist größer als 500 KB — bitte ein kleineres Bild wählen."); logoInput.value = ""; return; }
    const r = new FileReader();
    r.onload = () => { newDesign.logo = r.result; setMsg(body, "sd_hint", "Logo geladen — zum Übernehmen auf Speichern klicken."); };
    r.readAsDataURL(f);
  });
  if (body.querySelector("#logoDel")) body.querySelector("#logoDel").addEventListener("click", () => { newDesign.logo = null; setMsg(body, "sd_hint", "Logo wird beim Speichern entfernt."); });

  body.querySelector("#sdSave").addEventListener("click", async () => {
    const g = (sel, k) => body.querySelector(`[${sel}="${k}"]`);
    const txt = (k) => { const e = g("data-s", k); return e ? e.value.trim() : null; };
    const design = { ...newDesign, accent: g("data-d", "accent").value, steuer: g("data-d", "steuer").value.trim() || undefined };
    if (!design.steuer) delete design.steuer;
    if (!design.logo) delete design.logo;
    const numbering = {
      prefix: g("data-n", "prefix").value.trim() || "RE",
      next: Math.max(1, parseInt(g("data-n", "next").value, 10) || 1),
      pad: Math.min(8, Math.max(1, parseInt(g("data-n", "pad").value, 10) || 4)),
      sep: g("data-n", "sep").value || "-",
      useYear: g("data-n", "useYear").checked,
    };
    const rec = {
      name: txt("name") || c.name, form: txt("form"), strasse: txt("strasse"), plz: txt("plz"), ort: txt("ort"),
      land: txt("land"), uid: txt("uid"), email: txt("email"), tel: txt("tel"), reg: txt("reg"),
      bank: txt("bank"), iban: (txt("iban") || "").replace(/\s/g, "") || null, bic: txt("bic"),
      tax_mode: g("data-s", "tax_mode").value,
      umsatzziel: parseFloat(g("data-s", "umsatzziel").value) || null,
      design, numbering,
    };
    const btn = body.querySelector("#sdSave"); btn.disabled = true; btn.textContent = "Speichert …";
    const { error } = await sb.from("companies").update(rec).eq("id", c.id);
    btn.disabled = false; btn.textContent = "Stammdaten speichern";
    if (error) { setMsg(body, "sd_err", error.message.includes("policy") || error.message.includes("permission") ? "Nur Administratoren können Stammdaten ändern." : error.message); return; }
    body.querySelector("#sd_err").hidden = true;
    setMsg(body, "sd_ok", "Gespeichert."); body.querySelector("#sd_ok").hidden = false;
    Object.assign(c, rec);
    if (onSaved) onSaved();
  });
}
function setMsg(body, id, msg) { const e = body.querySelector("#" + id); if (e) { e.textContent = msg; e.hidden = false; } }
