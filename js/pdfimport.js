// Liest einen Kontoauszug als PDF ein und schlägt Buchungszeilen vor.
// pdf.js wird erst bei Bedarf vom CDN geladen (kein Build nötig).
import { parseEuro } from "./db.js";

const PDFJS_VER = "4.0.379";
let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.mjs`);
  lib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.mjs`;
  _pdfjs = lib;
  return lib;
}

const DATE_RE = /\b(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})\b|\b(\d{1,2})[.\/](\d{1,2})\.?(?=\s|$)/;
const DATE_RE_G = new RegExp(DATE_RE.source, "g");
// Betrag: Tausenderpunkt (kein Leerzeichen, sonst verschmelzen Zahlen) + Dezimalkomma, optionales nachgestelltes Minus.
const AMT_RE = /\d{1,3}(?:\.\d{3})*,\d{2}[-−]?|\d+,\d{2}[-−]?/g;
const SKIP_RE = /\b(Saldo|Saldovortrag|Kontostand|Übertrag|Zwischensumme|Gesamtsumme|Summe|Auszug|Blatt|Seite)\b/i;
const DEBIT_RE = /\b(Lastschrift|SEPA-Lastschrift|Abbuchung|Bankspesen|Kontoführung|Entgelt|Gebühr|Dauerauftrag)\b/i;

// Rohe Textzeilen aus dem PDF rekonstruieren (nach y-Position gruppiert, nach x sortiert).
export async function extractLines(arrayBuffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: arrayBuffer }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map(); // y (gerundet) -> items
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = Math.round(it.transform[5]);
      let key = null;
      for (const k of rows.keys()) { if (Math.abs(k - y) <= 3) { key = k; break; } }
      if (key == null) { key = y; rows.set(key, []); }
      rows.get(key).push({ x, str: it.str });
    }
    const ys = [...rows.keys()].sort((a, b) => b - a); // oben -> unten
    for (const y of ys) {
      const items = rows.get(y).sort((a, b) => a.x - b.x);
      const text = items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
      if (text) lines.push({ page: p, items, text });
    }
  }
  return lines;
}

