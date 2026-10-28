export type ConsentPageInput = {
  requestId: string;
  path: string;
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
  status: 'login' | 'consent' | 'error' | 'complete';
  clientName: string;
  redirectUri: string;
  organization: string;
  managerName?: string;
  csrfToken?: string;
  loginUrl?: string;
  errorCode?: string;
  completionUrl?: string;
};

const requestPrefix = '/api/integrations/grok-bot/oauth/requests/';
const stylesheet = '/api/integrations/grok-bot/oauth/consent.css';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function completionLink(value: string | undefined): string | undefined {
  if (!value || /[#\s\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    if (value.startsWith('https://') && url.protocol === 'https:') return url.toString();
    // The route has already checked its administrator-approved exact callback
    // allowlist. Keep the native scheme exception limited to this one literal base.
    if (value.split('?')[0] === 'cursor://anysphere.cursor-mcp/oauth/callback') return url.toString();
    // Match the original authority before URL normalization: 127.1, integer/hex
    // IPv4, localhost., mapped IPv6 and encoded hostname aliases are not loopback
    // callback literals. Require an explicit canonical port and explicit path.
    const loopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/[^?#]*)(?:\?[^#]*)?$/.exec(value);
    if (loopback && url.protocol === 'http:' && (url.port === loopback[2] || (loopback[2] === '80' && url.port === '')) && url.pathname === loopback[3]) return value;
    return undefined;
  } catch { return undefined; }
}

/** Pure rendering only. The route authenticates the manager and validates CSRF,
 * browser nonce, Origin, callback allowlist and the authorization request. */
export function renderConsentPage(input: ConsentPageInput): string {
  const language = input.language === 'en' ? 'en' : 'zh';
  const theme = input.theme === 'dark' ? 'dark' : 'light';
  const en = language === 'en';
  const validPath = /^[A-Za-z0-9_-]{43}$/.test(input.requestId) && input.path === requestPrefix + input.requestId;
  const path = validPath ? input.path : '/';
  const requestedStatus = ['login', 'consent', 'error', 'complete'].includes(input.status) ? input.status : 'error';
  const status = !validPath || (requestedStatus === 'consent' && !input.csrfToken) ? 'error' : requestedStatus;
  const text = en ? {
    pageTitle: 'Connection authorization', eyebrow: 'GROK BOT CONNECTION',
    loginTitle: 'Sign in to continue', consentTitle: 'Review this connection', errorTitle: 'Unable to continue', completeTitle: 'Authorization step complete',
    loginIntro: 'Sign in with a DingTalk manager account for this organization. Signing in does not approve access; you will review and choose next.',
    consentIntro: 'The connecting app supplies its client name; its identity has not been verified. Check the organization and exact callback address before authorizing this connection.',
    errorIntro: 'This authorization request could not be completed. Return to OneLaser Work OS and start a new connection request.',
    completeIntro: 'Return to Bot to finish this connection request.',
    app: 'Client name (identity unverified)', organization: 'Organization', manager: 'Signed in as', callback: 'Callback address', permissions: 'This connection can',
    readTitle: 'Read assigned evidence-review jobs', readDetail: 'Retrieve acceptance criteria and submitted evidence for an authorized job.',
    submitTitle: 'Submit evidence assessments', submitDetail: 'Return an assessment for an authorized job, subject to server validation.',
    boundaryTitle: 'Human review stays in control',
    boundary: 'Evidence assessment only. This connection cannot accept tasks, replace human review, or make pay or personnel decisions.',
    approve: 'Approve connection', deny: 'Deny', login: 'Sign in with DingTalk', home: 'Return to Work OS', returnToBot: 'Return to Bot',
    errorCode: 'Error code', footer: 'Authorization can be revoked.', skip: 'Skip to content', preferences: 'Language and appearance'
  } : {
    pageTitle: '连接授权', eyebrow: 'GROK BOT 连接',
    loginTitle: '登录以继续', consentTitle: '确认本次连接', errorTitle: '无法继续连接', completeTitle: '授权步骤已完成',
    loginIntro: '请使用此组织的钉钉负责人账号登录。登录不会自动授权；下一步仍需由你确认批准或拒绝。',
    consentIntro: '客户端名称由连接方提供，身份尚未核验。请核对组织和完整回调地址，再决定是否授权本次连接。',
    errorIntro: '此授权请求无法完成。请返回 OneLaser Work OS，重新发起连接请求。',
    completeIntro: '请返回 Bot，完成这次连接操作。',
    app: '客户端名称（身份未核验）', organization: '组织', manager: '当前登录', callback: '回调地址', permissions: '本次连接可以',
    readTitle: '读取已分配的证据评估任务', readDetail: '获取已授权任务的验收标准与已提交证据。',
    submitTitle: '提交证据评估建议', submitDetail: '为已授权任务提交评估结果，由服务端核验。',
    boundaryTitle: '保留人工复核与决定',
    boundary: '仅提供证据评估建议。此连接不能验收任务、代替人工复核，也不能作出薪酬或人事决定。',
    approve: '批准连接', deny: '拒绝', login: '使用钉钉登录', home: '返回工作台', returnToBot: '返回 Bot',
    errorCode: '错误代码', footer: '授权可以撤销。', skip: '跳到正文', preferences: '语言与外观'
  };
  const switchLink = (nextLanguage: 'zh' | 'en', nextTheme: 'light' | 'dark') => escapeHtml(`${path}?lang=${nextLanguage}&theme=${nextTheme}`);
  const title = status === 'login' ? text.loginTitle : status === 'consent' ? text.consentTitle : status === 'complete' ? text.completeTitle : text.errorTitle;
  const intro = status === 'login' ? text.loginIntro : status === 'consent' ? text.consentIntro : status === 'complete' ? text.completeIntro : text.errorIntro;
  const facts = `<dl class="connection-facts">
    <div><dt>${text.app}</dt><dd dir="auto">${escapeHtml(input.clientName)}</dd></div>
    <div><dt>${text.organization}</dt><dd dir="auto">${escapeHtml(input.organization)}</dd></div>
    ${status === 'consent' && input.managerName ? `<div><dt>${text.manager}</dt><dd dir="auto">${escapeHtml(input.managerName)}</dd></div>` : ''}
    <div class="callback-fact"><dt>${text.callback}</dt><dd><code dir="auto">${escapeHtml(input.redirectUri)}</code></dd></div>
  </dl>`;
  const permissions = `<section class="permissions" aria-labelledby="permissions-heading">
    <h2 id="permissions-heading">${text.permissions}</h2>
    <ul><li><strong>${text.readTitle}</strong><p>${text.readDetail}</p><code>workos_get_review_job</code></li>
    <li><strong>${text.submitTitle}</strong><p>${text.submitDetail}</p><code>workos_submit_review</code></li></ul>
  </section>
  <aside class="boundary" aria-labelledby="boundary-heading"><h2 id="boundary-heading">${text.boundaryTitle}</h2><p>${text.boundary}</p></aside>`;
  let actions: string;
  if (status === 'consent') {
    actions = `<form method="post" action="${escapeHtml(path)}" class="decision-form">
      <input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken!)}">
      <input type="hidden" name="lang" value="${language}"><input type="hidden" name="theme" value="${theme}">
      <button class="button button-secondary" type="submit" name="decision" value="deny">${text.deny}</button>
      <button class="button button-primary" type="submit" name="decision" value="approve">${text.approve}</button>
    </form>`;
  } else if (status === 'login') {
    const expectedLogin = `/api/auth/dingtalk/start?oauth_request=${input.requestId}`;
    const login = input.loginUrl === expectedLogin ? input.loginUrl : '/';
    actions = `<div class="page-actions"><a class="button button-primary" href="${escapeHtml(login)}">${login === '/' ? text.home : text.login}</a></div>`;
  } else if (status === 'complete') {
    const callback = completionLink(input.completionUrl);
    actions = `<div class="page-actions"><a class="button button-primary" href="${escapeHtml(callback || '/')}" rel="noreferrer">${callback ? text.returnToBot : text.home}</a></div>`;
  } else {
    const code = !validPath ? 'INVALID_AUTH_REQUEST' : requestedStatus === 'consent' && !input.csrfToken ? 'CONSENT_UNAVAILABLE' : input.errorCode && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(input.errorCode) ? input.errorCode : 'OAUTH_REQUEST_FAILED';
    actions = `<p class="error-code">${text.errorCode}: <code>${escapeHtml(code)}</code></p><div class="page-actions"><a class="button button-secondary" href="/">${text.home}</a></div>`;
  }
  return `<!doctype html>
<html lang="${en ? 'en' : 'zh-CN'}" data-theme="${theme}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>${text.pageTitle} · OneLaser Work OS</title><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="${stylesheet}"></head>
<body><a class="skip-link" href="#consent-main">${text.skip}</a>
<div class="page-shell"><header class="page-header"><a class="brand" href="/">OneLaser <span>Work OS</span></a>
<nav class="preferences" aria-label="${text.preferences}"><div class="preference-group">
<a href="${switchLink('zh', theme)}" lang="zh-CN" aria-label="切换为中文 / Switch to Chinese"${language === 'zh' ? ' aria-current="page"' : ''}>中</a>
<a href="${switchLink('en', theme)}" lang="en" aria-label="切换为英文 / Switch to English"${language === 'en' ? ' aria-current="page"' : ''}>EN</a></div>
<div class="preference-group"><a href="${switchLink(language, 'light')}" aria-label="切换为浅色 / Switch to light theme"${theme === 'light' ? ' aria-current="page"' : ''}><span aria-hidden="true">☀</span></a>
<a href="${switchLink(language, 'dark')}" aria-label="切换为深色 / Switch to dark theme"${theme === 'dark' ? ' aria-current="page"' : ''}><span aria-hidden="true">☾</span></a></div></nav></header>
<main id="consent-main" tabindex="-1"><article class="consent-card"><p class="eyebrow">${text.eyebrow}</p><h1>${title}</h1><p class="introduction">${intro}</p>
${status === 'login' || status === 'consent' ? facts + permissions : ''}
${actions}</article><footer class="page-footer">OneLaser Work OS${status === 'consent' ? ` · ${text.footer}` : ''}</footer></main></div></body></html>`;
}

export const consentCss = `
:root{font-family:"Certia","PingFang SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.6;color-scheme:light;--page:#F5F5F7;--surface:#FFFFFF;--ink:#000000;--muted:#6B6B70;--line:#D2D2D7;--accent:#D92D0D;--accent-ink:#ffffff;--soft:#FFF7F4;--focus:#E7310E;--shadow:0 18px 60px #0000000d}
:root[data-theme="dark"]{color-scheme:dark;--page:#141414;--surface:#202023;--ink:#F5F5F7;--muted:#B8B8BF;--line:#444449;--accent:#D92D0D;--accent-ink:#FFFFFF;--soft:#29292D;--focus:#FF937C;--shadow:0 18px 60px #00000026}
*{box-sizing:border-box}body{margin:0;min-width:280px;background:var(--page);color:var(--ink)}a{color:inherit;text-underline-offset:.2em}button,input{font:inherit}button,a{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible{outline:3px solid var(--focus);outline-offset:4px}main:focus{outline:none}.page-shell{width:min(100% - 48px,720px);margin:0 auto;padding:32px 0 28px}.page-header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:32px}.brand{text-decoration:none;font-size:20px;font-weight:800;letter-spacing:-.035em;white-space:nowrap}.brand span{font-weight:400;letter-spacing:-.02em}.preferences{display:flex;align-items:center;gap:12px}.preference-group{display:flex;border:1px solid var(--line);border-radius:10px;padding:3px;gap:2px}.preferences a{display:grid;place-items:center;min-width:44px;min-height:44px;padding:4px 8px;border-radius:7px;text-decoration:none;color:var(--muted);font-size:14px;font-weight:600}.preferences a[aria-current="page"]{background:var(--surface);box-shadow:0 1px 4px #00000012;color:var(--ink)}.preferences a:hover{background:var(--soft);color:var(--ink)}.preferences span{font-size:22px;line-height:1}.consent-card{padding:40px;border:1px solid var(--line);border-top:4px solid var(--accent);border-radius:32px;background:var(--surface);box-shadow:var(--shadow)}.eyebrow{margin:0 0 12px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.14em}h1{margin:0;font-size:32px;font-weight:800;letter-spacing:-.04em;line-height:1.25}.introduction{margin:16px 0 28px;color:var(--muted);font-size:16px}.connection-facts{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px;margin:0 0 28px;padding:22px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.connection-facts div{min-width:0}.connection-facts dt{margin-bottom:4px;color:var(--muted);font-size:12px}.connection-facts dd{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}.connection-facts .callback-fact{grid-column:1/-1}.callback-fact code{font-weight:400}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere;word-break:break-word}.permissions h2,.boundary h2{font-size:14px;line-height:1.5;margin:0 0 14px;font-weight:700}.permissions ul{list-style:none;padding:0;margin:0;display:grid;gap:20px}.permissions li{padding-left:20px;position:relative}.permissions li:before{content:"";position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:var(--accent)}.permissions strong{display:block;font-size:16px;font-weight:600}.permissions p{margin:4px 0;color:var(--muted);font-size:14px}.permissions code{color:var(--muted);font-size:12px}.boundary{background:var(--soft);border-radius:10px;padding:18px 20px;margin-top:26px}.boundary h2{margin-bottom:6px}.boundary p{margin:0;color:var(--muted);font-size:13px}.decision-form{display:grid;grid-template-columns:1fr 1.35fr;gap:12px;margin-top:28px}.button{display:flex;justify-content:center;align-items:center;min-height:48px;padding:12px 20px;border:1px solid transparent;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;text-align:center;line-height:1.5}.button-primary{min-height:52px;font-weight:800;background:var(--accent);color:var(--accent-ink)}.button-primary:hover{filter:brightness(1.08)}.button-secondary{background:transparent;border-color:var(--line);color:var(--ink)}.button-secondary:hover{background:var(--soft)}.page-actions{display:flex;margin-top:28px}.page-actions .button{min-width:190px}.error-code{padding:16px 0;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}.error-code code{color:var(--ink)}.page-footer{margin-top:22px;text-align:center;color:var(--muted);font-size:12px;letter-spacing:.015em}.skip-link{position:absolute;left:12px;top:12px;transform:translateY(-180%);padding:10px 16px;z-index:1;background:var(--surface);border:1px solid var(--line);border-radius:6px}.skip-link:focus{transform:none}
@media(max-width:540px){.page-shell{width:min(100% - 28px,720px);padding-top:20px}.page-header{align-items:flex-start;gap:16px;flex-direction:column;margin-bottom:22px}.preferences{align-self:flex-end;margin-top:-4px}.consent-card{padding:24px;border-radius:24px}.connection-facts{grid-template-columns:1fr;gap:16px}.connection-facts .callback-fact{grid-column:auto}.decision-form{grid-template-columns:1fr}.page-actions .button{width:100%}.page-actions{display:block}.boundary{padding:16px}.brand{font-size:21px}}
@media(forced-colors:active){.button,.preference-group,.consent-card,.boundary{border:1px solid CanvasText}.preferences a[aria-current="page"]{outline:1px solid Highlight}.permissions li:before{background:CanvasText}}
`;
