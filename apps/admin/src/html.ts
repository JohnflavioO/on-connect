/**
 * Minimal HTML templating: every interpolated value is escaped unless it is
 * already markup produced by `html` (or explicitly `raw`). Values from the
 * database (names, URLs, error texts) therefore can never inject markup.
 */

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

type Value = Html | string | number | boolean | null | undefined | Date | readonly Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map((item: Value) => render(item)).join("");
  if (value instanceof Date) return escapeHtml(formatDate(value));
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** Markup that is trusted because it is a constant of this code base. */
export const raw = (value: string): Html => new Html(value);

const dateFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: Date | null | undefined): string {
  return value ? dateFormat.format(value) : "—";
}

export function formatNumber(value: number | string): string {
  return new Intl.NumberFormat("pt-BR").format(Number(value));
}

/** "+55 (85) 99913-2494" for Brazilian numbers, "+<digits>" otherwise. */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "—";
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${digits}`;
}

/**
 * Shows where a webhook goes without the path, which may carry the
 * integrator's secret (D-API style URLs): only scheme and host.
 */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "(URL inválida)";
  }
}

const STATUS_LABELS: Record<string, [string, string]> = {
  connected: ["Conectado", "ok"],
  connecting: ["Conectando", "warn"],
  pending: ["Pendente", "warn"],
  disconnected: ["Desconectado", "bad"],
  error: ["Erro", "bad"],
  active: ["Ativo", "ok"],
  paused: ["Pausado", "warn"],
  disabled: ["Desativado", "bad"],
  suspended: ["Suspenso", "bad"],
  canceled: ["Cancelado", "bad"],
  delivered: ["Entregue", "ok"],
  failed: ["Falhou", "warn"],
  dead: ["Desistiu", "bad"],
  revoked: ["Revogada", "bad"],
};

export function badge(status: string): Html {
  const [label, tone] = STATUS_LABELS[status] ?? [status, "muted"];
  return html`<span class="badge ${tone}">${label}</span>`;
}

export interface PageOptions {
  title: string;
  active: "dashboard" | "connections" | "clients" | "webhooks";
  user: string | null;
  notice?: string | null;
  body: Html;
}

const NAV: Array<[PageOptions["active"], string, string]> = [
  ["dashboard", "/admin", "Dashboard"],
  ["connections", "/admin/connections", "Conexões"],
  ["clients", "/admin/clients", "Clientes"],
  ["webhooks", "/admin/webhooks", "Webhooks"],
];

export function page(options: PageOptions): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${options.title} · On Connect Admin</title>
<link rel="stylesheet" href="/admin/assets/admin.css">
<script src="/admin/assets/admin.js" defer></script>
</head>
<body>
<aside class="sidebar">
  <a class="brand" href="/admin"><span class="logo">OC</span> On Connect</a>
  <nav>
    ${NAV.map(([key, href, label]) =>
      html`<a href="${href}" class="${key === options.active ? "active" : ""}">${label}</a>`)}
  </nav>
  <div class="who">Super admin${options.user ? html`<br><strong>${options.user}</strong>` : ""}</div>
</aside>
<main>
  <header class="top"><h1>${options.title}</h1></header>
  ${options.notice ? html`<div class="notice">${options.notice}</div>` : ""}
  ${options.body}
</main>
</body>
</html>`.value;
}
