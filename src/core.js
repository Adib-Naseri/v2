export const DAY_MS = 86_400_000;
export const MAX_DAYS = 3650;
export const MAX_LIMIT_GB = 1_000_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function uuidFromBytes(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array) || bytes.length < offset + 16) throw new Error('incomplete user identifier');
  const hex = [...bytes.slice(offset, offset + 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parses the VLESS request header without mutating the supplied byte buffer. */
export function parseVlessHeader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 18) throw new Error('incomplete request header');
  const version = bytes[0];
  const userId = uuidFromBytes(bytes, 1);
  const addonLength = bytes[17];
  const commandIndex = 18 + addonLength;
  if (bytes.length < commandIndex + 4) throw new Error('incomplete request address');
  const command = bytes[commandIndex];
  const port = (bytes[commandIndex + 1] << 8) | bytes[commandIndex + 2];
  const addressType = bytes[commandIndex + 3];
  let address;
  let addressLength;
  let addressOffset = commandIndex + 4;
  if (addressType === 1) {
    addressLength = 4;
    if (bytes.length < addressOffset + addressLength) throw new Error('incomplete IPv4 address');
    address = [...bytes.slice(addressOffset, addressOffset + 4)].join('.');
  } else if (addressType === 2) {
    if (bytes.length < addressOffset + 1) throw new Error('incomplete domain length');
    addressLength = bytes[addressOffset++];
    if (!addressLength || bytes.length < addressOffset + addressLength) throw new Error('incomplete domain address');
    address = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(addressOffset, addressOffset + addressLength));
  } else if (addressType === 3) {
    addressLength = 16;
    if (bytes.length < addressOffset + addressLength) throw new Error('incomplete IPv6 address');
    const words = [];
    for (let i = 0; i < 16; i += 2) words.push(((bytes[addressOffset + i] << 8) | bytes[addressOffset + i + 1]).toString(16));
    address = words.join(':');
  } else {
    throw new Error('unsupported address type');
  }
  if (!port) throw new Error('invalid destination port');
  const payloadOffset = addressOffset + addressLength;
  return {
    version,
    userId,
    command,
    port,
    address,
    addressType,
    payload: bytes.slice(payloadOffset),
    headerLength: payloadOffset
  };
}

export function parseSocks5Url(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('SOCKS endpoint is missing');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('SOCKS endpoint must be a valid socks5:// URL'); }
  if (url.protocol !== 'socks5:') throw new Error('only socks5:// endpoints are accepted');
  if (!url.hostname || !url.port) throw new Error('SOCKS endpoint must include host and port');
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SOCKS port is invalid');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return {
    hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : '',
    password: url.password ? decodeURIComponent(url.password) : '',
    uri: `socks5://${url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''}${url.host}`
  };
}

export function socksAddressBytes(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid destination port');
  const utf8 = new TextEncoder();
  const ip4 = host.split('.');
  if (ip4.length === 4 && ip4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return new Uint8Array([1, ...ip4.map(Number), port >> 8, port & 255]);
  }
  if (host.includes(':')) {
    const words = expandIpv6(host);
    return new Uint8Array([4, ...words.flatMap((word) => [word >> 8, word & 255]), port >> 8, port & 255]);
  }
  const name = utf8.encode(host);
  if (!name.length || name.length > 255) throw new Error('SOCKS destination hostname must be 1–255 bytes');
  return new Uint8Array([3, name.length, ...name, port >> 8, port & 255]);
}

function expandIpv6(input) {
  const halves = input.toLowerCase().split('::');
  if (halves.length > 2) throw new Error('invalid IPv6 address');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const fill = 8 - left.length - right.length;
  if ((halves.length === 1 && fill !== 0) || (halves.length === 2 && fill < 1)) throw new Error('invalid IPv6 address');
  const parts = [...left, ...Array(fill).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) throw new Error('invalid IPv6 address');
  return parts.map((x) => parseInt(x, 16));
}

export function validatePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || !value.startsWith('/')) throw new Error('path must start with / and be at most 160 characters');
  if (/[?#\\\s\u0000-\u001f]/.test(value) || value.includes('..')) throw new Error('path cannot contain query, fragment, whitespace, or traversal characters');
  return value;
}

export function validatePlan(days, limitGB) {
  const d = days === '' || days === null || days === undefined ? null : Number(days);
  const g = limitGB === '' || limitGB === null || limitGB === undefined ? null : Number(limitGB);
  if (d !== null && (!Number.isFinite(d) || d <= 0 || d > MAX_DAYS)) throw new Error(`duration must be between 0 and ${MAX_DAYS} days`);
  if (g !== null && (!Number.isFinite(g) || g <= 0 || g > MAX_LIMIT_GB)) throw new Error('traffic limit must be positive GB');
  return { periodDays: d, trafficLimitBytes: g === null ? null : Math.floor(g * 1_000_000_000) };
}

export function userExpired(user, now = Date.now()) {
  return Number.isFinite(user.expiresAt) && user.expiresAt > 0 && now >= user.expiresAt;
}

export function buildVlessUri({ uuid, host, path, label = 'user' }) {
  if (!isUuid(uuid)) throw new Error('invalid user identifier');
  if (!host || /[\s/@?#]/.test(host)) throw new Error('invalid connection host');
  const query = new URLSearchParams({ encryption: 'none', security: 'tls', sni: host, type: 'ws', host, path }).toString();
  return `vless://${uuid}@${host}:443?${query}#${encodeURIComponent(label)}`;
}

export function ipFromPlainText(text) {
  const candidate = String(text).trim().split(/\s+/)[0];
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate) && candidate.split('.').every((n) => Number(n) <= 255)) return candidate;
  return null;
}
