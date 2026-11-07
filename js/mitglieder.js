// Mitgliederbereich (SC Weiz): Mitglieder verwalten, Online-Anmeldungen freischalten,
// Zahlungseingänge (SEPA/Überweisung/Bar) je Mitglied, Bezahlt-Übersicht, Mitgliederbrief.
import { sb, esc, fmtEUR, fmtDate, todayISO, fyStartMonth, fyLabel, currentFYStartYear } from "./db.js";
import { modal, showErr } from "./ui.js";

const SCW_KEY = "scw";
const M = { company: null, members: [], payments: [], year: new Date().getFullYear(), userId: null, body: null, err: null, filter: { status: "", q: "", zahlart: "" } };
const ZA = { sepa: "SEPA", ueberweisung: "Überweisung", bar: "Bar" };

export async function renderMitglieder(body) {
  M.body = body;
  body.innerHTML = `<h2 class="page-title">Mitglieder</h2><div class="page-sub">SC Weiz</div><div class="empty">Lädt …</div>`;
  if (!M.userId) { const u = await sb.auth.getUser(); M.userId = u.data && u.data.user ? u.data.user.id : null; }
  const { data: cos, error } = await sb.from("companies").select("id,name,key,design").eq("key", SCW_KEY);
  if (error) { body.innerHTML = `<div class="card"><div class="msg err">${esc(error.message)}</div></div>`; return; }
  if (!cos || !cos.length) {
    body.innerHTML = `<h2 class="page-title">Mitglieder</h2><div class="card"><div class="empty">Der Mitgliederbereich ist für <b>SC Weiz</b> gedacht. Dein Zugang ist dafür nicht freigeschaltet.</div></div>`;
    return;
  }
  M.company = cos[0];
  if (!M._init) { M.year = currentFYStartYear(fyStartMonth(M.company)); M._init = true; }
  await loadData();
  if (M.err) { body.innerHTML = `<div class="card"><div class="msg err">Konnte Mitglieder nicht laden: ${esc(M.err)}</div><p class="note">Falls die Tabellen fehlen: <code>supabase/schema_mitglieder.sql</code> im Supabase-SQL-Editor ausführen.</p></div>`; return; }
  renderMain();
}

async function loadData() {
  M.err = null;
  const [mb, pm] = await Promise.all([
    sb.from("members").select("*").eq("company_id", M.company.id).order("nachname").order("vorname"),
    sb.from("member_payments").select("*").eq("company_id", M.company.id),
  ]);
  if (mb.error) { M.err = mb.error.message; return; }
  M.members = mb.data || [];
  M.payments = pm.error ? [] : (pm.data || []);
}

// ---------- Berechnungen ----------
const fullName = (m) => `${m.nachname || ""}${m.nachname && m.vorname ? ", " : ""}${m.vorname || ""}`.trim() || "(ohne Namen)";
// Beitragsjahr = Wirtschaftsjahr von SC Weiz (Start-Jahr, z. B. 2026 = 2026/2027)
const fyStart = () => fyStartMonth(M.company);
const fyl = (y = M.year) => fyLabel(y, fyStart());
function fyOfDate(d) { const dt = new Date(d), y = dt.getFullYear(), m = dt.getMonth() + 1, s = fyStart(); return s === 1 || m >= s ? y : y - 1; }
const payYear = (p) => (p.jahr != null ? p.jahr : fyOfDate(p.datum));
const paymentsOf = (id, year) => M.payments.filter((p) => p.member_id === id && (year == null || payYear(p) === year));
const paidSum = (id, year) => paymentsOf(id, year).reduce((s, p) => s + (+p.betrag || 0), 0);
function payStatus(m) {
  const paid = paidSum(m.id, M.year), beitrag = +m.beitrag || 0;
  if (beitrag > 0) return paid >= beitrag ? "bezahlt" : (paid > 0 ? "teilweise" : "offen");
  return paid > 0 ? "bezahlt" : "kein";
}

