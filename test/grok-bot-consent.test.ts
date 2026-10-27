import test from 'node:test';
import assert from 'node:assert/strict';
import { consentCss, renderConsentPage, type ConsentPageInput } from '../src/integrations/grok-bot-consent.js';

const requestId = 'R'.repeat(43);
const path = `/api/integrations/grok-bot/oauth/requests/${requestId}`;
const base: ConsentPageInput = {
  requestId, path, language: 'en', theme: 'light', status: 'consent',
  clientName: 'Evidence Review Bot', redirectUri: 'https://bot.example/callback',
  organization: 'OneLaser', managerName: 'Example Manager', csrfToken: 'C'.repeat(43)
};
const render = (changes: Partial<ConsentPageInput> = {}) => renderConsentPage({ ...base, ...changes });

test('consent is a complete script-free document with only the same-origin external stylesheet', () => {
  const html = render();
  assert.match(html, /^<!doctype html>/); assert.match(html, /<html lang="en" data-theme="light">/);
  assert.match(html, /OneLaser <span>Work OS<\/span>/);
  assert.match(html, /<link rel="stylesheet" href="\/api\/integrations\/grok-bot\/oauth\/consent\.css">/);
  assert(!/<script\b|<style\b|\sstyle\s*=|\son[a-z]+\s*=/i.test(html));
  assert(!/<meta[^>]+http-equiv\s*=|autofocus|javascript:/i.test(html));
  assert.match(html, /href="#consent-main"/); assert.match(html, /<main id="consent-main" tabindex="-1">/);
});

test('a consent decision requires an explicit POST with CSRF and language/theme preferences', () => {
  const html = render({ language: 'zh', theme: 'dark' });
  assert.match(html, new RegExp(`<form method="post" action="${path}"`));
  assert.match(html, /name="csrf_token" value="C{43}"/);
  assert.match(html, /name="lang" value="zh"/); assert.match(html, /name="theme" value="dark"/);
  assert.match(html, /type="submit" name="decision" value="approve">批准连接<\/button>/);
  assert.match(html, /type="submit" name="decision" value="deny">拒绝<\/button>/);
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert(!/checked|auto.?approve|auto.?submit/i.test(html));
});

test('both languages disclose exactly the evidence tools and preserve the human-decision boundary', () => {
  const english = render();
  assert.match(english, /Read assigned evidence-review jobs/); assert.match(english, /Submit evidence assessments/);
  assert.match(english, /Client name \(identity unverified\)/); assert.match(english, /its identity has not been verified/);
  assert.match(english, /<code dir="auto">https:\/\/bot\.example\/callback<\/code>/);
  assert.match(english, /cannot accept tasks, replace human review, or make pay or personnel decisions/);
  const chinese = render({ language: 'zh' });
  assert.match(chinese, /读取已分配的证据评估任务/); assert.match(chinese, /提交证据评估建议/);
  assert.match(chinese, /客户端名称（身份未核验）/); assert.match(chinese, /客户端名称由连接方提供，身份尚未核验/);
  assert.match(chinese, /不能验收任务、代替人工复核，也不能作出薪酬或人事决定/);
  for (const html of [english, chinese]) {
    assert.equal((html.match(/<code>workos_get_review_job<\/code>/g) || []).length, 1);
    assert.equal((html.match(/<code>workos_submit_review<\/code>/g) || []).length, 1);
    assert.match(html, /Evidence Review Bot/); assert.match(html, /Example Manager/);
  }
  assert.match(render({ clientName: 'Pre-registered Grok Bot' }), /Client name \(identity unverified\)<\/dt><dd dir="auto">Pre-registered Grok Bot/);
});

