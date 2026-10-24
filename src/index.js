import { PANEL_HTML } from './ui.js';
import { ensureSchema } from './schema.js';
import { buildVlessUri, isUuid, validatePath, validatePlan, userExpired } from './core.js';
import { relayWebSocket } from './transport.js';
import { addCandidate, checkActiveExit, runProxyScan, safeProxyList } from './proxy-health.js';

const COOKIE = 'pg_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function errorResponse(error, status = 400) {
  return json({ error: String(error?.message || error).slice(0, 240) }, status);
}
function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unb64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function signSession(payload, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}
async function sessionCookie(secret) {
  const exp = Date.now() + SESSION_MS;
  const nonce = crypto.randomUUID();
  const payload = `${exp}.${nonce}`;
  const token = `${b64url(encoder.encode(payload))}.${b64url(await signSession(payload, secret))}`;
  return { token, exp };
}
function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}
async function isAuthenticated(request, secret) {
  if (!secret) return false;
  const token = cookieValue(request, COOKIE);
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return false;
  try {
    const payload = decoder.decode(unb64url(encoded));
    const [expText, nonce] = payload.split('.');
    const exp = Number(expText);
    if (!Number.isSafeInteger(exp) || exp <= Date.now() || !nonce) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, unb64url(signature), encoder.encode(payload));
  } catch { return false; }
}
async function passwordMatches(candidate, expected) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(candidate))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(expected)))
  ]);
  const left = new Uint8Array(a); const right = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
function requestIsSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}
async function bodyJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 64_000) throw new Error('request body too large');
  return request.json();
}
async function setting(env, key, fallback = '') {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first();
  return row?.value ?? fallback;
}
async function saveSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(key, value, Date.now()).run();
}
async function disableExpired(env) {
  await env.DB.prepare(`UPDATE accounts SET enabled=0,disabled_reason='expired',updated_at=?
    WHERE enabled=1 AND expires_at IS NOT NULL AND expires_at<=?`).bind(Date.now(), Date.now()).run();
  await env.DB.prepare(`UPDATE accounts SET enabled=0,disabled_reason='traffic-limit',updated_at=?
    WHERE enabled=1 AND traffic_limit_bytes IS NOT NULL AND used_bytes>=traffic_limit_bytes`).bind(Date.now()).run();
}
function visibleHost(request) {
  const url = new URL(request.url);
  return url.hostname;
}
async function userRows(env, request) {
  await disableExpired(env);
  const rows = await env.DB.prepare(`SELECT id,label,created_at,period_days,traffic_limit_bytes,used_bytes,enabled,disabled_reason,expires_at
    FROM accounts ORDER BY created_at DESC`).all();
  const host = visibleHost(request);
  const wsPath = await setting(env, 'ws_path', '/ws');
  return (rows.results || []).map((u) => ({
    id: u.id,
    label: u.label,
    createdAt: u.created_at,
    periodDays: u.period_days,
    trafficLimitBytes: u.traffic_limit_bytes,
    usedBytes: u.used_bytes,
    enabled: Boolean(u.enabled),
    disabledReason: u.disabled_reason,
    expiresAt: u.expires_at,
    link: u.enabled ? buildVlessUri({ uuid: u.id, host, path: wsPath, label: u.label }) : null
  }));
}
async function createUser(env, body) {
  const id = body.uuid ? String(body.uuid).toLowerCase() : crypto.randomUUID();
  if (!isUuid(id)) throw new Error('user ID is not a valid UUID');
  const label = String(body.label || 'User').trim().slice(0, 80) || 'User';
  const plan = validatePlan(body.periodDays, body.trafficLimitGB);
  if (plan.periodDays === null || plan.trafficLimitBytes === null) throw new Error('duration and traffic limit are required');
  const now = Date.now();
  const expiresAt = now + plan.periodDays * 86_400_000;
  await env.DB.prepare(`INSERT INTO accounts(id,label,created_at,period_days,traffic_limit_bytes,used_bytes,enabled,disabled_reason,expires_at,updated_at)
    VALUES(?,?,?,?,?,0,1,NULL,?,?)`)
    .bind(id, label, now, plan.periodDays, plan.trafficLimitBytes, expiresAt, now).run();
  return { id, label, createdAt: now, periodDays: plan.periodDays, trafficLimitBytes: plan.trafficLimitBytes, usedBytes: 0, enabled: true, expiresAt };
}
async function handleApi(request, env, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  const adminSecret = env.ADMIN_PASSWORD;
  if (path === '/api/login' && request.method === 'POST') {
    if (!requestIsSameOrigin(request)) return json({ error: 'cross-origin request rejected' }, 403);
    if (!adminSecret || adminSecret.length < 14) return json({ error: 'ADMIN_PASSWORD secret must be configured with at least 14 characters' }, 503);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipDigest = await crypto.subtle.digest('SHA-256', encoder.encode(`${ip}|${adminSecret}`));
    const ipHash = b64url(new Uint8Array(ipDigest));
    const now = Date.now();
    const resetAt = now + 10 * 60_000;
    await env.DB.prepare(`INSERT INTO login_attempts(ip_hash,attempts,reset_at) VALUES(?,1,?)
      ON CONFLICT(ip_hash) DO UPDATE SET
        attempts=CASE WHEN login_attempts.reset_at<=? THEN 1 ELSE login_attempts.attempts+1 END,
        reset_at=CASE WHEN login_attempts.reset_at<=? THEN ? ELSE login_attempts.reset_at END`)
      .bind(ipHash, resetAt, now, now, resetAt).run();
    const attempt = await env.DB.prepare('SELECT attempts,reset_at FROM login_attempts WHERE ip_hash=?').bind(ipHash).first();
    if (attempt?.attempts > 8) return json({ error: 'too many login attempts; wait ten minutes' }, 429);
    const body = await bodyJson(request).catch(() => ({}));
    if (!await passwordMatches(body.password || '', adminSecret)) {
      return json({ error: 'invalid password' }, 401);
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip_hash=?').bind(ipHash).run();
    const session = await sessionCookie(adminSecret);
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=${session.token}; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}; HttpOnly; Secure; SameSite=Strict` });
  }
  if (path === '/api/logout' && request.method === 'POST') {
    if (!requestIsSameOrigin(request)) return json({ error: 'cross-origin request rejected' }, 403);
    return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!await isAuthenticated(request, adminSecret)) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'GET' && !requestIsSameOrigin(request)) return json({ error: 'cross-origin request rejected' }, 403);

  if (path === '/api/me' && request.method === 'GET') {
    return json({ host: visibleHost(request), wsPath: await setting(env, 'ws_path', '/ws') });
  }
  if (path === '/api/settings' && request.method === 'GET') return json({ wsPath: await setting(env, 'ws_path', '/ws') });
  if (path === '/api/settings' && request.method === 'POST') {
    const body = await bodyJson(request);
    let wsPath;
    try { wsPath = validatePath(String(body.wsPath || '')); } catch (error) { return errorResponse(error); }
    await saveSetting(env, 'ws_path', wsPath);
    return json({ ok: true, settings: { wsPath } });
  }
  if (path === '/api/users' && request.method === 'GET') return json({ users: await userRows(env, request) });
  if (path === '/api/users' && request.method === 'POST') {
    const body = await bodyJson(request);
    try {
      const user = await createUser(env, body);
      return json({ user, link: buildVlessUri({ uuid: user.id, host: visibleHost(request), path: await setting(env, 'ws_path', '/ws'), label: user.label }) }, 201);
    } catch (error) { return errorResponse(error); }
  }
  const userRoute = path.match(/^\/api\/users\/([0-9a-f-]{36})(?:\/(enable|disable))?$/i);
  if (userRoute) {
    const id = userRoute[1].toLowerCase();
    const action = userRoute[2];
    if (request.method === 'DELETE' && !action) {
      const result = await env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(id).run();
      if (result.meta?.changes !== 1) return json({ error: 'user not found' }, 404);
      return json({ ok: true });
    }
    if (request.method === 'POST' && action) {
      const user = await env.DB.prepare('SELECT id,period_days,traffic_limit_bytes,used_bytes FROM accounts WHERE id=?').bind(id).first();
      if (!user) return json({ error: 'user not found' }, 404);
      const now = Date.now();
      if (action === 'disable') {
        await env.DB.prepare("UPDATE accounts SET enabled=0,disabled_reason='admin',updated_at=? WHERE id=?").bind(now, id).run();
      } else {
        const expiresAt = user.period_days == null ? null : now + Number(user.period_days) * 86_400_000;
        await env.DB.prepare(`UPDATE accounts SET enabled=1,disabled_reason=NULL,used_bytes=0,created_at=?,expires_at=?,updated_at=? WHERE id=?`)
          .bind(now, expiresAt, now, id).run();
      }
      return json({ ok: true });
    }
    return json({ error: 'method not allowed' }, 405);
  }
  if (path === '/api/proxies' && request.method === 'GET') return json(await safeProxyList(env));
  if (path === '/api/proxies/add' && request.method === 'POST') {
    const body = await bodyJson(request);
    try { return json(await addCandidate(env, String(body.uri || '')), 201); }
    catch (error) { return errorResponse(error); }
  }
  if (path === '/api/proxies/select' && request.method === 'POST') {
    const body = await bodyJson(request);
    const candidate = await env.DB.prepare('SELECT id FROM proxy_candidates WHERE id=? AND healthy=1').bind(String(body.id || '')).first();
    if (!candidate) return json({ error: 'candidate is not currently healthy' }, 400);
    await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('active_proxy_id',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(candidate.id, Date.now()).run();
    return json({ ok: true, activeId: candidate.id });
  }
  if (path === '/api/proxies/scan' && request.method === 'POST') {
    context.waitUntil(runProxyScan(env).catch((error) => console.error('scheduled health scan failed:', String(error?.message || error))));
    return json({ ok: true, queued: true }, 202);
  }
  if (path === '/api/check-ip' && request.method === 'GET') {
    try { return json(await checkActiveExit(env)); }
    catch (error) { return errorResponse(error, 502); }
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, context) {
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, context);
      if (url.pathname === '/admin' || url.pathname === '/panel' || url.pathname === '/') {
        return new Response(PANEL_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
      }
      const wsPath = await setting(env, 'ws_path', '/ws');
      if (url.pathname === wsPath && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        context.waitUntil(relayWebSocket({ websocket: server, env, context, settings: { wsPath } }).catch((error) => console.error('relay task failed:', String(error?.message || error))));
        return new Response(null, { status: 101, webSocket: client });
      }
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('request failed:', String(error?.message || error));
      return new Response('Service configuration error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  },
  async scheduled(controller, env, context) {
    if (env.ENABLE_CRON !== '1') return;
    try {
      await ensureSchema(env.DB);
      context.waitUntil(runProxyScan(env).catch((error) => console.error('scheduled health scan failed:', String(error?.message || error))));
    } catch (error) {
      console.error('cron initialization failed:', String(error?.message || error));
    }
  }
};
