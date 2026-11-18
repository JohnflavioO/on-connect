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
  position: relative; isolation: isolate; overflow: hidden;
  background: radial-gradient(ellipse at 78% 44%, #164139 0%, transparent 58%),
    radial-gradient(ellipse at 12% 0%, #16332c 0%, transparent 56%), #101517;
}
.hero-band::before {
  content: ""; position: absolute; z-index: -1; inset: 0; pointer-events: none;
  background-image: radial-gradient(#86e1c65c 1px, transparent 1.5px),
    linear-gradient(90deg, #81dfc516 1px, transparent 1px),
    linear-gradient(#81dfc516 1px, transparent 1px);
  background-size: 32px 32px, 64px 64px, 64px 64px;
  background-position: -1px -1px, 0 0, 0 0;
  mask-image: radial-gradient(ellipse at 76% 47%, #000 14%, #0009 50%, transparent 83%);
}
.public-hero {
  display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: clamp(22px, 5vw, 68px); align-items: center; padding-block: clamp(54px, 7vw, 96px);
}
.hero-flow { min-width: 0; position: relative; }
.hero-route {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  position: relative; isolation: isolate; margin: 0 0 16px; padding: 0; list-style: none;
}
.hero-route::before {
  content: ""; position: absolute; z-index: -1; inset: 19px 16.7% auto;
  border-top: 1px dashed #71c7aa;
}
.hero-route li {
  display: grid; justify-items: center; gap: 6px; color: #c7ded6;
  font-size: 11px; font-weight: 650; text-align: center;
}
.hero-route li > span, .conversation-icon {
  display: grid; place-items: center; width: 38px; height: 38px;
  background: #142724; border: 1px solid #416e60; border-radius: 10px; color: #a0e9bd;
}
.hero-route li:nth-child(2) > span { border-color: #7dcba6; box-shadow: 0 0 24px #6feaab3d; }
.hero-route img { width: 17px; height: auto; }
.hero-conversation {
  position: relative; display: flex; align-items: center; gap: 12px; width: fit-content;
  max-width: 100%; margin: 14px 0 0 auto; padding: 10px 15px 10px 10px;
  border: 1px solid #34554c; border-radius: 14px 14px 4px 14px;
  background: #1a302a; box-shadow: 0 12px 30px #0003;
}
.hero-conversation::before {
  content: ""; position: absolute; border-left: 1px solid #71c7aa;
  height: 15px; bottom: 100%; right: 20px;
}
.conversation-icon { flex: none; width: 32px; height: 32px; }
.conversation-icon .icon { width: 16px; }
.hero-conversation div > span { font-size: 11px; color: #add1c4; }
.hero-conversation p { margin: 1px 0 0; color: #e5f2ed; font-size: 13px; }
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
.public-copy h1 { font-size: clamp(36px, 5.15vw, 70px); text-wrap: initial; }
.public-copy h1 em { display: block; color: #a0e9bd; }
.public-copy > p:not(.public-kicker) { max-width: 490px; }
.api-preview {
  margin: 0; min-width: 0; border: 1px solid #407364; border-radius: 18px;
  background: #111c20; box-shadow: 0 20px 55px #0006, 0 0 36px #76f3b118; overflow: hidden;
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
  margin: 0; padding: 18px clamp(13px, 2vw, 23px); overflow: auto;
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
.public-plan {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(290px, 470px);
  gap: 24px clamp(24px, 6vw, 80px); align-items: center;
}
.public-plan .section-intro h2 { font-size: clamp(29px, 4vw, 46px); }
.public-plan .section-intro p { max-width: 440px; font-size: 16px; }
.plan-docs { margin-top: 20px; }
.plan-card {
  border: 1px solid #416e60; border-radius: 20px; padding: clamp(20px, 4vw, 34px);
  background: radial-gradient(ellipse at top right, #2a5043, transparent 78%),
    radial-gradient(#79cfb12e 1px, transparent 1.5px) top right / 16px 16px, #182222;
  box-shadow: 0 16px 42px #0003;
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
.docs-layout {
  display: grid; grid-template-columns: minmax(155px, 210px) minmax(0, 780px);
  gap: clamp(24px, 6vw, 72px); padding-block: clamp(30px, 6vw, 76px);
}
.docs-nav {
  position: sticky; top: 24px; align-self: start; padding-inline-end: 14px;
  border-inline-end: 1px solid var(--line);
}
.docs-nav a { color: var(--muted); padding: 8px 10px; }
.docs-nav a:hover { color: var(--accent); background: var(--panel-2); }
.docs-article { min-width: 0; overflow-wrap: anywhere; }
.public-site .docs-article h1 { font-size: clamp(34px, 5vw, 58px); text-wrap: initial; }
.docs-lead { font-size: clamp(16px, 2vw, 19px); color: var(--muted); }
.docs-article section { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); scroll-margin-top: 20px; }
.docs-article h2 { margin: 0 0 8px; font-size: clamp(22px, 3vw, 30px); }
.docs-article p, .docs-article li { line-height: 1.65; }
.docs-article li + li { margin-top: 5px; }
.docs-article code { color: #a0e9bd; }
.docs-article pre {
  margin: 14px 0; padding: 16px; overflow: auto; border-radius: 10px;
  border: 1px solid #34514a; background: #131b20; line-height: 1.65; font-size: 13px;
}
.docs-article pre:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 760px) {
  .public-container, .public-site .login-layout { width: calc(100% - 32px); }
  .public-hero, .public-site .login-layout { grid-template-columns: minmax(0, 1fr); }
  .public-hero { padding-block: 42px; gap: 36px; }
  .hero-band::before { mask-image: radial-gradient(ellipse at 72% 72%, #000 5%, transparent 76%); }
  .public-site .login-layout { align-content: start; padding-block: 42px; }
  .login-info h1 br { display: none; }
  .login-icons { display: none; }
  .solution-layout { grid-template-columns: minmax(0, 1fr); }
  .solution-details { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .public-feature-grid, .public-steps, .public-plan { grid-template-columns: minmax(0, 1fr); }
  .public-header-nav { display: none; }
  .docs-layout { grid-template-columns: minmax(0, 1fr); }
  .docs-nav { position: static; flex-flow: row wrap; justify-content: flex-start; border: 0; padding-inline-end: 0; }
  .docs-nav a { font-size: 13px; }
}
`;
