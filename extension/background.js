/* 求职工作台 · 网申助手 —— 后台服务
   所有对 localhost:3000 的请求都从这里发出：内容脚本不直接碰本机服务，
   既避开页面自身的 CSP/跨域限制，也保证令牌只存在扩展里。 */
'use strict';

const BASE = 'http://localhost:3000';
let TOKEN = '';

async function ensureToken(force){
  if (TOKEN && !force) return TOKEN;
  if (!force) {
    const st = await chrome.storage.local.get('token');
    if (st && st.token) { TOKEN = st.token; return TOKEN; }
  }
  const r = await fetch(BASE + '/api/token');
  if (!r.ok) {
    throw new Error(r.status === 403
      ? '本机服务拒绝了取令牌请求（HTTP 403）。请确认 server.js 是最新版本并已重启。'
      : '取令牌失败 HTTP ' + r.status);
  }
  const d = await r.json();
  if (!d || !d.token) throw new Error('本机服务没有返回令牌');
  TOKEN = d.token;
  await chrome.storage.local.set({ token: TOKEN });
  return TOKEN;
}

async function callApi(path, opts) {
  opts = opts || {};
  let token;
  try { token = await ensureToken(false); }
  catch (e) { return { __err: String(e.message || e) }; }

  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-JobApp-Token': token },
    opts.headers || {}
  );
  let r;
  try {
    r = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    return { __err: '连不上本机服务（' + BASE + '）。请确认 node server.js 正在运行。' };
  }

  if (r.status === 401) {
    // 令牌过期（通常是删过 data/token.txt 或重启后重新生成），清掉再重试一次
    TOKEN = '';
    await chrome.storage.local.remove('token');
    let fresh;
    try { fresh = await ensureToken(true); }
    catch (e) { return { __err: String(e.message || e) }; }
    headers['X-JobApp-Token'] = fresh;
    r = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined
    });
  }

  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) {
    return { __err: '本机服务返回了非 JSON（HTTP ' + r.status + '）：' + text.replace(/\s+/g, ' ').slice(0, 120) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'jobapp-api') {
    callApi(msg.path, msg).then(d => reply({ ok: !(d && d.__err), data: d, error: d && d.__err }));
    return true;
  }

  if (msg.type === 'jobapp-token-status') {
    ensureToken(!!msg.force)
      .then(t => reply({ ok: true, masked: t.slice(0, 6) + '…' + t.slice(-4) }))
      .catch(e => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'jobapp-set-token') {
    TOKEN = String(msg.token || '').trim();
    chrome.storage.local.set({ token: TOKEN }).then(() => reply({ ok: true }));
    return true;
  }
});
