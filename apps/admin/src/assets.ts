/**
 * Static assets, kept as strings so the build has nothing to copy. Served
 * from /admin/assets/*: the CSP allows only same-origin scripts and styles,
 * never inline ones.
 */

export const CSS = `
:root {
  color-scheme: dark;
  --bg: #0e1014; --panel: #161a21; --panel-2: #1c212a; --line: #262c37;
  --text: #e6e8ec; --muted: #8a93a3; --accent: #2ec5d3; --accent-2: #1a8f99;
  --ok: #2ecc71; --warn: #f1b33c; --bad: #ef5b5b;
  --radius: 10px;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
body { display: flex; min-height: 100vh; }
.sidebar { width: 220px; flex: none; background: #0b0d11; border-right: 1px solid var(--line);
  display: flex; flex-direction: column; padding: 18px 12px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); font-weight: 700;
  font-size: 16px; padding: 4px 8px 18px; }
.brand:hover { text-decoration: none; }
.logo { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px;
  background: linear-gradient(135deg, var(--accent), #6a5cff); color: #06121a; font-size: 12px; }
nav { display: flex; flex-direction: column; gap: 2px; }
nav a { color: var(--muted); padding: 9px 12px; border-radius: 8px; }
nav a:hover { background: var(--panel); color: var(--text); text-decoration: none; }
nav a.active { background: rgba(46, 197, 211, .12); color: var(--accent); font-weight: 600; }
.who { margin-top: auto; color: var(--muted); font-size: 12px; padding: 8px 12px;
  border-top: 1px solid var(--line); }
main { flex: 1; min-width: 0; padding: 22px 28px 48px; }
.top h1 { margin: 0 0 18px; font-size: 24px; }
h2 { font-size: 16px; margin: 26px 0 10px; }
.notice { background: rgba(46, 197, 211, .12); border: 1px solid var(--accent-2); color: var(--text);
  padding: 10px 14px; border-radius: var(--radius); margin-bottom: 16px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
.card .label { color: var(--muted); font-size: 13px; }
.card .value { font-size: 30px; font-weight: 700; margin-top: 6px; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; margin-top: 14px; }
.chart { display: flex; align-items: flex-end; gap: 14px; height: 200px; padding: 10px 4px 0; }
.chart .day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; }
.chart .bars { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; gap: 4px; }
.chart .bar { width: 38%; max-width: 26px; border-radius: 4px 4px 0 0; min-height: 2px; }
.chart .sent { background: var(--accent); }
.chart .received { background: #2b5f66; }
.chart .day span { color: var(--muted); font-size: 12px; }
.legend { display: flex; gap: 16px; color: var(--muted); font-size: 12px; margin-top: 10px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
tr:hover td { background: var(--panel-2); }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.ok { background: rgba(46, 204, 113, .14); color: var(--ok); }
.badge.warn { background: rgba(241, 179, 60, .14); color: var(--warn); }
.badge.bad { background: rgba(239, 91, 91, .14); color: var(--bad); }
.badge.muted { background: var(--panel-2); color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
form.inline { display: inline; }
button, .button, select, input { font: inherit; border-radius: 8px; border: 1px solid var(--line);
  background: var(--panel-2); color: var(--text); padding: 7px 12px; }
button, .button { cursor: pointer; }
button:hover, .button:hover { border-color: var(--accent); text-decoration: none; }
button.primary { background: var(--accent); color: #05161a; border-color: var(--accent); font-weight: 600; }
button.danger { border-color: rgba(239, 91, 91, .5); color: var(--bad); }
input { min-width: 220px; }
.stack { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
.qr { display: grid; place-items: center; background: #fff; border-radius: var(--radius);
  width: 300px; height: 300px; margin: 8px 0; }
.qr img { width: 280px; height: 280px; }
.qr .empty { color: #555; padding: 20px; text-align: center; }
.secret { background: #0b0d11; border: 1px dashed var(--accent); border-radius: 8px; padding: 12px;
  word-break: break-all; font-family: ui-monospace, Consolas, monospace; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 900px) {
  body { flex-direction: column; }
  .sidebar { width: auto; height: auto; position: static; flex-direction: row; align-items: center; gap: 12px; }
  nav { flex-direction: row; flex-wrap: wrap; }
  .who { display: none; }
  .grid-2 { grid-template-columns: 1fr; }
  main { padding: 16px; }
}
`;

export const JS = `
"use strict";
// Destructive buttons ask first.
document.addEventListener("submit", (event) => {
  const form = event.target;
  const message = form instanceof HTMLFormElement ? form.dataset.confirm : undefined;
  if (message && !window.confirm(message)) event.preventDefault();
});

// "Copiar" buttons copy the text of their target.
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-copy]") : null;
  if (!button) return;
  const target = document.getElementById(button.getAttribute("data-copy") || "");
  if (target && navigator.clipboard) {
    navigator.clipboard.writeText(target.textContent.trim()).then(() => { button.textContent = "Copiado"; });
  }
});

// Connection page: refresh the QR and status every few seconds.
const box = document.querySelector("[data-qr-url]");
if (box) {
  const statusEl = document.querySelector("[data-qr-status]");
  const refresh = async () => {
    try {
      const response = await fetch(box.getAttribute("data-qr-url"), { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const data = await response.json();
      if (statusEl) statusEl.textContent = data.statusLabel;
      box.replaceChildren();
      if (data.qrImage) {
        const img = document.createElement("img");
        img.src = data.qrImage;
        img.alt = "QR code";
        box.appendChild(img);
      } else {
        const p = document.createElement("div");
        p.className = "empty";
        p.textContent = data.message;
        box.appendChild(p);
      }
      if (data.status === "connected") window.clearInterval(timer);
    } catch {}
  };
  const timer = window.setInterval(refresh, 4000);
  refresh();
}
`;