test('language and appearance switches are GET links that preserve the other preference', () => {
  const html = render({ language: 'zh', theme: 'dark' });
  assert.match(html, new RegExp(`href="${path}\\?lang=en&amp;theme=dark"`));
  assert.match(html, new RegExp(`href="${path}\\?lang=zh&amp;theme=light"`));
  assert.match(html, /切换为中文 \/ Switch to Chinese/); assert.match(html, /切换为英文 \/ Switch to English/);
  assert.match(html, /切换为浅色 \/ Switch to light theme/); assert.match(html, /切换为深色 \/ Switch to dark theme/);
  assert.match(html, /aria-hidden="true">☀<\/span>/); assert.match(html, /aria-hidden="true">☾<\/span>/);
  assert.match(html, /lang="zh-CN" aria-label="切换为中文 \/ Switch to Chinese" aria-current="page"/);
});

test('text and hidden form values escape markup, quotes and ampersands', () => {
  const malicious = `A<&"'><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const html = render({ clientName: malicious, organization: malicious, managerName: malicious, redirectUri: malicious, csrfToken: malicious });
  assert(!html.includes(malicious)); assert(!/<script\b|<img\b/i.test(html));
  assert.match(html, /A&lt;&amp;&quot;&#39;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /name="csrf_token" value="A&lt;&amp;&quot;&#39;&gt;/);
  assert(!html.includes('value="A<&"'));
});

test('invalid action paths and request IDs fail closed without approval or external switch links', () => {
  for (const changes of [
    { path: 'https://evil.example/steal' }, { path: '//evil.example/steal' },
    { path: `${path}?returnTo=https://evil.example` }, { path: `${path}" onsubmit="alert(1)` },
    { requestId: '<script>bad</script>' }, { path: '/api/integrations/grok-bot/oauth/requests/' + 'X'.repeat(43) }
  ]) {
    const html = render(changes);
    assert(!/<form\b|name="decision"/.test(html)); assert.match(html, /INVALID_AUTH_REQUEST/);
    assert(!html.includes('evil.example')); assert.match(html, /href="\/\?lang=en&amp;theme=light"/);
  }
  const missingCsrf = render({ csrfToken: undefined });
  assert.match(missingCsrf, /CONSENT_UNAVAILABLE/); assert(!/<form\b/.test(missingCsrf));
});

test('login state links only to its controlled DingTalk request and never approves access', () => {
  const loginUrl = `/api/auth/dingtalk/start?oauth_request=${requestId}`;
  const html = render({ status: 'login', loginUrl });
  assert.match(html, new RegExp(`href="${loginUrl.replace('?', '\\?')}"`));
  assert.match(html, /Sign in with DingTalk/); assert.match(html, /Signing in does not approve access/);
  assert(!/<form\b|name="decision"/.test(html));
  for (const unsafe of ['https://evil.example', '//evil.example', 'javascript:alert(1)', `${loginUrl}&returnTo=https://evil.example`, `/api/auth/dingtalk/start?oauth_request=${'X'.repeat(43)}`]) {
    const rejected = render({ status: 'login', loginUrl: unsafe });
    assert.match(rejected, /<a class="button button-primary" href="\/">Return to Work OS<\/a>/);
    assert(!rejected.includes('evil.example')); assert(!rejected.includes('javascript:'));
  }
});

test('errors display only a bounded safe code, without forms or arbitrary upstream text', () => {
  const html = render({ status: 'error', errorCode: 'OAUTH_REQUEST_EXPIRED' });
  assert.match(html, /Error code: <code>OAUTH_REQUEST_EXPIRED<\/code>/); assert(!/<form\b/.test(html));
  for (const code of ['<script>upstream-secret</script>', 'Server failed: upstream-secret', 'E'.repeat(81)]) {
    const rejected = render({ status: 'error', errorCode: code });
    assert.match(rejected, /OAUTH_REQUEST_FAILED/); assert(!rejected.includes(code)); assert(!rejected.includes('upstream-secret'));
  }
});

