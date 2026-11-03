// Gemeinsamer Supabase-Client + kleine Helfer für alle Module.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export function configured() {
  return SUPABASE_URL && SUPABASE_ANON_KEY && !/DEIN-/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
}

export const sb = configured() ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ---------- Helfer ----------
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtEUR = (n) => (Number(n) || 0).toLocaleString("de-AT", { style: "currency", currency: "EUR" });
export const fmtNum = (n) => (Number(n) || 0).toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = (d) => (d ? new Date(d + (/\d{4}-\d{2}-\d{2}$/.test(d) ? "T00:00:00" : "")).toLocaleDateString("de-AT") : "");
export const todayISO = () => new Date().toISOString().slice(0, 10);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16); }));

// Österreichische Zahl ("1.234,56" / "1 234,56-" / "-850,00") -> number
export function parseEuro(str) {
  if (str == null) return null;
  let s = String(str).trim();
  let neg = false;
  if (/[-−]\s*$/.test(s) || /^\s*[-−]/.test(s) || /\bS\b\s*$/.test(s)) neg = true; // Soll / trailing minus
  if (/\bH\b\s*$/.test(s)) neg = false;                                             // Haben
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // Tausenderpunkt vor Dezimalkomma: "1.234,56"
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, ""); // "1.234.567"
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}
