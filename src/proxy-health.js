import { connect } from 'cloudflare:sockets';
import tlsModule from 'workers-tls/workers_tls.wasm';
import { connectTls, initTls, openTunnel, pemToDer } from 'workers-tls';
import rootsPem from './roots.pem';
import { parseSocks5Url, ipFromPlainText } from './core.js';

const SOURCES = [
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
  'https://raw.githubusercontent.com/proxygenerator1/ProxyGenerator/main/MostStable/socks5.txt'
];
const CHECKERS = [
  ['api.ipify.org', '/'],
  ['ifconfig.me', '/ip'],
  ['checkip.amazonaws.com', '/'],
  ['icanhazip.com', '/'],
  ['ipinfo.io', '/ip']
];
const MAX_SOURCE_BYTES = 400_000;
const MAX_CANDIDATES = 180;
const BATCH_SIZE = 6;
let tlsInitialization;

function ensureTls() {
  if (!tlsInitialization) {
    tlsInitialization = Promise.resolve().then(() => initTls(tlsModule, pemToDer(rootsPem)));
  }
  return tlsInitialization;
}

function decodeChunked(text) {
  const output = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = text.indexOf('\r\n', cursor);
    if (end < 0) break;
    const length = parseInt(text.slice(cursor, end).split(';')[0], 16);
    if (!Number.isFinite(length) || length < 0) break;
    cursor = end + 2;
    if (length === 0) break;
    output.push(text.slice(cursor, cursor + length));
    cursor += length + 2;
  }
  return output.join('');
}

