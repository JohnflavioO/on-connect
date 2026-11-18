export const PUBLIC_CSS = `
.public-site {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  background: #101214;
}
.public-container { width: min(1160px, calc(100% - 64px)); margin-inline: auto; }
.public-header, .public-footer { border-block-end: 1px solid var(--line); }
.public-bar { min-height: 77px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.public-bar .brand { flex-direction: column; padding: 0; align-items: flex-start; gap: 4px; }
.public-bar .brand-logo { width: clamp(120px, 18vw, 158px); height: auto; }
.public-bar .brand small { margin-inline-start: 0; }
.public-site .public-main { width: 100%; max-width: none; padding: 0; flex: 1; min-width: 0; }
.public-bar a, .public-actions a, .public-primary { text-decoration: none; }
.public-secondary, .public-primary {
  align-items: center; display: inline-flex; justify-content: center; gap: 10px;
  border: 1px solid var(--line); border-radius: 9px; min-height: 42px;
  padding: 8px 14px; color: var(--text); font-weight: 650;
}
.public-secondary:hover { background: var(--panel-2); border-color: var(--accent-2); }
.public-primary {
  min-height: 48px; padding: 10px 17px; border-color: transparent;
  background: var(--accent); color: #0c2420; cursor: pointer;
}
.public-primary:hover { background: #76e7da; }
.public-primary .icon, .public-secondary .icon { width: 16px; height: 16px; }
.public-hero { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(24px, 5vw, 72px); align-items: center; padding-block: clamp(54px, 8vw, 112px); }
.public-kicker {
  margin: 0 0 16px; color: var(--accent); font-weight: 700;
  letter-spacing: .13em; text-transform: uppercase; font-size: 11px;
}
.public-site h1 {
  margin: 0; font-size: clamp(41px, 6vw, 78px); font-weight: 730;
  line-height: 1.02; letter-spacing: -.066em; text-wrap: balance;
}
.public-site h1 em { color: var(--accent); font-style: normal; }
.public-copy > p:not(.public-kicker), .login-info > p:not(.public-kicker) {
  max-width: 420px; margin: 22px 0 0; color: #abb4be; font-size: clamp(16px, 2vw, 19px); line-height: 1.55;
}
.public-actions { display: flex; flex-wrap: wrap; gap: 15px 22px; align-items: center; margin-top: 30px; }
.public-feature-link { color: #b7c2cb; font-weight: 650; }
.public-feature-link:hover { color: var(--accent); }
.public-diagram {
  border: 1px solid #2b3c3b; border-radius: 24px; min-width: 0; min-height: 335px;
  padding: clamp(14px, 3vw, 36px); display: grid; align-content: center; justify-items: center;
  background: radial-gradient(ellipse at 50% 46%, #173632d9, transparent 72%),
    radial-gradient(#6c94864a 1px, transparent 1px), #121b1e;
  background-size: auto, 18px 18px, auto;
}
.diagram-row { width: 100%; display: grid; align-items: center; grid-template-columns: 1fr minmax(10px, .3fr) 1.1fr minmax(10px, .3fr) 1fr; }
.diagram-node {
  min-width: 0; min-height: 86px; display: flex; flex-direction: column; justify-content: center;
  align-items: center; gap: 8px; padding: 8px 4px; color: #d0dcd9; font-size: clamp(10px, 1.25vw, 14px);
  font-weight: 650; text-align: center; background: #172225; border: 1px solid #36514c; border-radius: 13px;
}
.diagram-node > .icon { color: var(--accent); }
.diagram-mark { width: 29px; height: auto; }
.diagram-core { min-height: 108px; color: var(--text); background: #1d3533; border-color: #54867d; }
.diagram-line { height: 1px; background: #619e91; }
.diagram-event {
  position: relative; display: flex; align-items: center; gap: 8px; margin-top: 24px;
  border: 1px solid #36514c; border-radius: 100px; padding: 5px 12px;
  background: #172225; color: #bce0d8; font-size: 12px;
}
.diagram-event::before { content: ""; position: absolute; left: 50%; bottom: 100%; height: 25px; border-left: 1px dashed #619e91; }
.diagram-event .icon { width: 15px; height: 15px; }
.public-features { padding-block: 38px 64px; border-top: 1px solid var(--line); }
.public-features h2, .login-card h2 { margin: 0 0 23px; font-size: clamp(23px, 3vw, 33px); letter-spacing: -.035em; line-height: 1.15; }
.public-feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.public-feature { padding: 21px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.public-symbol {
  display: inline-grid; place-items: center; width: 39px; height: 39px;
  border-radius: 10px; color: var(--accent); background: #203531; border: 1px solid #36514c;
}
.public-feature h3 { margin: 13px 0 4px; font-size: 18px; }
.public-feature p, .login-card p { margin: 0; color: #aab4bd; line-height: 1.55; }
.public-footer { border-block-start: 1px solid var(--line); border-block-end: 0; }
.public-footer .public-bar { min-height: 70px; }
.public-site .login-layout {
  display: grid; grid-template-columns: 1fr minmax(320px, 440px);
  align-items: center; gap: clamp(24px, 7vw, 120px);
  width: min(1040px, calc(100% - 64px)); padding-block: 64px;
}
.login-info h1 { color: var(--text); }
.login-icons { display: flex; gap: 10px; margin-top: 25px; }
.login-card { padding: clamp(24px, 4vw, 42px); border: 1px solid #34443f; border-radius: 21px; background: #191e21; }
.login-card h2 { margin: 15px 0 7px; }
.login-card form { display: grid; margin-top: 25px; }
.login-card label { margin-bottom: 7px; font-weight: 650; }
.login-card input {
  width: 100%; min-width: 0; min-height: 46px; margin: 0 0 16px;
  padding: 9px 12px; border: 1px solid #434d52; border-radius: 8px;
  background: #121719; color: var(--text); font-size: 16px;
}
.login-card .public-primary { margin-top: 7px; justify-content: space-between; }
.login-card .login-error {
  margin-top: 16px; padding: 9px 12px; color: #ffb7b8; background: #382225; border-radius: 8px;
}
@media (max-width: 760px) {
  .public-container, .public-site .login-layout { width: calc(100% - 32px); }
  .public-hero, .public-site .login-layout { grid-template-columns: minmax(0, 1fr); }
  .public-hero { padding-block: 43px; }
  .public-site .login-layout { align-content: start; padding-block: 42px; }
  .login-info h1 br { display: none; }
  .login-icons { display: none; }
  .public-diagram { min-height: 245px; }
  .public-feature-grid { grid-template-columns: minmax(0, 1fr); }
}
`;
