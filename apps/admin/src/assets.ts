/**
 * Static assets, kept as strings so the build has nothing to copy. Served
 * from /admin/assets/*: the CSP allows only same-origin scripts and styles,
 * never inline ones.
 */

export const CSS = `
:root {
  color-scheme: dark;
  --bg: #101214;
  --panel: #191c20;
  --panel-2: #20242a;
  --line: #2a2e35;
  --text: #f1f3f5;
  --muted: #9ba2ae;
  --accent: #49d6c5;
  --accent-2: #238e83;
  --ok: #59d99d;
  --warn: #e8b96a;
  --bad: #f08085;
  --radius: 14px;
}
* {
  box-sizing: border-box;
}
html {
  scroll-behavior: smooth;
  scroll-padding-top: 20px;
}
html,
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font:
    14px/1.5 -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
body {
  display: flex;
  min-height: 100vh;
}
a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
button,
input,
select {
  font: inherit;
}
button,
a,
input,
select,
summary {
  outline-offset: 4px;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--accent);
}
.icon {
  width: 19px;
  height: 19px;
  flex-shrink: 0;
  vertical-align: middle;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.skip-link {
  position: fixed;
  top: -60px;
  left: 16px;
  z-index: 99;
  background: var(--accent);
  color: #071714;
  padding: 12px;
  border-radius: 8px;
}
.skip-link:focus {
  top: 12px;
}
.sidebar {
  width: 228px;
  flex: none;
  background: #141619;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 30px 16px 18px;
  position: sticky;
  top: 0;
  height: 100dvh;
}
.brand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  color: var(--text);
  padding: 0 10px 32px;
}
.brand:hover {
  text-decoration: none;
}
.brand-logo {
  display: block;
  width: 100%;
  max-width: 172px;
  height: auto;
}
.brand small {
  display: block;
  font-size: 9px;
  letter-spacing: 2.8px;
  color: var(--muted);
  font-weight: 500;
  padding-left: 2px;
}
.nav-caption {
  font-size: 9px;
  letter-spacing: 1.8px;
  color: #818895;
  font-weight: 600;
  padding: 0 14px 13px;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
nav a {
  color: var(--muted);
  padding: 11px 13px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid transparent;
  font-size: 13px;
}
nav a:hover {
  background: var(--panel-2);
  color: var(--text);
  text-decoration: none;
}
nav a.active {
  background: #49d6c510;
  color: var(--accent);
  border-color: #49d6c522;
  font-weight: 600;
}
.nav-indicator {
  margin-left: auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.sidebar-bottom {
  margin-top: auto;
}
.protected {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--muted);
  padding: 12px 11px;
}
.protected .icon {
  width: 14px;
  height: 14px;
  color: var(--ok);
}
.who {
  border-top: 1px solid var(--line);
  padding: 20px 9px 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.who small {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.avatar {
  display: grid;
  place-items: center;
  width: 33px;
  height: 33px;
  border-radius: 50%;
  color: #d8d1ff;
  background: #8c86f624;
  font-size: 12px;
  font-weight: 600;
}
main {
  flex: 1;
  min-width: 0;
  padding: 0 clamp(20px, 2.6vw, 44px) 40px;
}
.top {
  height: 73px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.breadcrumb {
  font-size: 12px;
  color: var(--muted);
}
.breadcrumb span {
  display: inline-block;
  color: #525a66;
  margin: 0 10px;
}
.console-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 10px;
  color: var(--muted);
  padding: 4px 8px;
}
.console-badge .icon {
  width: 12px;
  height: 12px;
}
.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 28px 0 25px;
}
.eyebrow {
  font-size: 9px;
  letter-spacing: 1.5px;
  font-weight: 600;
  color: var(--muted);
  margin: 0 0 5px;
}
.page-heading h1 {
  font-size: 27px;
  line-height: 1.2;
  letter-spacing: -1px;
  font-weight: 600;
  margin: 0;
}
.page-heading .eyebrow {
  color: var(--accent);
  font-size: 8px;
  letter-spacing: 2px;
  margin-bottom: 8px;
}
.updated-at {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  padding-bottom: 2px;
}
h2 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.3px;
  margin: 24px 0 10px;
}
.overview-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}
.overview-intro h2 {
  font-size: 17px;
  margin: 0 0 5px;
  letter-spacing: -0.3px;
}
.overview-intro p {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
  max-width: 600px;
}
.intro-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.notice {
  background: #49d6c510;
  border: 1px solid var(--accent-2);
  padding: 12px 16px;
  border-radius: 10px;
  margin-bottom: 18px;
  font-size: 12px;
}
button,
.button,
select,
input {
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text);
  padding: 9px 12px;
  min-height: 36px;
}
button,
.button {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}
.button .icon,
button .icon {
  width: 15px;
  height: 15px;
}
button:hover,
.button:hover {
  border-color: #57616e;
  text-decoration: none;
}
button.primary,
.button.primary {
  background: var(--accent);
  color: #082c26;
  border-color: var(--accent);
  font-weight: 600;
}
button.primary:hover,
.button.primary:hover {
  background: #77e4d6;
  border-color: #77e4d6;
}
button.danger {
  border-color: #f0808544;
  color: var(--bad);
}
.compact {
  min-height: 32px;
  padding: 6px 10px;
  font-size: 11px;
}
input {
  min-width: 0;
}
input::placeholder {
  color: #838c99;
}
input[type="hidden"] {
  display: none;
}
select {
  cursor: pointer;
  font-size: 11px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}
.toolbar input {
  min-width: 180px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 440px;
}
.stack label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
form.inline {
  display: inline;
}
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 15px;
  margin-bottom: 22px;
}
.metric-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 19px 20px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--text);
  box-shadow: 0 4px 14px #0000000b;
  transition:
    border-color 0.16s,
    transform 0.16s;
}
.metric-card:hover {
  border-color: #4b6262;
  transform: translateY(-2px);
  text-decoration: none;
}
.metric-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 17px;
}
.metric-top > .icon {
  color: #68727e;
  width: 15px;
  height: 15px;
}
.metric-icon {
  width: 34px;
  height: 34px;
  border: 1px solid #ffffff08;
  display: inline-grid;
  place-items: center;
  border-radius: 10px;
  flex: none;
}
.metric-icon .icon {
  width: 17px;
  height: 17px;
}
.teal {
  color: #65d9c6;
  background: #49d6c512;
}
.blue {
  color: #81b4f4;
  background: #81b4f412;
}
.violet {
  color: #aba2ff;
  background: #8c86f616;
}
.amber {
  color: #eac78c;
  background: #e8b96a10;
}
.metric-label {
  font-size: 11px;
  color: var(--muted);
}
.metric-value {
  font-size: 31px;
  font-weight: 600;
  letter-spacing: -1px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
}
.metric-description {
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 18px;
}
.card .label,
.card .sub {
  color: var(--muted);
  font-size: 12px;
}
.card .value {
  font-size: 28px;
  font-weight: 600;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 21px;
  margin-top: 16px;
  min-width: 0;
  overflow: auto;
}
.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 18px;
  align-items: stretch;
}
.dashboard-grid .panel {
  margin: 0;
}
.dashboard-aside {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 15px;
  margin-bottom: 18px;
}
.section-heading h2 {
  margin: 0;
  font-size: 14px;
}
.section-heading > .icon {
  color: var(--muted);
  width: 17px;
}
.section-description {
  font-size: 10px;
  color: var(--muted);
  margin: 6px 0 0;
}
.period-form {
  display: flex;
  gap: 5px;
  align-items: center;
}
.period-form select {
  background: #16191d;
  min-height: 32px;
}
.period-form button {
  font-size: 10px;
}
.volume-panel {
  padding: 23px 23px 14px;
  display: flex;
  flex-direction: column;
}
.volume-panel .section-heading {
  margin-bottom: 24px;
}
.chart-legend {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.chart-legend button {
  display: flex;
  align-items: center;
  gap: 7px;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 10px;
  min-height: 28px;
  color: var(--muted);
}
.chart-legend strong {
  font-size: 11px;
  color: var(--text);
  font-weight: 500;
  margin-left: 3px;
}
.chart-legend button[aria-pressed="false"] {
  opacity: 0.4;
}
.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.legend-dot.sent {
  background: #49d6c5;
}
.legend-dot.received {
  background: #8c86f6;
}
.volume-chart {
  width: 100%;
  height: auto;
  flex: none;
  overflow: visible;
  margin: auto 0;
}
.chart-grid {
  stroke: #343943;
  stroke-dasharray: 3 6;
  stroke-width: 0.7;
}
.chart-tick {
  fill: #939cab;
  font-size: 10px;
  font-family: inherit;
}
.chart-line {
  fill: none;
  stroke-width: 2.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.chart-line.sent {
  stroke: #49d6c5;
}
.chart-line.received {
  stroke: #9c93f9;
}
.chart-point.sent {
  fill: #49d6c5;
}
.chart-point.received {
  fill: #9c93f9;
}
.chart-point {
  stroke: var(--panel);
  stroke-width: 1.5;
}
.chart-point:hover {
  r: 5;
}
.chart-footnote {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--muted);
  font-size: 9px;
  padding: 13px 0 0;
  margin-top: auto;
}
.chart-footnote .icon {
  width: 13px;
  height: 13px;
}
.chart-details {
  font-size: 10px;
  color: var(--muted);
  margin-top: 7px;
}
.chart-details summary {
  cursor: pointer;
  width: fit-content;
}
.chart-details table {
  margin: 12px 0;
}
.chart-details td {
  font-size: 11px;
}
.availability-panel .section-heading {
  margin-bottom: 9px;
}
.availability {
  display: flex;
  align-items: center;
  gap: 17px;
  margin: 3px 0 13px;
}
.availability-ring {
  width: 112px;
  height: 112px;
  flex: none;
}
.ring-track {
  fill: none;
  stroke: #30363c;
  stroke-width: 8;
}
.ring-value {
  fill: none;
  stroke: var(--accent);
  stroke-width: 8;
  transform: rotate(-90deg);
  transform-origin: 60px 60px;
  stroke-linecap: round;
}
.ring-number {
  fill: var(--text);
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -1px;
}
.ring-label {
  fill: var(--muted);
  font-size: 8px;
}
.availability-labels {
  flex: 1;
  min-width: 0;
  font-size: 10px;
}
.availability-labels > div {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0;
  color: var(--muted);
}
.availability-labels strong {
  margin-left: auto;
  color: var(--text);
  font-weight: 500;
}
.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.status-dot.inactive {
  background: #596271;
}
.availability-labels p {
  font-size: 9px;
  color: var(--muted);
  line-height: 1.5;
}
.text-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  font-size: 10px;
  color: var(--muted);
}
.text-link:hover {
  color: var(--accent);
  text-decoration: none;
}
.text-link .icon {
  width: 14px;
  height: 14px;
}
.webhook-summary .section-heading {
  margin-bottom: 5px;
}
.queue-number {
  font-size: 26px;
  letter-spacing: -0.8px;
  font-weight: 600;
  margin: 8px 0 15px;
}
.queue-number > span {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--muted);
  margin-left: 9px;
}
.delivery-status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 10px;
  color: var(--muted);
  margin: 10px 0;
}
.delivery-status strong {
  color: var(--text);
  font-weight: 500;
}
.delivery-status .warn-text {
  color: var(--warn);
}
.webhook-note {
  background: #49d6c509;
  border: 1px solid #49d6c519;
  border-radius: 7px;
  color: #9bd8c9;
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 9px;
  padding: 10px;
  margin-top: 17px;
  line-height: 1.6;
}
.webhook-note.attention {
  background: #e8b96a0b;
  border-color: #e8b96a24;
  color: var(--warn);
}
.webhook-note .icon {
  width: 13px;
  height: 13px;
}
.webhook-note .icon:last-child {
  margin-left: auto;
}
.webhook-note:hover {
  text-decoration: none;
  border-color: var(--accent-2);
}
.recent-connections {
  margin-top: 21px;
  padding-bottom: 3px;
}
.recent-connections .section-heading {
  margin-bottom: 22px;
}
.table-wrap {
  position: relative;
  overflow-x: auto;
  max-width: 100%;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  padding: 13px 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
th {
  color: var(--muted);
  font-weight: 500;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  white-space: nowrap;
}
td {
  font-size: 12px;
}
tr:last-child td {
  border-bottom: 0;
}
tr:hover td {
  background: #ffffff02;
}
.connections-table th:first-child,
.connections-table td:first-child {
  padding-left: 0;
}
.connections-table th:last-child,
.connections-table td:last-child {
  padding-right: 0;
}
.session-link {
  display: flex;
  align-items: center;
  gap: 11px;
  color: var(--text);
  min-width: 200px;
}
.session-link:hover {
  text-decoration: none;
}
.session-link:hover strong {
  color: var(--accent);
}
.session-avatar {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #242c31;
  color: #87c7be;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.session-avatar .icon {
  width: 17px;
  height: 17px;
}
.session-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.session-info strong {
  font-size: 11px;
  font-weight: 500;
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-info small {
  font-size: 9px;
  color: var(--muted);
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.client-label {
  color: var(--muted);
  border: 1px solid #38414a;
  background: #ffffff02;
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 10px;
}
.table-date {
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.icon-button {
  display: inline-grid;
  place-items: center;
  border-radius: 7px;
  padding: 6px;
  color: var(--muted);
  border: 1px solid transparent;
}
.icon-button:hover {
  background: var(--panel-2);
  color: var(--text);
  border-color: var(--line);
}
.icon-button .icon {
  width: 15px;
  height: 15px;
}
.status-reason {
  font-size: 9px;
  margin: 4px 0;
  color: var(--muted);
  max-width: 180px;
  overflow-wrap: anywhere;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border-radius: 5px;
  font-size: 9px;
  font-weight: 500;
  white-space: nowrap;
}
.badge::before {
  content: "";
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
.badge.ok {
  background: #59d99d11;
  color: var(--ok);
}
.badge.warn {
  background: #e8b96a11;
  color: var(--warn);
}
.badge.bad {
  background: #f0808511;
  color: var(--bad);
}
.badge.muted {
  background: var(--panel-2);
  color: var(--muted);
}
.quick-links {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  margin-top: 18px;
}
.quick-links > a {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--muted);
  font-size: 11px;
}
.quick-links > a:hover {
  border-color: #47635d;
  text-decoration: none;
}
.quick-links strong {
  font-size: 11px;
  color: var(--text);
  font-weight: 500;
  display: block;
}
.quick-links small {
  font-size: 10px;
  display: block;
  margin-top: 3px;
}
.quick-links .icon:last-child {
  margin-left: auto;
  width: 15px;
}
.connection-tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.connection-tabs a {
  border: 1px solid transparent;
  padding: 7px 12px;
  border-radius: 7px;
  font-size: 11px;
  color: var(--muted);
}
.connection-tabs a:hover {
  text-decoration: none;
  background: var(--panel-2);
}
.connection-tabs a.selected {
  border-color: #49d6c533;
  background: #49d6c50c;
  color: var(--accent);
}
.connections-panel {
  margin-top: 0;
}
.connection-search {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.search-input {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #13171b;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 12px;
  flex: 1;
  min-width: 200px;
  color: var(--muted);
}
.search-input:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.search-input .icon {
  width: 16px;
}
.search-input input {
  border: 0;
  background: transparent;
  width: 100%;
  font-size: 11px;
  padding: 10px 0;
}
.search-input input:focus {
  outline: 0;
}
.client-filter input {
  width: 170px;
  font-size: 11px;
  height: 100%;
  background: #13171b;
}
.list-summary {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--muted);
  font-size: 10px;
  margin: 22px 0 12px;
}
.list-summary > span:last-child {
  font-size: 9px;
  color: #78828f;
}
.empty-state {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 35px 15px;
  color: var(--muted);
  font-size: 11px;
}
.empty-state > .icon {
  color: var(--accent);
  width: 24px;
  height: 24px;
  margin-bottom: 4px;
}
.empty-state strong {
  font-weight: 500;
  color: var(--text);
}
.empty-state span {
  font-size: 10px;
}
.muted {
  color: var(--muted);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.qr {
  display: grid;
  place-items: center;
  background: #fff;
  border-radius: 12px;
  width: min(300px, 100%);
  aspect-ratio: 1;
  margin: 12px 0;
  overflow: hidden;
}
.qr img {
  width: 93%;
  height: 93%;
  object-fit: contain;
}
.qr .empty {
  color: #555;
  padding: 20px;
  text-align: center;
}
.secret {
  background: #111519;
  border: 1px dashed var(--accent);
  border-radius: 8px;
  padding: 14px;
  word-break: break-all;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
@media (min-width: 1700px) {
  .dashboard-grid {
    grid-template-columns: minmax(0, 1fr) 360px;
  }
  .volume-chart {
    min-height: 0;
  }
  .metric-card {
    padding: 22px;
  }
  .metric-value {
    font-size: 35px;
  }
  .session-info strong {
    max-width: 55ch;
  }
}
@media (max-width: 1180px) {
  .dashboard-grid {
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: 14px;
  }
  .sidebar {
    width: 200px;
    padding-left: 12px;
    padding-right: 12px;
  }
  main {
    padding-left: 23px;
    padding-right: 23px;
  }
  .overview-intro {
    align-items: flex-start;
    flex-direction: column;
    gap: 15px;
  }
  .metric-card {
    padding: 16px;
  }
  .volume-panel {
    padding: 18px 15px;
  }
  .volume-panel .section-heading {
    flex-wrap: wrap;
  }
  .availability {
    gap: 7px;
  }
  .availability-ring {
    width: 95px;
    height: 95px;
  }
  .dashboard-aside .panel {
    padding: 18px 15px;
  }
  .session-info strong {
    max-width: 25ch;
  }
}
@media (max-width: 960px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
  .dashboard-aside {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .metrics-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .grid-2 {
    grid-template-columns: 1fr;
  }
  .volume-chart {
    max-height: 260px;
    min-height: 0;
  }
  .sidebar {
    width: 184px;
  }
  .brand {
    padding-left: 5px;
    padding-right: 5px;
  }
  .brand small {
    font-size: 8px;
  }
  .metric-value {
    font-size: 29px;
  }
  .availability {
    justify-content: center;
    gap: 18px;
  }
  .availability-labels {
    max-width: 155px;
  }
  .page-heading {
    align-items: flex-start;
  }
  .updated-at {
    white-space: normal;
    text-align: right;
    max-width: 130px;
  }
}
@media (max-width: 680px) {
  body {
    display: block;
  }
  .sidebar {
    width: auto;
    height: auto;
    position: static;
    padding: 16px 17px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .brand {
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding: 0 0 17px;
  }
  .brand-logo {
    width: auto;
    height: 30px;
  }
  .brand small {
    font-size: 8px;
    letter-spacing: 2px;
  }
  .nav-caption,
  .sidebar-bottom {
    display: none;
  }
  nav {
    flex-direction: row;
    gap: 4px;
    justify-content: space-between;
  }
  nav a {
    font-size: 10px;
    padding: 8px 7px;
    gap: 6px;
  }
  nav .icon {
    width: 15px;
    height: 15px;
  }
  .nav-indicator {
    display: none;
  }
  main {
    padding: 0 17px 25px;
  }
  .top {
    height: 52px;
  }
  .breadcrumb {
    font-size: 10px;
  }
  .console-badge {
    font-size: 9px;
  }
  .page-heading {
    margin: 22px 0;
  }
  .page-heading h1 {
    font-size: 24px;
  }
  .updated-at {
    font-size: 9px;
  }
  .overview-intro h2 {
    font-size: 15px;
  }
  .overview-intro p {
    font-size: 11px;
  }
  .intro-actions {
    flex-wrap: wrap;
    width: 100%;
  }
  .intro-actions .button {
    flex: 1;
    font-size: 10px;
  }
  .metrics-grid {
    gap: 10px;
    margin-bottom: 15px;
  }
  .metric-card {
    padding: 14px;
  }
  .metric-top {
    margin-bottom: 12px;
  }
  .metric-label {
    font-size: 10px;
  }
  .metric-description {
    font-size: 9px;
  }
  .metric-icon {
    width: 29px;
    height: 29px;
  }
  .metric-icon .icon {
    width: 15px;
  }
  .metric-value {
    font-size: 27px;
  }
  .dashboard-aside {
    grid-template-columns: 1fr;
  }
  .availability {
    justify-content: flex-start;
    gap: 25px;
  }
  .availability-ring {
    width: 112px;
    height: 112px;
  }
  .availability-labels {
    max-width: none;
  }
  .volume-panel {
    padding: 18px 12px 12px;
  }
  .volume-panel .section-heading {
    padding: 0 5px;
    margin-bottom: 14px;
  }
  .volume-chart {
    min-height: 0;
    margin: 12px 0;
  }
  .chart-tick {
    font-size: 22px;
  }
  .chart-day[data-mobile-visible="false"] {
    display: none;
  }
  .chart-legend {
    padding: 0 5px;
  }
  .chart-footnote {
    font-size: 8px;
  }
  .panel {
    padding: 16px;
  }
  .recent-connections {
    padding: 18px 15px 4px;
  }
  .recent-connections .section-heading {
    gap: 8px;
  }
  .section-heading h2 {
    font-size: 13px;
  }
  .section-description {
    font-size: 9px;
  }
  .quick-links {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .connection-search .search-input {
    flex-basis: 100%;
  }
  .client-filter {
    flex: 1;
  }
  .client-filter input {
    width: 100%;
  }
  .connection-tabs {
    gap: 0;
  }
  .connection-tabs a {
    font-size: 10px;
    padding: 7px 9px;
  }
  .list-summary {
    flex-wrap: wrap;
  }
  .table-wrap th,
  .table-wrap td {
    padding-right: 16px;
  }
  .session-info strong {
    max-width: 29ch;
  }
  .stack {
    max-width: 100%;
  }
}
.pagination {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--line);
  margin-top: 15px;
  padding-top: 16px;
  font-size: 11px;
  color: var(--muted);
}
.delivery-table {
  max-height: 560px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.delivery-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel);
}
.delivery-table:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.pagination .button {
  font-size: 11px;
}
.pagination .disabled {
  opacity: .4;
  cursor: default;
}
.delivery-filters input {
  width: min(250px, 100%);
  font-size: 11px;
}
.delivery-filters label {
  min-width: 0;
}
.webhook-endpoints {
  min-width: 850px;
}
.delivery-table table {
  min-width: 850px;
}
.delivery-table td:first-child,
#deliveries .mono {
  white-space: nowrap;
  overflow-wrap: normal;
}
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
  * {
    transition: none !important;
  }
}
/* Página da conexão e do endpoint */
.connection-status-card { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 14px; }
.connection-status-card > div { display: flex; flex-direction: column; gap: 4px; }
.connection-status-card strong { font-size: 18px; }
table.kv th { width: 38%; color: var(--muted); font-weight: 500; text-transform: none; letter-spacing: 0; font-size: 13px; }
.action-row, .setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 13px 15px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 10px;
  background: var(--panel-2);
}
.action-row > div, .setting-row > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.action-row small, .setting-row small { color: var(--muted); font-size: 12px; }
.action-row.danger { border-color: #f0808555; background: #f080850d; }
.action-row.danger strong { color: var(--bad); }
.delete-form input { margin-top: 8px; max-width: 160px; min-width: 0; }
.danger-title { color: var(--bad); }
.setting-row { cursor: default; }
label.setting-row { cursor: pointer; }
.setting-row.sub { margin-left: 18px; }
.setting-row input[type="checkbox"], .setting-row input[type="radio"] { min-width: 0; width: 18px; height: 18px; accent-color: var(--accent); }
.dev-list { display: flex; flex-direction: column; gap: 10px; }
.dev-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
.dev-row > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dev-label { color: var(--muted); font-size: 12px; }
.dev-value { font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; }
.info-note { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 12px 14px;
  border: 1px solid #49d6c533; border-radius: 10px; background: #49d6c50a; color: var(--text); font-size: 13px; }
.info-note .icon { width: 17px; height: 17px; flex: none; color: var(--accent); margin-top: 1px; }
.event-list { list-style: none; padding: 0; margin: 12px 0 0; display: flex; flex-direction: column; gap: 8px; }
.event-list li { display: flex; gap: 10px; align-items: center; }
.event-list li > .icon { width: 16px; height: 16px; color: var(--ok); }
.event-list li span { display: flex; flex-direction: column; }
.events-form .button { margin-top: 6px; }
@media (max-width: 680px) {
  .action-row, .setting-row, .dev-row { flex-direction: column; align-items: stretch; }
  .setting-row.sub { margin-left: 0; }
}

/* Monitoramento */
.monitor-periods { margin-bottom: 16px; }
.live-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok);
  margin-right: 7px; vertical-align: 1px; box-shadow: 0 0 0 3px #59d99d22;
}
.monitor-alerts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.monitor-alert {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 10px;
  border: 1px solid var(--line); color: var(--text); margin-bottom: 0;
}
.monitor-alert > .icon { width: 17px; height: 17px; flex: none; }
.monitor-alert span { flex: 1; }
.monitor-alert b { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; white-space: nowrap; font-size: 12px; }
.monitor-alert b .icon { width: 13px; height: 13px; }
.monitor-alert:hover { text-decoration: none; filter: brightness(1.1); }
.monitor-alert.bad { background: #f0808512; border-color: #f0808555; }
.monitor-alert.bad > .icon, .monitor-alert.bad b { color: var(--bad); }
.monitor-alert.warn { background: #e8b96a10; border-color: #e8b96a4d; }
.monitor-alert.warn > .icon, .monitor-alert.warn b { color: var(--warn); }
.monitor-alert.ok { background: #59d99d0d; border-color: #59d99d40; margin-bottom: 16px; }
.monitor-alert.ok > .icon { color: var(--ok); }
.health-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 15px; margin-bottom: 18px; }
.health-card {
  display: flex; flex-direction: column; gap: 4px; padding: 17px 19px; min-width: 0;
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--line);
  border-radius: var(--radius); color: var(--text); transition: border-color .16s, transform .16s;
}
.health-card:hover { text-decoration: none; transform: translateY(-2px); }
.health-card.ok { border-left-color: var(--ok); }
.health-card.warn { border-left-color: var(--warn); }
.health-card.bad { border-left-color: var(--bad); }
.health-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
.health-name { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.health-name .icon { width: 15px; height: 15px; }
.health-state { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; white-space: nowrap; }
.health-state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.health-state.ok { color: var(--ok); }
.health-state.warn { color: var(--warn); }
.health-state.bad { color: var(--bad); }
.health-state.idle { color: var(--muted); }
.health-value { font-size: 29px; font-weight: 600; letter-spacing: -1px; font-variant-numeric: tabular-nums; }
.health-detail { color: var(--muted); font-size: 12px; }
.monitor-chart rect { opacity: .9; }
@media (max-width: 1180px) { .health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 680px) {
  .health-grid { grid-template-columns: 1fr; }
  .monitor-alert { flex-wrap: wrap; }
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

// Chart legends toggle actual series without changing the underlying data table.
document.querySelectorAll("[data-chart-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const series = button.getAttribute("data-chart-toggle");
    const enabled = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(enabled));
    document.querySelectorAll("[data-chart-line]").forEach((line) => {
      if (line.getAttribute("data-chart-line") === series) line.setAttribute("visibility", enabled ? "visible" : "hidden");
    });
  });
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

// Monitoring "live" view: reload the page every N seconds while it is visible.
const auto = document.querySelector("[data-autorefresh]");
if (auto) {
  const seconds = Math.max(10, Number(auto.getAttribute("data-autorefresh")) || 30);
  window.setInterval(() => {
    if (document.visibilityState === "visible") window.location.reload();
  }, seconds * 1000);
}
`;
