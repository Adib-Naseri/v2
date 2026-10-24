import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVlessUri, isUuid, parseSocks5Url, parseVlessHeader, socksAddressBytes,
  validatePath, validatePlan, uuidFromBytes
} from '../src/core.js';

const UUID = '00000000-0000-4000-8000-000000000001';

function headerForDomain(uuid, host, port, payload = []) {
  const bytes = Uint8Array.from(uuid.replaceAll('-', '').match(/.{2}/g).map((x) => parseInt(x, 16)));
  const domain = new TextEncoder().encode(host);
  return new Uint8Array([1, ...bytes, 0, 1, port >> 8, port & 255, 2, domain.length, ...domain, ...payload]);
}

test('accepts the preserved UUID shape and rejects malformed IDs', () => {
  assert.equal(isUuid(UUID), true);
  assert.equal(uuidFromBytes(Uint8Array.from(UUID.replaceAll('-', '').match(/.{2}/g).map((x) => parseInt(x, 16)))), UUID);
  assert.equal(isUuid('not-a-user'), false);
});

test('parses VLESS domain targets and keeps the data tail', () => {
  const packet = headerForDomain(UUID, 'example.com', 443, [7, 8, 9]);
  const parsed = parseVlessHeader(packet);
  assert.equal(parsed.userId, UUID);
  assert.equal(parsed.address, 'example.com');
  assert.equal(parsed.port, 443);
  assert.deepEqual([...parsed.payload], [7, 8, 9]);
});

test('parses an incomplete header only after all address bytes arrive', () => {
  const packet = headerForDomain(UUID, 'example.com', 443);
  assert.throws(() => parseVlessHeader(packet.slice(0, -2)), /incomplete/);
  assert.equal(parseVlessHeader(packet).address, 'example.com');
  const uuidBytes = UUID.replaceAll('-', '').match(/.{2}/g).map((x) => parseInt(x, 16));
  const ipv4 = new Uint8Array([1, ...uuidBytes, 0, 1, 0, 53, 1, 1, 1, 1, 1]);
  assert.equal(parseVlessHeader(ipv4).address, '1.1.1.1');
});

test('encodes SOCKS5 domain, IPv4, and IPv6 targets', () => {
  assert.deepEqual([...socksAddressBytes('example.com', 443).slice(0, 2)], [3, 11]);
  assert.deepEqual([...socksAddressBytes('1.2.3.4', 53)], [1, 1, 2, 3, 4, 0, 53]);
  const v6 = socksAddressBytes('2001:db8::1', 443);
  assert.equal(v6[0], 4);
  assert.equal(v6.length, 19);
  assert.deepEqual([...v6.slice(-2)], [1, 187]);
});

test('validates global path and required user plan', () => {
  assert.equal(validatePath('/ws').toString(), '/ws');
  assert.throws(() => validatePath('/ws?x=1'), /cannot contain/);
  assert.deepEqual(validatePlan(30, 10), { periodDays: 30, trafficLimitBytes: 10_000_000_000 });
  assert.throws(() => validatePlan(0, 10), /duration/);
});

test('parses SOCKS credentials and builds a shareable URI with the global path', () => {
  const parsed = parseSocks5Url('socks5://alice:p%40ss@proxy.example:1080');
  assert.equal(parsed.username, 'alice');
  assert.equal(parsed.password, 'p@ss');
  const uri = buildVlessUri({ uuid: UUID, host: 'edge.example', path: '/shared', label: 'Phone' });
  assert.equal(uri.startsWith(`vless://${UUID}@edge.example:443?`), true);
  assert.match(uri, /path=%2Fshared/);
});