// ---------- Haupt-Render ----------
function renderMain() {
  const body = M.body;
  const aktiv = M.members.filter((m) => m.status === "aktiv");
  const pending = M.members.filter((m) => m.status === "offen");
  const bezahlt = aktiv.filter((m) => payStatus(m) === "bezahlt").length;
  const einnahmen = M.payments.filter((p) => payYear(p) === M.year).reduce((s, p) => s + (+p.betrag || 0), 0);
  const offenBetrag = aktiv.reduce((s, m) => { const b = +m.beitrag || 0, p = paidSum(m.id, M.year); return s + (b > p ? b - p : 0); }, 0);
  body.innerHTML = `
    <div class="fin-head">
      <div><h2 class="page-title" style="margin:0">Mitglieder · SC Weiz</h2><div class="page-sub" style="margin:2px 0 0">Verwaltung, Beiträge & Zahlungen</div></div>
      <div class="fin-pickers">
        <label class="inline">Beitragsjahr<select id="mYear">${yearOpts()}</select></label>
      </div>
    </div>
    <div class="stat-row">
      ${stat("Mitglieder", String(M.members.length), "plain")}
      ${stat("Aktiv", String(aktiv.length), "plain")}
      ${stat(`Bezahlt ${fyl()}`, `${bezahlt}/${aktiv.length}`, "good")}
      ${stat(`Einnahmen ${fyl()}`, fmtEUR(einnahmen), "good")}
      ${stat("Offen", fmtEUR(offenBetrag), offenBetrag > 0 ? "crit" : "good")}
    </div>
    <div class="row-between" style="margin:16px 0 12px">
      <div class="filters">
        <select id="fStatus"><option value="">Alle Status</option><option value="aktiv">Aktiv</option><option value="offen">Neue Anmeldung</option><option value="inaktiv">Inaktiv</option></select>
        <select id="fZahl"><option value="">Alle Zahlarten</option><option value="sepa">SEPA</option><option value="ueberweisung">Überweisung</option><option value="bar">Bar</option></select>
        <input id="fSuche" placeholder="Suche Name/E-Mail …" style="width:200px">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" id="btnImport">Excel importieren</button>
        <button class="btn sm" id="btnLink">Anmelde-Link</button>
        <button class="btn sm" id="btnBrief">Mitgliederbrief</button>
        <button class="btn primary" id="btnNew">+ Mitglied</button>
      </div>
    </div>
    ${pending.length ? `<div class="card" style="border-color:var(--accent);margin-bottom:14px">
      <div class="row-between"><div><b>${pending.length} neue Online-Anmeldung(en)</b> <span class="muted">warten auf Freischaltung</span></div></div>
    </div>` : ""}
    <div class="card" id="mTable"></div>`;
  body.querySelector("#mYear").addEventListener("change", (e) => { M.year = +e.target.value; renderMain(); });
  body.querySelector("#btnNew").addEventListener("click", () => editMember(null));
  body.querySelector("#btnImport").addEventListener("click", startImport);
  body.querySelector("#btnLink").addEventListener("click", showLink);
  body.querySelector("#btnBrief").addEventListener("click", showBrief);
  ["#fStatus", "#fZahl"].forEach((s) => body.querySelector(s).addEventListener("change", drawTable));
  body.querySelector("#fSuche").addEventListener("input", drawTable);
  drawTable();
}
function yearOpts(selected = M.year) {
  const s = fyStart(), cur = currentFYStartYear(s); let o = "";
  for (let y = cur + 1; y >= cur - 4; y--) o += `<option value="${y}" ${y === selected ? "selected" : ""}>${fyLabel(y, s)}</option>`;
  return o;
}
function stat(label, value, tone) { return `<div class="stat ${tone}"><div class="stat-l">${esc(label)}</div><div class="stat-v">${esc(value)}</div></div>`; }

