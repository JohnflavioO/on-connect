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
.public-nav { display: flex; flex-flow: row wrap; align-items: center; gap: 10px 22px; }
.public-nav a { padding: 4px 0; color: var(--muted); font-weight: 600; }
.public-nav a:hover { color: var(--accent); }
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
.hero-band {
  background: radial-gradient(ellipse at 15% 0%, #163831 0%, transparent 65%),
    linear-gradient(125deg, #101214 55%, #161d25);
}
.public-hero {
  display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(0, 1fr);
  gap: clamp(28px, 6vw, 84px); align-items: center; padding-block: clamp(64px, 9vw, 124px);
}
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
.public-copy h1 { font-size: clamp(42px, 6vw, 77px); }
.public-copy h1 em { display: block; color: #a0e9bd; }
.public-copy > p:not(.public-kicker) { max-width: 490px; }
.api-preview {
  margin: 0; min-width: 0; border: 1px solid #407364; border-radius: 18px;
  background: #131b20; box-shadow: 0 22px 64px #0005; overflow: hidden;
}
.api-preview figcaption, .api-response {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 8px 14px; padding: 14px clamp(13px, 2vw, 23px);
}
.api-preview figcaption { background: #1b282a; border-bottom: 1px solid #34514a; }
.api-preview figcaption span { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; }
.api-preview figcaption .icon { width: 16px; color: var(--accent); }
.api-preview figcaption code, .api-response span { font-size: 12px; color: #b2c2c8; }
.api-preview pre {
  margin: 0; padding: 23px clamp(13px, 2vw, 23px); overflow: auto;
  font-size: clamp(11px, 1.2vw, 14px); line-height: 1.75; color: #e2ebed;
}
.api-preview pre:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.api-method, .api-string { color: #a0e9bd; }
.api-field { color: #a5d7f0; }
.api-response { border-top: 1px solid #34514a; }
.api-response code { color: #a0e9bd; font-size: 12px; }
.solution-band { background: #e8f2ed; color: #192d28; }
.solution-layout {
  display: grid; grid-template-columns: minmax(160px, .4fr) minmax(0, 1fr);
  gap: 24px 48px; padding-block: clamp(44px, 7vw, 88px);
}
.solution-layout h2 { margin: 0; color: #24594c; font-size: clamp(20px, 2.5vw, 28px); line-height: 1.2; }
.solution-lead {
  margin: 0; max-width: 850px; font-size: clamp(22px, 3vw, 36px);
  line-height: 1.3; letter-spacing: -.035em;
}
.solution-details {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px;
  margin: 28px 0 0; padding-top: 18px; border-top: 1px solid #b3c9bf;
}
.solution-details dt { font-size: 13px; color: #3d6359; }
.solution-details dd { margin: 3px 0 0; font-weight: 700; }
.closing-band {
  border-top: 1px solid #325147;
  background: linear-gradient(115deg, #203b32, #182a29 52%, #15212a);
}
.closing-content { padding-block: clamp(50px, 8vw, 100px); text-align: center; }
.closing-content h2 {
  margin: 0; color: #c0f3d4; font-size: clamp(34px, 6vw, 64px);
  letter-spacing: -.06em; line-height: 1.05; text-wrap: balance;
}
.closing-content p { max-width: 480px; margin: 17px auto 0; color: #c5d6d1; font-size: 16px; }
.closing-content .public-actions { justify-content: center; }
.public-features { padding-block: 38px 64px; border-top: 1px solid var(--line); }
.public-features h2, .section-intro h2, .login-card h2 { margin: 0 0 23px; font-size: clamp(23px, 3vw, 33px); letter-spacing: -.035em; line-height: 1.15; }
.public-feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.public-feature { padding: 21px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
.public-symbol {
  display: inline-grid; place-items: center; width: 39px; height: 39px;
  border-radius: 10px; color: var(--accent); background: #203531; border: 1px solid #36514c;
}
.public-feature h3 { margin: 13px 0 4px; font-size: 18px; }
.public-feature p, .login-card p { margin: 0; color: #aab4bd; line-height: 1.55; }
.public-footer { border-block-start: 1px solid var(--line); border-block-end: 0; }
.public-setup, .public-plan { padding-block: clamp(35px, 6vw, 68px); border-block-start: 1px solid var(--line); }
.section-intro { max-width: 500px; }
.section-intro h2 { margin-bottom: 12px; }
.section-intro p, .public-steps p, .footer-brand p { margin: 0; color: #aab4bd; line-height: 1.6; }
.public-steps {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 30px;
  margin: 26px 0 0; padding-inline-start: 28px;
}
.public-steps li { padding-inline-start: 4px; }
.public-steps li::marker { color: var(--accent); font-weight: 700; }
.public-steps h3 { margin: 0 0 6px; font-size: 17px; }
.public-plan { display: grid; grid-template-columns: 1fr minmax(290px, 430px); gap: 24px 40px; align-items: center; }
.plan-card {
  border: 1px solid #36514c; border-radius: 18px; padding: clamp(20px, 4vw, 34px);
  background: radial-gradient(ellipse at top right, #213a35, transparent 80%), var(--panel);
}
.plan-price { margin: 0; font-size: clamp(37px, 7vw, 60px); line-height: 1; letter-spacing: -.06em; font-weight: 730; }
.plan-price span { color: var(--accent); font-size: .48em; letter-spacing: 0; }
.plan-card ul { list-style: none; margin: 22px 0 0; padding: 18px 0 0; border-top: 1px solid #36514c; }
.plan-card li { display: flex; align-items: start; gap: 9px; padding-block: 5px; }
.plan-card .icon { color: var(--accent); }
.footer-content {
  display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap;
  gap: 20px 34px; padding-block: 28px;
}
.footer-brand .brand { padding: 0; }
.footer-brand .brand-logo { width: 136px; height: auto; }
.footer-brand p { margin-top: 10px; max-width: 360px; }
.footer-meta { border-top: 1px solid var(--line); padding-block: 12px 20px; color: var(--muted); font-size: 12px; }
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
  .solution-layout { grid-template-columns: minmax(0, 1fr); }
  .solution-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .public-feature-grid, .public-steps, .public-plan { grid-template-columns: minmax(0, 1fr); }
  .public-header-nav { display: none; }
}
`;