test('completion requires an explicit return click and escapes code, state and issuer query values', () => {
  const completionUrl = 'https://bot.example/callback?code=opaque&state=x%26y%22z&iss=https%3A%2F%2Fwork.example';
  const html = render({ status: 'complete', completionUrl });
  assert.match(html, /Authorization step complete/); assert.match(html, /Return to Bot/);
  assert.match(html, /href="https:\/\/bot\.example\/callback\?code=opaque&amp;state=x%26y%22z&amp;iss=https%3A%2F%2Fwork\.example" rel="noreferrer"/);
  assert(!/<form\b|<script\b|http-equiv|window\.|location\.|name="decision"/.test(html));
  assert.match(render({ status: 'complete', language: 'zh', completionUrl }), />返回 Bot<\/a>/);
});

test('unsafe completion URLs fall back to the application root', () => {
  for (const completionUrl of [
    undefined, 'javascript:alert(1)', 'http://bot.example/callback', '//evil.example',
    'https://user:secret@bot.example/callback', 'https://bot.example/callback#fragment', 'https://bot.example/callback#', 'https://bot.example/\\evil', 'https://bot.example/\ncallback',
    'cursor://evil.example/oauth/callback?code=c', 'cursor://anysphere.cursor-mcp/other/callback?code=c',
    'cursor://anysphere.cursor-mcp/oauth/callback/?code=c', 'cursor://anysphere.cursor-mcp/a/../oauth/callback?code=c',
    'vscode://anysphere.cursor-mcp/oauth/callback?code=c', 'cursor://user:secret@anysphere.cursor-mcp/oauth/callback?code=c',
    'cursor://anysphere.cursor-mcp/oauth/callback?code=c#fragment',
    'http://127.1:8787/callback?code=c', 'http://2130706433:8787/callback?code=c', 'http://0x7f000001:8787/callback?code=c',
    'http://127.000.000.001:8787/callback?code=c', 'http://localhost.:8787/callback?code=c', 'http://LOCALHOST:8787/callback?code=c',
    'http://[::ffff:127.0.0.1]:8787/callback?code=c', 'http://%6cocalhost:8787/callback?code=c',
    'http://localhost/callback?code=c', 'http://localhost:8787?code=c', 'http://localhost:08787/callback?code=c',
    'http://localhost:0/callback?code=c', 'http://localhost:65536/callback?code=c',
    'http://user:secret@localhost:8787/callback?code=c', 'http://localhost:8787/callback?code=c#fragment',
    'http://localhost:8787/a/../callback?code=c', 'http://localhost:8787/\\callback?code=c'
  ]) {
    const html = render({ status: 'complete', completionUrl });
    assert.match(html, /<a class="button button-primary" href="\/" rel="noreferrer">Return to Work OS<\/a>/);
    assert(!html.includes('user:secret')); assert(!html.includes('javascript:'));
  }
});

test('completion permits the exact native Cursor callback and literal fixed-port loopback callbacks with query parameters', () => {
  for (const callback of [
    'cursor://anysphere.cursor-mcp/oauth/callback',
    'http://localhost:8787/callback',
    'http://localhost:80/callback',
    'http://127.0.0.1:43123/oauth/callback',
    'http://[::1]:43123/oauth/callback'
  ]) {
    const completionUrl = `${callback}?code=opaque&state=x%26y&iss=https%3A%2F%2Fwork.example`;
    const html = render({ status: 'complete', completionUrl });
    assert(html.includes(`href="${completionUrl.replaceAll('&', '&amp;')}" rel="noreferrer">Return to Bot</a>`));
    assert(!/<form\b|<script\b|http-equiv|window\.|location\./.test(html));
    assert.match(render({ status: 'complete', completionUrl, language: 'zh' }), />返回 Bot<\/a>/);
  }
});

test('the exported stylesheet supports both themes, small screens and keyboard/high-contrast access without network assets', () => {
  assert.match(consentCss, /data-theme="dark"/); assert.match(consentCss, /color-scheme:light/); assert.match(consentCss, /color-scheme:dark/);
  assert.match(consentCss, /@media\(max-width:540px\)/); assert.match(consentCss, /focus-visible/);
  assert.match(consentCss, /@media\(forced-colors:active\)/); assert.match(consentCss, /overflow-wrap:anywhere/);
  assert(!/@import|url\(|https?:|expression\(/i.test(consentCss));
});