function drawTable() {
  const body = M.body;
  const status = body.querySelector("#fStatus").value, zahl = body.querySelector("#fZahl").value, q = body.querySelector("#fSuche").value.trim().toLowerCase();
  let rows = M.members.slice();
  if (status) rows = rows.filter((m) => m.status === status);
  if (zahl) rows = rows.filter((m) => m.zahlart === zahl);
  if (q) rows = rows.filter((m) => (fullName(m) + " " + (m.email || "")).toLowerCase().includes(q));
  const psPill = { bezahlt: '<span class="pill einnahme">bezahlt</span>', teilweise: '<span class="pill warn">teilweise</span>', offen: '<span class="pill ausgabe">offen</span>', kein: '<span class="muted">–</span>' };
  const stPill = { aktiv: '<span class="pill einnahme">aktiv</span>', offen: '<span class="pill warn">neu</span>', inaktiv: '<span class="muted">inaktiv</span>' };
  body.querySelector("#mTable").innerHTML = rows.length ? `
    <div class="tbl-scroll"><table class="tbl">
      <thead><tr><th>Name</th><th>Kontakt</th><th>Status</th><th>Typ</th><th class="num">Beitrag</th><th>Zahlart</th><th>Bezahlt ${fyl()}</th><th></th></tr></thead>
      <tbody>${rows.map((m) => `<tr>
        <td><b>${esc(fullName(m))}</b>${m.quelle === "online" ? ' <span class="tag">online</span>' : ""}</td>
        <td>${esc(m.email || "")}${m.tel ? "<br><span class='muted'>" + esc(m.tel) + "</span>" : ""}</td>
        <td>${stPill[m.status] || esc(m.status)}</td>
        <td>${esc(m.typ || "")}</td>
        <td class="num">${fmtEUR(m.beitrag)}</td>
        <td>${ZA[m.zahlart] || ""}</td>
        <td>${psPill[payStatus(m)]} <span class="muted">${fmtEUR(paidSum(m.id, M.year))}</span></td>
        <td class="act">
          ${m.status === "offen" ? `<button class="lnk" data-activate="${m.id}">Freischalten</button>` : ""}
          <button class="lnk" data-pay="${m.id}">Zahlung</button>
          <button class="lnk" data-edit="${m.id}">Bearbeiten</button>
          <button class="lnk del" data-del="${m.id}">Löschen</button>
        </td></tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty">Keine Mitglieder${status || zahl || q ? " für diesen Filter" : ""}. Lege eins mit „+ Mitglied" an oder teile den Anmelde-Link.</div>`;
  body.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => editMember(M.members.find((x) => x.id === el.dataset.edit))));
  body.querySelectorAll("[data-pay]").forEach((el) => el.addEventListener("click", () => recordPayment(M.members.find((x) => x.id === el.dataset.pay))));
  body.querySelectorAll("[data-activate]").forEach((el) => el.addEventListener("click", () => activate(el.dataset.activate)));
  body.querySelectorAll("[data-del]").forEach((el) => el.addEventListener("click", () => delMember(el.dataset.del)));
}

async function activate(id) {
  const { error } = await sb.from("members").update({ status: "aktiv" }).eq("id", id);
  if (error) { alert(error.message); return; }
  await loadData(); renderMain();
}
async function delMember(id) {
  const m = M.members.find((x) => x.id === id);
  if (!confirm(`Mitglied ${m ? fullName(m) : ""} wirklich löschen? Auch die erfassten Zahlungen werden entfernt.`)) return;
  const { error } = await sb.from("members").delete().eq("id", id);
  if (error) { alert(error.message); return; }
  await loadData(); renderMain();
}

// ---------- Mitglied anlegen / bearbeiten ----------
function editMember(m) {
  const edit = !!m;
  const o = m || { vorname: "", nachname: "", email: "", tel: "", strasse: "", plz: "", ort: "", geburtsdatum: "", typ: "Aktiv", beitrag: "", zahlart: "ueberweisung", status: "aktiv", sepa_iban: "", sepa_bic: "", sepa_inhaber: "", sepa_mandat: "", sepa_mandat_datum: "", notiz: "" };
  const el = modal(edit ? "Mitglied bearbeiten" : "Neues Mitglied", `
    <div class="form-grid">
      <label>Vorname<input id="e_vn" value="${esc(o.vorname || "")}"></label>
      <label>Nachname<input id="e_nn" value="${esc(o.nachname || "")}"></label>
      <label>E-Mail<input id="e_mail" value="${esc(o.email || "")}"></label>
      <label>Telefon<input id="e_tel" value="${esc(o.tel || "")}"></label>
      <label class="col2">Straße & Nr.<input id="e_str" value="${esc(o.strasse || "")}"></label>
      <label>PLZ<input id="e_plz" value="${esc(o.plz || "")}"></label>
      <label>Ort<input id="e_ort" value="${esc(o.ort || "")}"></label>
      <label>Geburtsdatum<input id="e_geb" type="date" value="${esc(o.geburtsdatum || "")}"></label>
      <label>Mitgliedschaft<input id="e_typ" value="${esc(o.typ || "")}" placeholder="Aktiv / Unterstützend / Jugend"></label>
      <label>Jahresbeitrag (€)<input id="e_beitrag" type="number" step="0.01" value="${esc(o.beitrag)}"></label>
      <label>Status<select id="e_status">
        <option value="aktiv" ${o.status === "aktiv" ? "selected" : ""}>Aktiv</option>
        <option value="offen" ${o.status === "offen" ? "selected" : ""}>Neu / offen</option>
        <option value="inaktiv" ${o.status === "inaktiv" ? "selected" : ""}>Inaktiv</option>
      </select></label>
      <label>Zahlart<select id="e_za">
        <option value="ueberweisung" ${o.zahlart === "ueberweisung" ? "selected" : ""}>Überweisung</option>
        <option value="sepa" ${o.zahlart === "sepa" ? "selected" : ""}>SEPA-Lastschrift</option>
        <option value="bar" ${o.zahlart === "bar" ? "selected" : ""}>Bar</option>
      </select></label>
    </div>
    <div id="e_sepa" class="sepa-box" ${o.zahlart === "sepa" ? "" : "hidden"}>
      <h4 class="sec">SEPA-Lastschriftmandat</h4>
      <div class="form-grid">
        <label class="col2">Kontoinhaber<input id="e_inh" value="${esc(o.sepa_inhaber || "")}"></label>
        <label>IBAN<input id="e_iban" value="${esc(o.sepa_iban || "")}"></label>
        <label>BIC<input id="e_bic" value="${esc(o.sepa_bic || "")}"></label>
        <label>Mandatsreferenz<input id="e_mref" value="${esc(o.sepa_mandat || "")}"></label>
        <label>Mandat erteilt am<input id="e_mdat" type="date" value="${esc(o.sepa_mandat_datum || "")}"></label>
      </div>
    </div>
    <label style="margin-top:12px">Notiz<input id="e_notiz" value="${esc(o.notiz || "")}"></label>
    <div id="m_err" class="msg err" hidden></div>`,
    [{ label: "Abbrechen", cls: "btn", close: true }, { label: edit ? "Speichern" : "Anlegen", cls: "btn primary", id: "e_save" }]);
  el.querySelector("#e_za").addEventListener("change", (e) => { el.querySelector("#e_sepa").hidden = e.target.value !== "sepa"; });
  el.querySelector("#e_save").addEventListener("click", async () => {
    const g = (id) => el.querySelector(id).value;
    const rec = {
      company_id: M.company.id, vorname: g("#e_vn").trim() || null, nachname: g("#e_nn").trim() || null,
      email: g("#e_mail").trim() || null, tel: g("#e_tel").trim() || null,
      strasse: g("#e_str").trim() || null, plz: g("#e_plz").trim() || null, ort: g("#e_ort").trim() || null,
      geburtsdatum: g("#e_geb") || null, typ: g("#e_typ").trim() || null, beitrag: parseFloat(g("#e_beitrag")) || 0,
      status: g("#e_status"), zahlart: g("#e_za"),
      sepa_inhaber: g("#e_inh").trim() || null, sepa_iban: (g("#e_iban") || "").replace(/\s/g, "") || null,
      sepa_bic: g("#e_bic").trim() || null, sepa_mandat: g("#e_mref").trim() || null, sepa_mandat_datum: g("#e_mdat") || null,
      notiz: g("#e_notiz").trim() || null,
    };
    if (!rec.vorname && !rec.nachname) { showErr(el, "Bitte einen Namen angeben."); return; }
    const btn = el.querySelector("#e_save"); btn.disabled = true; btn.textContent = "Speichert …";
    let error;
    if (edit) ({ error } = await sb.from("members").update(rec).eq("id", m.id));
    else { rec.quelle = "manuell"; rec.created_by = M.userId; ({ error } = await sb.from("members").insert(rec)); }
    if (error) { showErr(el, error.message); btn.disabled = false; btn.textContent = edit ? "Speichern" : "Anlegen"; return; }
    el.remove(); await loadData(); renderMain();
  });
}

// ---------- Zahlung erfassen ----------
function recordPayment(m) {
  const paid = paidSum(m.id, M.year), rest = Math.max(0, (+m.beitrag || 0) - paid);
  const el = modal(`Zahlung · ${fullName(m)}`, `
    <p class="note" style="margin:0 0 12px">Beitrag ${fyl()}: ${fmtEUR(m.beitrag)} · bereits bezahlt: ${fmtEUR(paid)}${rest > 0 ? " · offen: " + fmtEUR(rest) : ""}</p>
    <div class="form-grid">
      <label>Datum<input id="p_datum" type="date" value="${todayISO()}"></label>
      <label>Betrag (€)<input id="p_betrag" type="number" step="0.01" value="${rest || m.beitrag || ""}"></label>
      <label>Zahlart<select id="p_za">
        <option value="${m.zahlart}">${ZA[m.zahlart]}</option>
        ${Object.entries(ZA).filter(([k]) => k !== m.zahlart).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
      </select></label>
      <label>Beitragsjahr<select id="p_jahr">${yearOpts()}</select></label>
      <label class="col2">Notiz<input id="p_notiz" placeholder="optional"></label>
    </div>
    <div id="m_err" class="msg err" hidden></div>
    <div style="margin-top:14px"><h4 class="sec">Bisherige Zahlungen</h4>${paymentsHtml(m.id)}</div>`,
    [{ label: "Schließen", cls: "btn", close: true }, { label: "Zahlung buchen", cls: "btn primary", id: "p_save" }]);
  el.querySelectorAll("[data-pdel]").forEach((d) => d.addEventListener("click", async () => {
    if (!confirm("Diese Zahlung löschen?")) return;
    await sb.from("member_payments").delete().eq("id", d.dataset.pdel);
    await loadData(); el.remove(); recordPayment(M.members.find((x) => x.id === m.id)); renderMain();
  }));
  el.querySelector("#p_save").addEventListener("click", async () => {
    const betrag = parseFloat(el.querySelector("#p_betrag").value) || 0;
    if (betrag <= 0) { showErr(el, "Bitte einen Betrag > 0 angeben."); return; }
    const rec = {
      member_id: m.id, company_id: M.company.id, datum: el.querySelector("#p_datum").value || todayISO(),
      betrag, zahlart: el.querySelector("#p_za").value, jahr: parseInt(el.querySelector("#p_jahr").value, 10) || M.year,
      notiz: el.querySelector("#p_notiz").value.trim() || null, created_by: M.userId,
    };
    const btn = el.querySelector("#p_save"); btn.disabled = true; btn.textContent = "Bucht …";
    const { error } = await sb.from("member_payments").insert(rec);
    if (error) { showErr(el, error.message); btn.disabled = false; btn.textContent = "Zahlung buchen"; return; }
    el.remove(); await loadData(); renderMain();
  });
}
function paymentsHtml(memberId) {
  const ps = M.payments.filter((p) => p.member_id === memberId).sort((a, b) => (b.datum > a.datum ? 1 : -1));
  if (!ps.length) return `<div class="muted" style="font-size:12.5px">Noch keine Zahlungen erfasst.</div>`;
  return `<table class="tbl"><tbody>${ps.map((p) => `<tr>
    <td>${fmtDate(p.datum)}</td><td>${ZA[p.zahlart] || ""}</td><td class="muted">${fyl(payYear(p))}</td>
    <td class="num pos">${fmtEUR(p.betrag)}</td>
    <td class="act"><button class="lnk del" data-pdel="${p.id}">×</button></td></tr>`).join("")}</tbody></table>`;
}

// ---------- Anmelde-Link ----------
function showLink() {
  const url = location.origin + "/anmeldung.html";
  const el = modal("Anmelde-Link", `
    <p class="note" style="margin:0 0 10px">Teile diesen Link (Website, WhatsApp, QR-Code) — neue Mitglieder melden sich selbst an und erscheinen hier als „neue Anmeldung" zum Freischalten.</p>
    <div class="ks-add"><input id="lk" value="${esc(url)}" readonly><button class="btn primary" id="lkCopy">Kopieren</button></div>`,
    [{ label: "Schließen", cls: "btn", close: true }]);
  el.querySelector("#lkCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); el.querySelector("#lkCopy").textContent = "Kopiert ✓"; } catch { el.querySelector("#lk").select(); }
  });
}

// ---------- Mitgliederbrief ----------
function showBrief() {
  const empfaenger = M.members.filter((m) => m.status !== "inaktiv" && m.email);
  const mails = [...new Set(empfaenger.map((m) => m.email.trim()))];
  const el = modal("Mitgliederbrief senden", `
    <p class="note" style="margin:0 0 12px"><b>${mails.length}</b> Empfänger mit E-Mail (aktive & neue Mitglieder).
      Der Brief wird in deinem Mailprogramm mit allen Adressen im <b>BCC</b> geöffnet — dort als Absender <b>Mitglieder@sc-weiz.at</b> wählen und senden.</p>
    <div class="form-grid">
      <label class="col2">Betreff<input id="b_subj" value="SC Weiz · Mitgliederinfo"></label>
      <label class="col2">Text<textarea id="b_body" rows="5" placeholder="Liebe Mitglieder, …"></textarea></label>
    </div>
    <div id="m_err" class="msg err" hidden></div>
    <p class="note" id="b_hint"></p>`,
    [{ label: "Schließen", cls: "btn", close: true }, { label: "Adressen kopieren", cls: "btn", id: "b_copy" }, { label: "Im Mailprogramm öffnen", cls: "btn primary", id: "b_open" }]);
  if (!mails.length) { showErr(el, "Keine Empfänger mit E-Mail-Adresse."); }
  el.querySelector("#b_copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(mails.join(", ")); el.querySelector("#b_hint").textContent = `${mails.length} Adressen kopiert — in deinem Mailprogramm ins BCC-Feld einfügen.`; }
    catch { el.querySelector("#b_hint").textContent = mails.join(", "); }
  });
  el.querySelector("#b_open").addEventListener("click", () => {
    const subj = encodeURIComponent(el.querySelector("#b_subj").value);
    const body = encodeURIComponent(el.querySelector("#b_body").value);
    const bcc = encodeURIComponent(mails.join(","));
    const href = `mailto:Mitglieder@sc-weiz.at?bcc=${bcc}&subject=${subj}&body=${body}`;
    if (href.length > 1900) { el.querySelector("#b_hint").textContent = "Sehr viele Empfänger — bitte stattdessen die Adressen kopieren und im Mailprogramm ins BCC einfügen (eine lange mailto-Adresse wird von manchen Programmen abgeschnitten)."; }
    window.location.href = href;
  });
}

// ---------- Excel-/CSV-Import ----------
let _xlsx = null;
async function xlsxLib() { if (!_xlsx) { _xlsx = await import("https://esm.sh/xlsx@0.18.5"); } return _xlsx; }
const IMP = { rows: [], headers: [], map: {}, status: "aktiv", fileName: "" };
const IMPFIELDS = [
  { k: "name_full", label: "Name (Vor- & Nachname zusammen)" },
  { k: "vorname", label: "Vorname" },
  { k: "nachname", label: "Nachname" },
  { k: "email", label: "E-Mail" },
  { k: "tel", label: "Telefon" },
  { k: "strasse", label: "Straße" },
  { k: "plz", label: "PLZ" },
  { k: "ort", label: "Ort" },
  { k: "geburtsdatum", label: "Geburtsdatum" },
  { k: "mitglied_seit", label: "Mitglied seit" },
  { k: "typ", label: "Mitgliedschaft/Art" },
  { k: "beitrag", label: "Jahresbeitrag" },
  { k: "zahlart", label: "Zahlart" },
  { k: "sepa_iban", label: "IBAN" },
  { k: "sepa_bic", label: "BIC" },
  { k: "sepa_inhaber", label: "Kontoinhaber" },
  { k: "notiz", label: "Notiz" },
];
const SYN = {
  name_full: ["name", "mitglied", "fullname"],
  vorname: ["vorname", "firstname", "vname"],
  nachname: ["nachname", "familienname", "zuname", "lastname", "name"],
  email: ["email", "mail", "emailadresse", "mailadresse"],
  tel: ["telefon", "tel", "handy", "mobil", "mobilnummer", "telefonnummer", "phone"],
  strasse: ["strasse", "adresse", "anschrift", "str"],
  plz: ["plz", "postleitzahl", "zip"],
  ort: ["ort", "stadt", "wohnort"],
  geburtsdatum: ["geburtsdatum", "geburtstag", "geb", "gebdat", "birthday", "gebdatum"],
  mitglied_seit: ["mitgliedseit", "eintritt", "beitritt", "eintrittsdatum", "beitrittsdatum", "seit"],
  typ: ["mitgliedschaft", "mitgliedsart", "typ", "kategorie", "art"],
  beitrag: ["beitrag", "jahresbeitrag", "mitgliedsbeitrag", "betrag"],
  zahlart: ["zahlart", "zahlungsart", "zahlungsweise", "zahlweise"],
  sepa_iban: ["iban", "kontonummer", "konto"],
  sepa_bic: ["bic", "swift"],
  sepa_inhaber: ["kontoinhaber", "inhaber"],
  notiz: ["notiz", "bemerkung", "anmerkung", "kommentar", "info"],
};
const normH = (s) => String(s || "").toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss").replace(/[^a-z0-9]/g, "");
function autoMap(headers) {
  const used = new Set(), map = {};
  // Durchgang 1: exakte Treffer (verhindert, dass "Vorname" als "name" o. Ä. fehlzugeordnet wird)
  for (const f of IMPFIELDS) {
    const syn = SYN[f.k] || [f.k];
    const h = headers.find((hd) => !used.has(hd) && syn.some((s) => normH(hd) === normH(s)));
    if (h) { map[f.k] = h; used.add(h); }
  }
  // Durchgang 2: unscharfe Treffer nur für noch offene Felder
  for (const f of IMPFIELDS) {
    if (map[f.k]) continue;
    const syn = SYN[f.k] || [f.k];
    const h = headers.find((hd) => !used.has(hd) && syn.some((s) => normH(hd).includes(normH(s))));
    if (h) { map[f.k] = h; used.add(h); }
  }
  // name_full nur nutzen, wenn kein getrenntes Vor-/Nachname gefunden wurde
  if (map.vorname && map.nachname) delete map.name_full;
  return map;
}
const impStr = (v) => (v == null ? "" : (typeof v === "string" ? v.trim() : String(v).trim()));
function impNum(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[^\d,.\-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(s); return isNaN(n) ? 0 : n;
}
function impISO(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  if (typeof v === "number") { const d = new Date(Math.round((v - 25569) * 86400000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/); if (m) { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}
function impZahlart(v, iban) {
  const n = normH(v);
  if (/sepa|lastschrift|einzug|abbuchung/.test(n)) return "sepa";
  if (/uberweisung|bank|transfer|dauerauftrag/.test(n)) return "ueberweisung";
  if (/bar|cash/.test(n)) return "bar";
  return iban ? "sepa" : "ueberweisung";
}
function impGet(row, key) { const h = IMP.map[key]; return h != null ? row[h] : undefined; }
function impBuildRec(row) {
  let vn = impStr(impGet(row, "vorname")), nn = impStr(impGet(row, "nachname"));
  if (IMP.map.name_full && !vn && !nn) {
    const full = impStr(impGet(row, "name_full"));
    if (full.includes(",")) { const p = full.split(","); nn = p[0].trim(); vn = (p[1] || "").trim(); }
    else { const p = full.split(/\s+/); nn = p.length > 1 ? p.pop() : full; vn = p.join(" "); }
  }
  const iban = impStr(impGet(row, "sepa_iban")).replace(/\s/g, "");
  const rec = {
    company_id: M.company.id, vorname: vn || null, nachname: nn || null,
    email: impStr(impGet(row, "email")) || null, tel: impStr(impGet(row, "tel")) || null,
    strasse: impStr(impGet(row, "strasse")) || null, plz: impStr(impGet(row, "plz")) || null, ort: impStr(impGet(row, "ort")) || null,
    geburtsdatum: impISO(impGet(row, "geburtsdatum")), typ: impStr(impGet(row, "typ")) || null,
    beitrag: impNum(impGet(row, "beitrag")), zahlart: impZahlart(impGet(row, "zahlart"), iban),
    sepa_iban: iban || null, sepa_bic: impStr(impGet(row, "sepa_bic")) || null, sepa_inhaber: impStr(impGet(row, "sepa_inhaber")) || null,
    notiz: impStr(impGet(row, "notiz")) || null, status: IMP.status, quelle: "manuell", created_by: M.userId,
  };
  const seit = impISO(impGet(row, "mitglied_seit")); if (seit) rec.mitglied_seit = seit;
  return rec;
}

function startImport() {
  IMP.rows = []; IMP.headers = []; IMP.map = {}; IMP.fileName = "";
  const body = M.body;
  body.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <h2 class="page-title" style="margin:0">Mitglieder aus Excel importieren</h2>
      <button class="lnk" id="impBack">← Zur Mitgliederliste</button>
    </div>
    <div class="card dropzone" id="impDz">
      <div class="dz-inner">
        <div class="dz-ic">⬆︎</div>
        <div><b>Excel- oder CSV-Datei hier ablegen</b> oder <label class="lnk" for="impFile">Datei wählen</label></div>
        <div class="note" style="margin-top:4px">.xlsx, .xls oder .csv. Die erste Zeile sollte die Spaltenüberschriften enthalten. Du ordnest die Spalten danach zu und siehst eine Vorschau, bevor gespeichert wird.</div>
        <input id="impFile" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" hidden>
      </div>
    </div>
    <div id="impResult"></div>`;
  body.querySelector("#impBack").addEventListener("click", renderMain);
  const dz = body.querySelector("#impDz"), input = body.querySelector("#impFile");
  input.addEventListener("change", () => input.files[0] && impHandleFile(input.files[0]));
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) impHandleFile(f); });
}

