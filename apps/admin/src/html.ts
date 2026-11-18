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

const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  connection: '<path d="M8 12h8M12 8v8"/><rect x="3" y="3" width="18" height="18" rx="5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  webhook: '<path d="M10 4a4 4 0 1 0-4 7m12-1a4 4 0 1 1-4 7M6 16a4 4 0 1 0 4 4M6 7l6 10m6-3H6m9-8-3 11"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  inbox: '<path d="M4 4h16l2 10v6H2v-6L4 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/>',
  shield: '<path d="M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7Z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  alert: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;
export function icon(name: IconName): Html {
  return html`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICON_PATHS[name])}</svg>`;
}

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
  active: "dashboard" | "monitoring" | "messages" | "connections" | "clients" | "webhooks" | "search";
  user: string | null;
  notice?: string | null;
  body: Html;
  /** Alerts of the last 24 h for the bell; null when they could not be read. */
  alerts?: PageAlert[] | null;
  /** The term in the top search box (search page only). */
  search?: string;
}

export interface PageAlert {
  tone: "warn" | "bad";
  text: string;
  href: string;
}

/** The bell in the top bar: a count, and the list in a dropdown (no script needed). */
function alertsMenu(alerts: PageAlert[] | null | undefined): Html {
  if (alerts === undefined) return html``;
  const worst = alerts?.some((a) => a.tone === "bad") ? "bad" : alerts?.length ? "warn" : "ok";
  const label = alerts === null ? "Alertas indisponíveis"
    : alerts.length === 0 ? "Nenhum alerta" : `${alerts.length} ${alerts.length === 1 ? "alerta" : "alertas"}`;
  return html`<details class="alerts-menu" data-dropdown>
    <summary aria-label="${label}" title="${label}">${icon("bell")}${alerts?.length ? html`<span class="alerts-count ${worst}">${alerts.length > 9 ? "9+" : alerts.length}</span>` : ""}</summary>
    <div class="alerts-panel" role="region" aria-label="Alertas">
      <div class="alerts-head"><strong>Alertas</strong><span>últimas 24 h</span></div>
      ${alerts === null ? html`<p class="alerts-empty">Não foi possível ler os alertas agora.</p>`
        : alerts.length === 0 ? html`<p class="alerts-empty">${icon("check")} Nada para revisar.</p>`
        : html`<ul>${alerts.map((a) => html`<li><a class="${a.tone}" href="${a.href}">${icon("alert")}<span>${a.text}</span></a></li>`)}</ul>`}
      <a class="alerts-foot" href="/admin/monitoring">Abrir monitoramento ${icon("arrow")}</a>
    </div>
  </details>`;
}

const NAV: Array<[PageOptions["active"], string, string, IconName]> = [
  ["dashboard", "/admin", "Visão geral", "grid"],
  ["monitoring", "/admin/monitoring", "Monitoramento", "activity"],
  ["messages", "/admin/messages", "Mensagens", "message"],
  ["connections", "/admin/connections", "Conexões", "connection"],
  ["clients", "/admin/clients", "Clientes", "users"],
  ["webhooks", "/admin/webhooks", "Webhooks", "webhook"],
];

export function page(options: PageOptions): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${options.title} · On Connect Admin</title>
<link rel="icon" type="image/svg+xml" href="/admin/assets/favicon.svg">
<link rel="icon" type="image/png" href="/admin/assets/icon.png">
<link rel="apple-touch-icon" href="/admin/assets/icon.png">
<link rel="stylesheet" href="/admin/assets/admin.css">
<script src="/admin/assets/admin.js" defer></script>
</head>
<body>
<a class="skip-link" href="#main-content">Ir para o conteúdo</a>
<aside class="sidebar">
  <a class="brand" href="/admin" aria-label="On Connect API · Console"><img class="brand-logo" src="/admin/assets/logo.png" alt="On Connect API" width="1388" height="331"><small>CONSOLE</small></a>
  <div class="nav-caption">PLATAFORMA</div>
  <nav aria-label="Navegação principal">
    ${NAV.map(([key, href, label, symbol]) =>
      html`<a href="${href}" class="${key === options.active ? "active" : ""}" ${key === options.active ? html`aria-current="page"` : ""}>${icon(symbol)}<span>${label}</span>${key === options.active ? html`<i class="nav-indicator"></i>` : ""}</a>`)}
  </nav>
  <div class="sidebar-bottom"><div class="protected">${icon("shield")} Acesso protegido</div>
  <div class="who"><span class="avatar">${(options.user ?? "A").slice(0, 1).toUpperCase()}</span><div><strong>${options.user ?? "Administrador"}</strong><small>Super admin</small></div></div></div>
</aside>
<main id="main-content">
  <header class="top"><div class="breadcrumb">Console <span>/</span> ${options.active === "dashboard" ? "Visão geral" : options.title}</div>
    <form class="top-search" role="search" method="get" action="/admin/search"><label class="search-input">${icon("search")}<span class="sr-only">Buscar no painel</span><input name="q" value="${options.search ?? ""}" maxlength="100" placeholder="Buscar…" data-global-search autocomplete="off"></label><kbd>Ctrl K</kbd></form>
    <div class="top-actions">${alertsMenu(options.alerts)}<span class="console-badge">${icon("shield")} Super admin</span></div></header>
  <div class="page-heading"><div><p class="eyebrow">ON CONNECT</p><h1>${options.title}</h1></div><span class="updated-at">Atualizado em ${formatDate(new Date())}</span></div>
  ${options.notice ? html`<div class="notice">${options.notice}</div>` : ""}
  ${options.body}
</main>
</body>
</html>`.value;
}