async function httpsViaProxy(proxyUri, host, path, maxBytes = 16_384) {
  await ensureTls();
  const tunnel = await openTunnel(connect, proxyUri, host, 443, { signal: AbortSignal.timeout(10_000) });
  let tls;
  try {
    let handshakeTimer;
    try {
      tls = await Promise.race([
        connectTls(host, tunnel),
        new Promise((_, reject) => { handshakeTimer = setTimeout(() => { tunnel.close().catch(() => {}); reject(new Error('TLS handshake timed out')); }, 8_000); })
      ]).finally(() => clearTimeout(handshakeTimer));
    } catch (error) {
      throw error;
    }
    await tls.write(new TextEncoder().encode(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: private-gateway-health/2\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`
    ));
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      let timer;
      const chunk = await Promise.race([
        tls.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTPS probe timed out')), 8_000); })
      ]).finally(() => clearTimeout(timer));
      if (!chunk) break;
      chunks.push(chunk);
      size += chunk.length;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const response = new TextDecoder().decode(joined);
    const separator = response.indexOf('\r\n\r\n');
    if (separator < 0) throw new Error('invalid HTTPS response');
    const status = Number((response.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
    if (status < 200 || status >= 300) throw new Error(`HTTPS service returned ${status || 'no status'}`);
    let body = response.slice(separator + 4);
    if (/\btransfer-encoding:\s*chunked\b/i.test(response.slice(0, separator))) body = decodeChunked(body);
    return body.trim();
  } finally {
    try { await tls?.close(); } catch {}
    try { await tunnel.close(); } catch {}
  }
}

async function readProxySource(activeUri, source) {
  const url = new URL(source);
  return httpsViaProxy(activeUri, url.hostname, url.pathname + url.search, MAX_SOURCE_BYTES);
}

function isPublicIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && b === 51) ||
    (a === 203 && b === 0 && parts[2] === 113));
}

function parseCandidates(text) {
  const values = new Set();
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^socks5:\/\//i, '');
    const match = candidate.match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/);
    if (!match || !isPublicIpv4(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) continue;
    try {
      const parsed = parseSocks5Url(`socks5://${candidate}`);
      values.add(parsed.uri);
    } catch {}
    if (values.size >= MAX_CANDIDATES) break;
  }
  return [...values];
}

export async function verifyProxy(proxyUri) {
  const started = Date.now();
  const outcomes = await Promise.all(CHECKERS.map(async ([host, path]) => {
    try {
      const text = await httpsViaProxy(proxyUri, host, path, 2048);
      const ip = ipFromPlainText(text);
      return { service: host, ok: Boolean(ip), ip, error: ip ? null : 'no IP address in response' };
    } catch (error) {
      return { service: host, ok: false, ip: null, error: String(error?.message || error).slice(0, 140) };
    }
  }));
  const ips = outcomes.filter((x) => x.ok).map((x) => x.ip);
  const counts = new Map();
  for (const ip of ips) counts.set(ip, (counts.get(ip) || 0) + 1);
  const consensus = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const independentAgreeing = consensus ? consensus[1] : 0;
  const healthy = independentAgreeing >= 3 && ips.length >= 3;
  return {
    healthy,
    exitIp: healthy ? consensus[0] : null,
    latencyMs: Date.now() - started,
    checkers: outcomes,
    error: healthy ? null : `only ${independentAgreeing} of ${CHECKERS.length} services agreed on an exit IP`
  };
}

async function currentBootstrapUri(env) {
  const active = await env.DB.prepare(`SELECT c.uri FROM proxy_candidates c JOIN app_meta m ON m.value=c.id
    WHERE m.key='active_proxy_id' AND c.healthy=1`).first();
  if (active?.uri) return active.uri;
  return '';
}

async function fetchSourcesThrough(uri) {
  const all = new Set();
  const errors = [];
  for (const source of SOURCES) {
    try {
      const text = await readProxySource(uri, source);
      for (const candidate of parseCandidates(text)) all.add(candidate);
      if (all.size >= MAX_CANDIDATES) break;
    } catch (error) { errors.push(String(error?.message || error)); }
  }
  if (!all.size && errors.length === SOURCES.length) throw new Error('proxy lists could not be fetched through the configured SOCKS exit');
  return [...all].slice(0, MAX_CANDIDATES);
}

async function verifyWithConcurrency(items, concurrency, verifier) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      results.push(await verifier(item));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runProxyScan(env) {
  const bootstrapUri = await currentBootstrapUri(env);
  if (!bootstrapUri) throw new Error('initial SOCKS endpoint must be added before automated discovery');
  const currentRows = await env.DB.prepare('SELECT id,uri FROM proxy_candidates ORDER BY last_checked DESC LIMIT 300').all();
  const sourceCandidates = new Set((currentRows.results || []).map((row) => row.uri));
  const discovered = await fetchSourcesThrough(bootstrapUri);
  for (const uri of discovered) sourceCandidates.add(uri);
  const sources = [...sourceCandidates];
  if (!sources.length) throw new Error('no proxy candidates were discovered');

  const cursorRow = await env.DB.prepare("SELECT value FROM app_meta WHERE key='scan_cursor'").first();
  const cursor = Number(cursorRow?.value || 0) % sources.length;
  const selected = sources.slice(cursor, cursor + BATCH_SIZE).concat(sources.slice(0, Math.max(0, cursor + BATCH_SIZE - sources.length)));
  const checks = await verifyWithConcurrency(selected, 2, async (uri) => {
    const parsed = parseSocks5Url(uri);
    const id = `${parsed.hostname}:${parsed.port}`;
    try {
      const health = await verifyProxy(uri);
      return { id, uri: parsed.uri, ...health };
    } catch (error) {
      return { id, uri: parsed.uri, healthy: false, exitIp: null, latencyMs: null, checkers: [], error: String(error?.message || error).slice(0, 180) };
    }
  });

  const now = Date.now();
  for (const result of checks) {
    await env.DB.prepare(`INSERT INTO proxy_candidates(id,uri,exit_ip,healthy,latency_ms,fail_count,last_error,last_checked,updated_at)
      VALUES(?,?,?,?,?,CASE WHEN ? THEN 0 ELSE 1 END,?,?,?)
      ON CONFLICT(id) DO UPDATE SET uri=excluded.uri,exit_ip=excluded.exit_ip,healthy=excluded.healthy,
        latency_ms=excluded.latency_ms,fail_count=CASE WHEN excluded.healthy=1 THEN 0 ELSE proxy_candidates.fail_count+1 END,
        last_error=excluded.last_error,last_checked=excluded.last_checked,updated_at=excluded.updated_at`)
      .bind(result.id, result.uri, result.exitIp, result.healthy ? 1 : 0, result.latencyMs,
        result.healthy ? 1 : 0, result.error, now, now).run();
  }
  await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('scan_cursor',?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(String((cursor + selected.length) % sources.length), now).run();

  const activeRow = await env.DB.prepare("SELECT value FROM app_meta WHERE key='active_proxy_id'").first();
  const activeStillHealthy = activeRow && (await env.DB.prepare('SELECT healthy FROM proxy_candidates WHERE id=?').bind(activeRow.value).first())?.healthy;
  if (!activeStillHealthy) {
    const next = await env.DB.prepare('SELECT id FROM proxy_candidates WHERE healthy=1 ORDER BY latency_ms ASC LIMIT 1').first();
    if (next) {
      await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('active_proxy_id',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(next.id, now).run();
    } else {
      await env.DB.prepare("DELETE FROM app_meta WHERE key='active_proxy_id'").run();
    }
  }
  return { checked: checks.length, healthy: checks.filter((x) => x.healthy).length, candidates: checks.map(({ uri, ...safe }) => safe) };
}

export async function checkActiveExit(env) {
  const uri = await currentBootstrapUri(env);
  if (!uri) throw new Error('no active SOCKS endpoint configured');
  const result = await verifyProxy(uri);
  return { endpoint: parseSocks5Url(uri).hostname + ':' + parseSocks5Url(uri).port, ...result };
}

export async function addCandidate(env, uri) {
  const parsed = parseSocks5Url(uri);
  if (!isPublicIpv4(parsed.hostname)) throw new Error('endpoint must be a public IPv4 address; private, local, and domain endpoints are rejected');
  if (parsed.username || parsed.password) throw new Error('auto-discovered endpoints must not contain credentials; use a dedicated protected secret for a private endpoint');
  const id = `${parsed.hostname}:${parsed.port}`;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO proxy_candidates(id,uri,healthy,fail_count,updated_at) VALUES(?,?,0,0,?)
    ON CONFLICT(id) DO UPDATE SET uri=excluded.uri,updated_at=excluded.updated_at`)
    .bind(id, parsed.uri, now).run();
  const health = await verifyProxy(parsed.uri);
  await env.DB.prepare(`UPDATE proxy_candidates SET exit_ip=?,healthy=?,latency_ms=?,fail_count=CASE WHEN ?=1 THEN 0 ELSE fail_count+1 END,
    last_error=?,last_checked=?,updated_at=? WHERE id=?`)
    .bind(health.exitIp, health.healthy ? 1 : 0, health.latencyMs, health.healthy ? 1 : 0, health.error, Date.now(), Date.now(), id).run();
  if (health.healthy) {
    const active = await env.DB.prepare("SELECT value FROM app_meta WHERE key='active_proxy_id'").first();
    if (!active) await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('active_proxy_id',?,?)`)
      .bind(id, Date.now()).run();
  }
  return { id, healthy: health.healthy, exitIp: health.exitIp, latencyMs: health.latencyMs, checkers: health.checkers, error: health.error };
}

export async function safeProxyList(env) {
  const result = await env.DB.prepare(`SELECT id,exit_ip,healthy,latency_ms,fail_count,last_error,last_checked
    FROM proxy_candidates ORDER BY healthy DESC,latency_ms ASC LIMIT 300`).all();
  const active = await env.DB.prepare("SELECT value FROM app_meta WHERE key='active_proxy_id'").first();
  return { activeId: active?.value || null, candidates: result.results || [] };
}