async function impHandleFile(file) {
  const res = M.body.querySelector("#impResult");
  res.innerHTML = `<div class="card"><div class="empty">„${esc(file.name)}" wird gelesen …</div></div>`;
  try {
    const X = await xlsxLib();
    const wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = X.utils.sheet_to_json(ws, { defval: "", raw: true });
    if (!rows.length) { res.innerHTML = `<div class="card"><div class="msg info">Die Tabelle enthält keine Datenzeilen.</div></div>`; return; }
    const headers = [];
    rows.slice(0, 20).forEach((r) => Object.keys(r).forEach((k) => { if (!headers.includes(k)) headers.push(k); }));
    IMP.rows = rows; IMP.headers = headers; IMP.map = autoMap(headers); IMP.fileName = file.name;
    impRenderMapping();
  } catch (e) {
    res.innerHTML = `<div class="card"><div class="msg err">Datei konnte nicht gelesen werden: ${esc(e.message || e)}</div></div>`;
  }
}

function impRenderMapping() {
  const res = M.body.querySelector("#impResult");
  const opt = (sel) => `<option value="">— nicht importieren —</option>` + IMP.headers.map((h) => `<option value="${esc(h)}" ${h === sel ? "selected" : ""}>${esc(h)}</option>`).join("");
  res.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="card-title">${IMP.rows.length} Zeilen aus „${esc(IMP.fileName)}"</h3>
        <label class="inline">Status aller Importierten
          <select id="impStatus"><option value="aktiv" selected>Aktiv</option><option value="offen">Neu / offen</option><option value="inaktiv">Inaktiv</option></select>
        </label>
      </div>
      <p class="note" style="margin:0 0 10px">Ordne die Spalten deiner Datei den Feldern zu (automatisch vorausgefüllt). <b>Vor- und Nachname</b> (oder „Name zusammen") sollten belegt sein.</p>
      <div class="form-grid">
        ${IMPFIELDS.map((f) => `<label>${esc(f.label)}<select data-map="${f.k}">${opt(IMP.map[f.k])}</select></label>`).join("")}
      </div>
    </div>
    <div id="impPreview"></div>`;
  res.querySelector("#impStatus").addEventListener("change", (e) => { IMP.status = e.target.value; });
  res.querySelectorAll("[data-map]").forEach((el) => el.addEventListener("change", () => {
    const k = el.dataset.map; if (el.value) IMP.map[k] = el.value; else delete IMP.map[k]; impRenderPreview();
  }));
  impRenderPreview();
}

function impRenderPreview() {
  const box = M.body.querySelector("#impPreview");
  const recs = IMP.rows.map(impBuildRec);
  const valid = recs.filter((r) => r.vorname || r.nachname);
  const show = valid.slice(0, 6);
  box.innerHTML = `
    <div class="card" style="margin-top:14px">
      <div class="row-between" style="margin-bottom:10px">
        <h3 class="card-title">Vorschau</h3>
        <span class="muted">${valid.length} von ${IMP.rows.length} Zeilen haben einen Namen und werden importiert</span>
      </div>
      <div class="tbl-scroll"><table class="tbl">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Ort</th><th>Geb.</th><th>Mitgliedschaft</th><th class="num">Beitrag</th><th>Zahlart</th><th>IBAN</th></tr></thead>
        <tbody>${show.map((r) => `<tr>
          <td><b>${esc([r.nachname, r.vorname].filter(Boolean).join(", "))}</b></td>
          <td>${esc(r.email || "")}</td><td>${esc(r.ort || "")}</td><td>${r.geburtsdatum ? fmtDate(r.geburtsdatum) : ""}</td>
          <td>${esc(r.typ || "")}</td><td class="num">${r.beitrag ? fmtEUR(r.beitrag) : ""}</td>
          <td>${ZA[r.zahlart] || ""}</td><td>${esc(r.sepa_iban || "")}</td></tr>`).join("")}</tbody>
      </table></div>
      ${valid.length > show.length ? `<p class="note">… und ${valid.length - show.length} weitere.</p>` : ""}
      <div class="row-between" style="margin-top:14px">
        <button class="btn" id="impCancel">Abbrechen</button>
        <button class="btn primary" id="impSave" ${valid.length ? "" : "disabled"}>${valid.length} Mitglieder importieren</button>
      </div>
      <div id="imp_err" class="msg err" hidden style="margin-top:10px"></div>
    </div>`;
  box.querySelector("#impCancel").addEventListener("click", renderMain);
  box.querySelector("#impSave").addEventListener("click", impDoImport);
}

async function impDoImport(e) {
  const btn = e.target;
  const recs = IMP.rows.map(impBuildRec).filter((r) => r.vorname || r.nachname);
  if (!recs.length) return;
  btn.disabled = true;
  let ok = 0; const errs = [];
  for (let i = 0; i < recs.length; i += 200) {
    btn.textContent = `Importiert … (${ok}/${recs.length})`;
    const chunk = recs.slice(i, i + 200);
    const { error } = await sb.from("members").insert(chunk);
    if (error) errs.push(error.message); else ok += chunk.length;
  }
  if (errs.length) {
    const err = M.body.querySelector("#imp_err");
    if (err) { err.textContent = `${ok} importiert, aber Fehler bei den übrigen: ${errs[0]}`; err.hidden = false; }
    btn.disabled = false; btn.textContent = "Erneut versuchen";
    await loadData();
    return;
  }
  await loadData();
  renderMain();
  const b = M.body;
  const note = document.createElement("div");
  note.className = "msg ok"; note.style.margin = "0 0 14px";
  note.textContent = `${ok} Mitglieder erfolgreich importiert.`;
  b.insertBefore(note, b.querySelector(".stat-row"));
  setTimeout(() => note.remove(), 6000);
}
