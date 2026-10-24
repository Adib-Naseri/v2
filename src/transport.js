import { connect } from 'cloudflare:sockets';
import { parseSocks5Url, socksAddressBytes, parseVlessHeader, isUuid } from './core.js';

const encoder = new TextEncoder();
const MAX_HEADER = 2048;
const MAX_PENDING_WS_BYTES = 512 * 1024;
const SOCKS_TIMEOUT_MS = 8_000;

class BufferedSocketReader {
  constructor(reader) { this.reader = reader; this.buffer = new Uint8Array(0); }
  async readExact(size, stage) {
    const deadline = Date.now() + SOCKS_TIMEOUT_MS;
    while (this.buffer.length < size) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`SOCKS timeout during ${stage}`);
      let timer;
      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SOCKS timeout during ${stage}`)), left); })
      ]).finally(() => clearTimeout(timer));
      if (result.done || !result.value) throw new Error(`SOCKS closed during ${stage}`);
      const next = new Uint8Array(this.buffer.length + result.value.length);
      next.set(this.buffer); next.set(result.value, this.buffer.length); this.buffer = next;
    }
    const result = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return result;
  }
  async read() {
    if (this.buffer.length) {
      const value = this.buffer;
      this.buffer = new Uint8Array(0);
      return { value, done: false };
    }
    return this.reader.read();
  }
}

async function readSocksBoundAddress(reader) {
  const head = await reader.readExact(4, 'CONNECT reply');
  if (head[0] !== 5) throw new Error('invalid SOCKS version in reply');
  if (head[1] !== 0) throw new Error(`SOCKS CONNECT rejected (${head[1]})`);
  let addressLength;
  if (head[3] === 1) addressLength = 4;
  else if (head[3] === 4) addressLength = 16;
  else if (head[3] === 3) addressLength = (await reader.readExact(1, 'bound domain length'))[0];
  else throw new Error('invalid SOCKS bound-address type');
  await reader.readExact(addressLength + 2, 'bound address');
}

/** Connects to the SOCKS endpoint, then sends the destination name inside the SOCKS request.
 * No Worker-side DNS lookup or direct destination connection is performed.
 */
export async function openSocksTunnel(uri, targetHost, targetPort) {
  const proxy = parseSocks5Url(uri);
  const socket = connect({ hostname: proxy.hostname, port: proxy.port }, { allowHalfOpen: true });
  let timer;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SOCKS endpoint connection timed out')), SOCKS_TIMEOUT_MS); })
    ]);
  } catch (error) {
    try { await socket.close(); } catch {}
    throw error;
  } finally { clearTimeout(timer); }

  const rawWriter = socket.writable.getWriter();
  const rawReader = socket.readable.getReader();
  const reader = new BufferedSocketReader(rawReader);
  try {
    const methods = proxy.username || proxy.password ? [0, 2] : [0];
    await rawWriter.write(new Uint8Array([5, methods.length, ...methods]));
    const greeting = await reader.readExact(2, 'method negotiation');
    if (greeting[0] !== 5 || greeting[1] === 255) throw new Error('SOCKS authentication negotiation failed');
    if (greeting[1] === 2) {
      if (!proxy.username && !proxy.password) throw new Error('SOCKS endpoint unexpectedly requires credentials');
      const user = encoder.encode(proxy.username);
      const pass = encoder.encode(proxy.password);
      if (user.length > 255 || pass.length > 255) throw new Error('SOCKS credentials exceed protocol limits');
      await rawWriter.write(new Uint8Array([1, user.length, ...user, pass.length, ...pass]));
      const auth = await reader.readExact(2, 'username/password authentication');
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS authentication rejected');
    } else if (greeting[1] !== 0) {
      throw new Error(`unsupported SOCKS authentication method ${greeting[1]}`);
    }
    const address = socksAddressBytes(targetHost, targetPort);
    const request = new Uint8Array(4 + address.length);
    request.set([5, 1, 0, address[0]], 0);
    request.set(address.slice(1), 4);
    await rawWriter.write(request);
    await readSocksBoundAddress(reader);

    let closed = false;
    return {
      read: () => reader.read(),
      write: (chunk) => rawWriter.write(chunk),
      close: async () => {
        if (closed) return;
        closed = true;
        try { rawWriter.releaseLock(); } catch {}
        try { rawReader.releaseLock(); } catch {}
        try { await socket.close(); } catch {}
      },
      socket
    };
  } catch (error) {
    try { rawWriter.releaseLock(); } catch {}
    try { rawReader.releaseLock(); } catch {}
    try { await socket.close(); } catch {}
    throw error;
  }
}

function bytesOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return encoder.encode(data);
  throw new Error('binary frames required');
}

function concatenate(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function accountBytes(env, uuid, bytes) {
  if (!bytes) return { allowed: true, exhausted: false };
  const now = Date.now();
  const result = await env.DB.prepare(`
    UPDATE accounts
       SET used_bytes = used_bytes + ?,
           enabled = CASE WHEN traffic_limit_bytes IS NOT NULL AND used_bytes + ? >= traffic_limit_bytes THEN 0 ELSE enabled END,
           disabled_reason = CASE WHEN traffic_limit_bytes IS NOT NULL AND used_bytes + ? >= traffic_limit_bytes THEN 'traffic-limit' ELSE disabled_reason END,
           updated_at = ?
     WHERE id = ? AND enabled = 1
       AND (expires_at IS NULL OR expires_at > ?)
       AND (traffic_limit_bytes IS NULL OR used_bytes + ? <= traffic_limit_bytes)
  `).bind(bytes, bytes, bytes, now, uuid, now, bytes).run();
  if (result.meta?.changes === 1) {
    const exhausted = await env.DB.prepare('SELECT enabled FROM accounts WHERE id=?').bind(uuid).first();
    return { allowed: true, exhausted: !exhausted?.enabled };
  }
  await env.DB.prepare(`UPDATE accounts SET enabled=0,
    disabled_reason=CASE WHEN expires_at IS NOT NULL AND expires_at<=? THEN 'expired'
                         WHEN traffic_limit_bytes IS NOT NULL AND used_bytes+?>traffic_limit_bytes THEN 'traffic-limit'
                         ELSE COALESCE(disabled_reason,'disabled') END,
    updated_at=? WHERE id=?`)
    .bind(now, bytes, now, uuid).run();
  return { allowed: false, exhausted: true };
}

function isIncompleteHeader(error) {
  return /incomplete/.test(String(error?.message || error));
}

/** Relays one client WebSocket session to the selected global SOCKS exit. */
export async function relayWebSocket({ websocket, env, context, settings }) {
  websocket.accept();
  let tunnel = null;
  let closed = false;
  let queue = [];
  let queueBytes = 0;
  let waiter = null;
  let writeChain = Promise.resolve();
  let closeWaiter;
  const closeSignal = new Promise((resolve) => { closeWaiter = resolve; });

  const finish = async (code = 1000, reason = 'closed') => {
    if (closed) return;
    closed = true;
    closeWaiter();
    try { await tunnel?.close(); } catch {}
    try { websocket.close(code, reason.slice(0, 120)); } catch {}
  };
  const enqueue = (data) => {
    let chunk;
    try { chunk = bytesOf(data); } catch { context.waitUntil(finish(1003, 'binary frames required')); return; }
    if (queueBytes + chunk.length > MAX_PENDING_WS_BYTES) { context.waitUntil(finish(1009, 'initial buffer limit exceeded')); return; }
    if (waiter) { const resolve = waiter; waiter = null; resolve(chunk); }
    else { queue.push(chunk); queueBytes += chunk.length; }
  };
  const nextFrame = () => {
    if (queue.length) { const chunk = queue.shift(); queueBytes -= chunk.length; return Promise.resolve(chunk); }
    if (closed) return Promise.reject(new Error('websocket closed'));
    return Promise.race([
      new Promise((resolve) => { waiter = resolve; }),
      closeSignal.then(() => { throw new Error('websocket closed'); })
    ]);
  };
  websocket.addEventListener('message', (event) => enqueue(event.data));
  websocket.addEventListener('close', () => { closed = true; closeWaiter(); context.waitUntil(tunnel?.close?.() || Promise.resolve()); });
  websocket.addEventListener('error', () => { context.waitUntil(finish(1011, 'websocket error')); });

  try {
    let headerBytes = await Promise.race([
      nextFrame(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('initial frame timeout')), 10_000))
    ]);
    let header;
    while (true) {
      try { header = parseVlessHeader(headerBytes); break; }
      catch (error) {
        if (!isIncompleteHeader(error) || headerBytes.length >= MAX_HEADER) throw error;
        const rest = await nextFrame();
        headerBytes = concatenate([headerBytes, rest]);
      }
    }
    if (!isUuid(header.userId)) throw new Error('invalid user identifier');
    if (header.command !== 1) throw new Error('only TCP is supported; UDP is unavailable');

    const user = await env.DB.prepare('SELECT id,enabled,expires_at,traffic_limit_bytes,used_bytes FROM accounts WHERE id=?').bind(header.userId).first();
    if (!user || !user.enabled || (user.expires_at && user.expires_at <= Date.now()) || (user.traffic_limit_bytes && user.used_bytes >= user.traffic_limit_bytes)) {
      throw new Error('account inactive');
    }
    const pool = await env.DB.prepare(`SELECT id,uri FROM proxy_candidates WHERE healthy=1
      ORDER BY CASE WHEN id=(SELECT value FROM app_meta WHERE key='active_proxy_id') THEN 0 ELSE 1 END,
               COALESCE(latency_ms, 2147483647) ASC`).all();
    const candidates = pool.results || [];
    if (!candidates.length) throw new Error('no verified exit is available');

    let lastError;
    for (const candidate of candidates) {
      try {
        tunnel = await openSocksTunnel(candidate.uri, header.address, header.port);
        await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES('active_proxy_id',?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
          .bind(candidate.id, Date.now()).run();
        break;
      } catch (error) {
        lastError = error;
        await env.DB.prepare(`UPDATE proxy_candidates SET healthy=0,fail_count=fail_count+1,last_error=?,last_checked=?,updated_at=? WHERE id=?`)
          .bind(String(error.message || error).slice(0, 180), Date.now(), Date.now(), candidate.id).run();
      }
    }
    if (!tunnel) throw lastError || new Error('all exits failed');

    websocket.send(new Uint8Array([header.version, 0]));
    if (header.payload.length) {
      const usage = await accountBytes(env, header.userId, header.payload.length);
      if (!usage.allowed) throw new Error('quota or expiry reached');
      await tunnel.write(header.payload);
      if (usage.exhausted) return finish(1008, 'traffic limit reached');
    }

    const uploadLoop = async () => {
      while (!closed) {
        const chunk = await nextFrame();
        const usage = await accountBytes(env, header.userId, chunk.length);
        if (!usage.allowed) { await finish(1008, 'quota or expiry reached'); return; }
        await tunnel.write(chunk);
        if (usage.exhausted) { await finish(1008, 'traffic limit reached'); return; }
      }
    };
    const downloadLoop = async () => {
      while (!closed) {
        const result = await tunnel.read();
        if (result.done || !result.value) break;
        const usage = await accountBytes(env, header.userId, result.value.length);
        if (!usage.allowed) { await finish(1008, 'quota or expiry reached'); return; }
        websocket.send(result.value);
        if (usage.exhausted) { await finish(1008, 'traffic limit reached'); return; }
      }
      await finish(1000, 'upstream closed');
    };
    await Promise.race([uploadLoop(), downloadLoop()]);
  } catch (error) {
    if (!closed) console.warn('relay closed:', String(error?.message || error));
    await finish(1008, 'connection rejected');
  }
}