function parseDate(m) {
  if (!m) return null;
  let d, mo, y;
  if (m[1]) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else { d = +m[4]; mo = +m[5]; y = new Date().getFullYear(); }
  if (y < 100) y += 2000;
  if (!d || !mo || mo > 12 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Aus den Zeilen Buchungskandidaten ableiten.
// Rückgabe: [{ datum, betrag(positiv), typ, text, raw, confidence }]
export function parseStatement(lines) {
  const out = [];
  let lastDate = null;
  for (const ln of lines) {
    const t = ln.text;
    if (!t) continue;
    if (SKIP_RE.test(t)) continue;                 // Saldo-/Summenzeilen sind keine Buchungen
    AMT_RE.lastIndex = 0;
    const amts = t.match(AMT_RE);
    const dm = t.match(DATE_RE);
    const dte = parseDate(dm);
    if (dte) lastDate = dte;
    if (!amts || !amts.length) continue;
    if (/\b(IBAN|BIC)\b/i.test(t)) continue;       // Kopfzeilen mit Nummern

    // Bei mehreren Beträgen ist der letzte meist der Kontostand -> Buchungsbetrag = vorletzter.
    const pick = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
    const val = parseEuro(pick);
    if (val == null || val === 0) continue;

    // Vorzeichen/Richtung: nachgestelltes Minus oder eindeutige Soll-Begriffe
    let signed = val;
    if (signed > 0 && DEBIT_RE.test(t)) signed = -signed;

    // Beschreibung: Datum & Beträge aus dem Text entfernen
    let desc = t.replace(DATE_RE_G, " ");
    AMT_RE.lastIndex = 0;
    desc = desc.replace(AMT_RE, " ").replace(/\s+/g, " ").trim();

    out.push({
      datum: dte || lastDate,
      betrag: Math.abs(signed),
      typ: signed < 0 ? "ausgabe" : "einnahme",
      text: desc.slice(0, 180),
      raw: t,
      confidence: dte && amts.length <= 2 ? "hoch" : "mittel",
    });
  }
  return out;
}

// Komfort: Datei -> Kandidaten
export async function parseFile(file) {
  const buf = await file.arrayBuffer();
  const lines = await extractLines(buf);
  return { lines, rows: parseStatement(lines) };
}

// ---------- Budgetplanung: Kostenstellen + Soll-Werte erkennen ----------
const EINNAHME_RE = /\b(einnahm|erl[öo]s|ertrag|einzahlung|einkünft|zuschuss|f[öo]rder|subvention|sponsor|beitrag|umsatz)/i;
const AUSGABE_RE = /\b(ausgab|aufwand|aufwendung|kosten|auszahlung|material|miete|personal)/i;
const SUM_RE = /\b(summe|gesamt|zwischensumme|saldo|überschuss|abgang|total|ergebnis|differenz|bilanz)\b/i;

const AMT1 = /\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/;

// Mehrere Beträge je Kostenstelle (gleicher Name + Art) zu einer Summe zusammenfassen
function aggregateBudget(raw) {
  const map = new Map();
  for (const r of raw) {
    if (!(r.soll > 0)) continue;
    const key = r.kostenstelle.trim().toLowerCase() + "|" + r.typ;
    if (map.has(key)) map.get(key).soll = Math.round((map.get(key).soll + r.soll) * 100) / 100;
    else map.set(key, { kostenstelle: r.kostenstelle.trim(), typ: r.typ, soll: r.soll });
  }
  return [...map.values()];
}

// Format mit Spaltenkopf „… Einnahmen Ausgaben": nur GROSS geschriebene Haupt-
// Kostenstellen (ohne Kleinbuchstaben, max. 2 Spaltenwerte) übernehmen, Details raus.
function parseBudgetTwoCol(lines) {
  let xEin = null, xAus = null;
  for (const ln of lines) {
    if (/einnahmen/i.test(ln.text) && /ausgaben/i.test(ln.text)) {
      for (const it of ln.items || []) { if (/einnahmen/i.test(it.str)) xEin = it.x; if (/ausgaben/i.test(it.str)) xAus = it.x; }
      if (xEin != null && xAus != null) break;
    }
  }
  if (xEin == null || xAus == null) return null;
  const raw = [];
  for (const ln of lines) {
    const t = (ln.text || "").trim(); if (!t || SUM_RE.test(t)) continue;
    const fi = t.search(AMT1); if (fi < 0) continue;
    const name = t.slice(0, fi).replace(/^[\d\/\s]+/, "").replace(/[-€\s.]+$/, "").trim();
    if (name.replace(/[^A-Za-zÄÖÜäöüß]/g, "").length < 3) continue;
    if (/[a-zäöüß]/.test(t)) continue;                 // Detailzeilen enthalten Kleinbuchstaben
    if (name !== name.toUpperCase()) continue;
    AMT_RE.lastIndex = 0;
    const amts = t.match(AMT_RE) || [];
    if (!amts.length || amts.length > 2) continue;
    if (amts.length === 2) {
      raw.push({ kostenstelle: name, typ: "einnahme", soll: Math.abs(parseEuro(amts[0]) || 0) });
      raw.push({ kostenstelle: name, typ: "ausgabe", soll: Math.abs(parseEuro(amts[1]) || 0) });
    } else {
      const ai = (ln.items || []).filter((it) => AMT1.test(it.str)).pop();
      const x = ai ? ai.x : null;
      const typ = x != null ? (Math.abs(x - xEin) <= Math.abs(x - xAus) ? "einnahme" : "ausgabe") : (EINNAHME_RE.test(t) ? "einnahme" : "ausgabe");
      raw.push({ kostenstelle: name, typ, soll: Math.abs(parseEuro(amts[0]) || 0) });
    }
  }
  const rows = aggregateBudget(raw);
  return rows.length ? rows : null;
}

export function parseBudget(lines) {
  const two = parseBudgetTwoCol(lines);
  if (two) return two;
  // Fallback: generisch, Abschnitte Einnahmen/Ausgaben
  const raw = []; let section = null;
  for (const ln of lines) {
    const t = (ln.text || "").trim(); if (!t) continue;
    AMT_RE.lastIndex = 0;
    const amts = t.match(AMT_RE);
    if (!amts || !amts.length) {
      if (EINNAHME_RE.test(t) && !AUSGABE_RE.test(t)) section = "einnahme";
      else if (AUSGABE_RE.test(t)) section = "ausgabe";
      continue;
    }
    if (SUM_RE.test(t)) continue;
    const val = parseEuro(amts[amts.length - 1]);
    if (val == null || Math.abs(val) < 0.01) continue;
    AMT_RE.lastIndex = 0;
    let name = t.replace(AMT_RE, " ").replace(/[.…]{2,}/g, " ").replace(/\s+/g, " ").trim().replace(/[\s:·–—-]+$/g, "").trim();
    if (name.length < 2 || /^\d+$/.test(name)) continue;
    let typ = section;
    if (EINNAHME_RE.test(t) && !AUSGABE_RE.test(t)) typ = "einnahme";
    else if (AUSGABE_RE.test(t)) typ = "ausgabe";
    if (!typ) typ = "ausgabe";
    raw.push({ kostenstelle: name.slice(0, 60), typ, soll: Math.abs(val) });
  }
  return aggregateBudget(raw);
}

export async function parseBudgetBuffer(buf) {
  const lines = await extractLines(buf);
  return { lines, rows: parseBudget(lines) };
}
export async function parseBudgetFile(file) {
  return parseBudgetBuffer(await file.arrayBuffer());
}
