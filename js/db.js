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

// ---------- Wirtschaftsjahr ----------
// Startmonat (1–12) aus company.design.fyStart; 1 = Kalenderjahr.
export function fyStartMonth(company) {
  const m = company && company.design && +company.design.fyStart;
  return m >= 1 && m <= 12 ? m : 1;
}
// Label: Kalenderjahr "2026", sonst "2026/2027"
export function fyLabel(year, start) { return start === 1 ? String(year) : `${year}/${year + 1}`; }
// Zeitraum [von, bis] als ISO-Datum. year = Start-Kalenderjahr des Wirtschaftsjahres.
export function fyRange(year, start) {
  const from = `${year}-${String(start).padStart(2, "0")}-01`;
  const endM = start === 1 ? 12 : start - 1, endY = start === 1 ? year : year + 1;
  const lastDay = new Date(endY, endM, 0).getDate();
  return [from, `${endY}-${String(endM).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`];
}
// Aktuelles Wirtschaftsjahr (Start-Jahr) für heute
export function currentFYStartYear(start) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  return start === 1 || m >= start ? y : y - 1;
}

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
