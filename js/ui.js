// Gemeinsame UI-Helfer (Modal) für mehrere Module.
import { esc } from "./db.js";

export function modal(title, inner, actions) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3><button class="modal-x" aria-label="Schließen">✕</button></div>
    <div class="modal-body">${inner}</div>
    <div class="modal-foot">${actions.map((a) => `<button class="${a.cls}" ${a.id ? `id="${a.id}"` : ""} ${a.close ? 'data-close="1"' : ""}>${esc(a.label)}</button>`).join("")}</div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector(".modal-x").addEventListener("click", close);
  back.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  let downOnBack = false;
  back.addEventListener("mousedown", (e) => { downOnBack = e.target === back; });
  back.addEventListener("mouseup", (e) => { if (downOnBack && e.target === back) close(); });
  return back;
}
export function closeModal(el) { el.remove(); }
export function showErr(el, msg, id = "m_err") {
  const e = el.querySelector("#" + id);
  if (e) { e.textContent = msg; e.hidden = false; }
}
