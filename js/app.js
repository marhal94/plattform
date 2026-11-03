import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const app = document.getElementById("app");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CREST = '<div class="crest" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2l8 3v6c0 5-3.4 8.5-8 11-4.6-2.5-8-6-8-11V5l8-3z"/><path d="M9 12l2 2 4-4"/></svg></div>';

let sb = null;
const state = { session: null, profile: null, page: "cockpit" };

// ---------- Boot ----------
function configured() {
  return SUPABASE_URL && SUPABASE_ANON_KEY && !/DEIN-/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
}

async function boot() {
  if (!configured()) { renderSetup(); return; }
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange((_e, session) => {
    state.session = session;
    state.profile = null;
    route();
  });
  route();
}

async function route() {
  if (!state.session) { renderLogin(); return; }
  if (!state.profile) await loadProfile();
  renderApp();
}

async function loadProfile() {
  try {
    const { data } = await sb.from("profiles").select("name, role").eq("id", state.session.user.id).single();
    state.profile = data || { name: null, role: "mitarbeiter" };
  } catch { state.profile = { name: null, role: "mitarbeiter" }; }
}

// ---------- Setup screen (Supabase not configured) ----------
function renderSetup() {
  app.className = "";
  app.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand">${CREST}<div><div class="eyebrow">TecnoFutbol · Plattform</div><h1>Einrichtung</h1></div></div>
    <div class="msg info">Noch kein Supabase-Zugang hinterlegt.</div>
    <p class="note">Trage in <code>js/config.js</code> deine <b>Project URL</b> und den <b>anon public key</b> ein
    (Supabase → Project Settings → API). Danach Seite neu laden. Der anon key ist öffentlich und kein Geheimnis.</p>
  </div></div>`;
}

// ---------- Login ----------
function renderLogin(msg) {
  app.className = "";
  app.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand">${CREST}<div><div class="eyebrow">TecnoFutbol · Plattform</div><h1>Anmelden</h1></div></div>
    ${msg ? `<div class="msg err">${esc(msg)}</div>` : ""}
    <form id="loginForm">
      <div class="field"><label>E-Mail</label><input id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label>Passwort</label><input id="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary" style="width:100%;justify-content:center" id="loginBtn" type="submit">Anmelden</button>
    </form>
    <div class="note">Zugänge legt der Administrator an. Passwort vergessen? Bitte an die Vereinsleitung wenden.</div>
  </div></div>`;
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("loginBtn");
    btn.disabled = true; btn.textContent = "Anmelden …";
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { renderLogin(error.message === "Invalid login credentials" ? "E-Mail oder Passwort falsch." : error.message); }
    // success → onAuthStateChange triggert route()
  });
}

// ---------- App shell ----------
const PAGES = [
  { id: "cockpit", label: "Cockpit" },
  { id: "finanzen", label: "Finanzen" },
  { id: "mitglieder", label: "Mitglieder", soon: true },
  { id: "kommunikation", label: "Kommunikation", soon: true },
  { id: "social", label: "Social Media", soon: true },
];

function renderApp() {
  app.className = "";
  const p = state.profile || {};
  const email = state.session.user.email || "";
  const initials = (p.name || email).slice(0, 2).toUpperCase();
  const roleLabel = p.role === "admin" ? "Admin" : "Mitarbeiter";
  app.innerHTML = `
    <div class="topbar">
      <div class="brand">${CREST}<div><div class="eyebrow">TecnoFutbol</div><h1>Plattform</h1></div></div>
      <nav class="nav">${PAGES.map((pg) => `<button data-nav="${pg.id}" class="${state.page === pg.id ? "active" : ""}">${pg.label}${pg.soon ? '<span class="soon">bald</span>' : ""}</button>`).join("")}</nav>
      <div class="spacer"></div>
      <span class="user-chip"><span class="av">${esc(initials)}</span><span>${esc(p.name || email)}</span><span class="role">${roleLabel}</span></span>
      <button class="btn sm" id="logoutBtn" type="button">Abmelden</button>
    </div>
    <main class="main" id="pageBody"></main>`;
  app.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => {
    const pg = PAGES.find((x) => x.id === b.dataset.nav);
    if (pg.soon) return;
    state.page = b.dataset.nav; renderApp();
  }));
  document.getElementById("logoutBtn").addEventListener("click", () => sb.auth.signOut());
  renderPage();
}

async function renderPage() {
  const body = document.getElementById("pageBody");
  if (state.page === "finanzen") return renderFinanzen(body);
  // default: cockpit
  body.innerHTML = `<h2 class="page-title">Cockpit</h2><div class="page-sub">Überblick über Finanzen, Mitglieder und Kommunikation.</div>
    <div class="card"><div class="empty">Die Kennzahlen-Übersicht wird hier aufgebaut, sobald Finanzen & Mitglieder befüllt sind.</div></div>`;
}

async function renderFinanzen(body) {
  body.innerHTML = `<h2 class="page-title">Finanzen</h2><div class="page-sub">Unternehmen & Rechnungen.</div><div id="coList" class="grid"><div class="empty">Lädt …</div></div>`;
  const list = document.getElementById("coList");
  const { data, error } = await sb.from("companies").select("key,name,form,plz,ort,tax_mode,design").order("name");
  if (error) {
    list.innerHTML = `<div class="card"><div class="msg err">Konnte Unternehmen nicht laden: ${esc(error.message)}</div>
      <p class="note">Falls die Tabelle noch fehlt: das Datenbank-Schema (<code>supabase/schema.sql</code>) im Supabase SQL-Editor ausführen.</p></div>`;
    return;
  }
  if (!data || !data.length) { list.innerHTML = `<div class="empty">Noch keine Unternehmen freigeschaltet.</div>`; return; }
  list.innerHTML = data.map((c) => {
    const accent = (c.design && c.design.accent) || "#184437";
    const mode = c.tax_mode === "regel" ? "mit USt" : "ohne USt";
    return `<div class="co-row"><span class="dot" style="background:${esc(accent)}"></span>
      <div style="flex:1"><div class="nm">${esc(c.name)}</div><div class="bd">${esc(c.form || "")} · ${esc((c.plz || "") + " " + (c.ort || ""))}</div></div>
      <span class="badge">${mode}</span></div>`;
  }).join("");
}

boot();
