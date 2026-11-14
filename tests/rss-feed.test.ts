import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { contentLinkUrl, createFeedFetcher, createRssPhotoFetcher, FEED_MAX_BYTES, FEED_MAX_IMAGE_BYTES, FEED_MAX_IMAGE_POSITIONS, FEED_MAX_IMAGES, FEED_MAX_LINKS, FeedFetchError, fetchRssPhoto, findFeedLinks, isGifImageUrl, normalizeFeedUrl, parseFeed, publicAddress, resolveFeedAddresses, resolvePublicAddresses, RSS_PHOTO_MAX_SOURCE_BYTES, type FeedTransport, type FeedTransportResponse } from '../src/modules/rss-feed.js';

const url = 'https://feeds.example.com/rss';
const empty = '<rss version="2.0"><channel><title>Empty feed</title></channel></rss>';
function response(body: string | Buffer = empty, headers: FeedTransportResponse['headers'] = {}, status = 200): FeedTransportResponse {
  return { status, headers, body: Readable.from([Buffer.from(body)]) };
}
function setup(transport: FeedTransport = async () => response(), timeoutMs = 500) {
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const request = vi.fn(transport);
  return { lookup, request, fetch: createFeedFetcher({ lookup, transport: request, timeoutMs }) };
}

describe('RSS URL and network boundaries', () => {
  it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.1.2', '224.0.0.1', '255.255.255.255', '192.0.2.1', '::1', '::', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1'])('rejects non-public address %s', address => {
    expect(publicAddress(address)).toBe(false);
  });
  it.each(['https://localhost/rss', 'http://metadata.google.internal', 'http://127.1/rss', 'http://2130706433/', 'http://0x7f000001', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com/rss', 'https://example.com:8080/', 'http://foo.local/rss', 'https://example.com/\nsecret'])('rejects unsafe URL %s', input => {
    expect(() => normalizeFeedUrl(input)).toThrow('UNSAFE_URL');
  });
  it('canonicalizes without reordering signed query parameters', () => {
    expect(normalizeFeedUrl('HTTPS://FEEDS.EXAMPLE.COM:443/rss?b=2&a=1#ignored')).toBe(`${url}?b=2&a=1`);
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('pins the verified DNS answer and uses transparent headers without credentials', async () => {
    const f = setup();
    await f.fetch(url, { etag: '"v1"', lastModified: 'Mon, 09 Nov 2026 00:00:00 GMT' }, new AbortController().signal);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![1]).toMatchObject({ addresses: [{ address: '8.8.8.8', family: 4 }], headers: {
      'if-none-match': '"v1"', 'user-agent': expect.stringContaining('MisakaRSS/'), accept: expect.stringContaining('application/rss+xml'),
    } });
    expect(f.request.mock.calls[0]![1].headers).not.toHaveProperty('authorization');
    expect(f.request.mock.calls[0]![1].headers).not.toHaveProperty('cookie');
  });
  it('rejects mixed public/private answers before opening a connection', async () => {
    const f = setup();
    f.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(f.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('revalidates same-host redirects to prevent DNS rebinding', async () => {
    const f = setup(async () => response('', { location: '/other' }, 302));
    f.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(f.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('blocks redirects to metadata and discards validators across origins', async () => {
    const f = setup(async () => response('', { location: 'http://169.254.169.254/latest/' }, 302));
    await expect(f.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(f.request).toHaveBeenCalledTimes(1);
    const next = setup();
    next.request.mockResolvedValueOnce(response('', { location: 'https://other.example.com/feed' }, 301));
    const result = await next.fetch(url, { etag: '"secret-validator"' }, new AbortController().signal);
    expect(result.finalUrl).toBe('https://other.example.com/feed');
    expect(next.request.mock.calls[1]![1].headers).not.toHaveProperty('if-none-match');
  });
  it('bounds redirect loops and does not parse a 304 body', async () => {
    const loop = setup(async () => response('', { location: '/loop' }, 302));
    await expect(loop.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(loop.request).toHaveBeenCalledTimes(5);
    const cached = setup(async () => response('not XML', { etag: '"same"' }, 304));
    await expect(cached.fetch(url, {}, new AbortController().signal)).resolves.toMatchObject({ notModified: true, etag: '"same"' });
  });
  it('surfaces HTTP protection and Retry-After without leaking response bodies', async () => {
    const blocked = setup(async () => response('private response secret', {}, 403));
    await expect(blocked.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'BLOCKED', message: 'BLOCKED', status: 403 });
    const limited = setup(async () => response('', { 'retry-after': '20' }, 429));
    await expect(limited.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_ERROR', retryAfterMs: 20_000 });
  });
  it.each([gzipSync, deflateSync, brotliCompressSync])('decodes bounded compressed responses', async compress => {
    const encoding = compress === gzipSync ? 'gzip' : compress === deflateSync ? 'deflate' : 'br';
    const f = setup(async () => response(compress(Buffer.from(empty)), { 'content-encoding': encoding }));
    await expect(f.fetch(url, {}, new AbortController().signal)).resolves.toMatchObject({ feed: { title: 'Empty feed', entries: [] } });
  });
  it('rejects large declared bodies and decompression bombs', async () => {
    const huge = setup(async () => response('', { 'content-length': String(FEED_MAX_BYTES + 1) }));
    await expect(huge.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const bomb = setup(async () => response(gzipSync(Buffer.from('x'.repeat(FEED_MAX_BYTES + 1))), { 'content-encoding': 'gzip' }));
    await expect(bomb.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
  it('honors charset and UTF-16 BOMs', async () => {
    const text = empty.replace('Empty feed', 'Caf\u00e9');
    const latin = setup(async () => response(Buffer.from(text, 'latin1'), { 'content-type': 'text/xml; charset=iso-8859-1' }));
    expect((await latin.fetch(url, {}, new AbortController().signal)).feed!.title).toBe('Caf\u00e9');
    const utf16 = setup(async () => response(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')])));
    expect((await utf16.fetch(url, {}, new AbortController().signal)).feed!.title).toBe('Caf\u00e9');
  });
  it('bounds DNS waits and aborts a stalled response stream', async () => {
    const dns = setup(undefined, 20);
    dns.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(dns.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const stream = new Readable({ read() {} });
    const f = setup(async () => ({ status: 200, headers: {}, body: stream }), 20);
    await expect(f.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(stream.destroyed).toBe(true);
    const caller = new AbortController(); caller.abort();
    const cancelled = setup();
    await expect(cancelled.fetch(url, {}, caller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled.lookup).not.toHaveBeenCalled();
  });
  it('resolves proxy fake-IP through pinned public DoH without ever connecting to the fake address', async () => {
    const query = vi.fn<FeedTransport>(async url => response(JSON.stringify({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '8.8.8.8' }] : [] })));
    const result = await resolveFeedAddresses('appagg.com', new AbortController().signal, async () => [{ address: '198.18.1.170', family: 4 }], query);
    expect(result).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(query).toHaveBeenCalledTimes(2);
    for (const [url, options] of query.mock.calls) {
      expect(url.hostname).toBe('cloudflare-dns.com');
      expect(url.searchParams.get('name')).toBe('appagg.com');
      expect(options.addresses).toEqual([{ address: '1.1.1.1', family: 4 }]);
      expect(options.headers).toEqual({ accept: 'application/dns-json' });
    }
  });
  it('does not use DoH to bypass a real private address, and rejects private DoH answers', async () => {
    const query = vi.fn<FeedTransport>(async () => response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] })));
    const privateAddresses = [{ address: '127.0.0.1', family: 4 }];
    expect(await resolveFeedAddresses('feeds.example.com', new AbortController().signal, async () => privateAddresses, query)).toEqual(privateAddresses);
    expect(query).not.toHaveBeenCalled();
    await expect(resolveFeedAddresses('feeds.example.com', new AbortController().signal, async () => [{ address: '198.18.1.170', family: 4 }], query)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });
});

describe('Bounded RSS static-photo fetching', () => {
  const photoUrl = 'https://images.example.com/photo.jpg?b=2&a=1';
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  function photoSetup(transport: FeedTransport = async () => response(bytes, { 'content-type': 'image/jpeg' }), timeoutMs = 500) {
    const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    const request = vi.fn(transport);
    return { lookup, request, fetch: createRssPhotoFetcher({ lookup, transport: request, timeoutMs }) };
  }

  it('exports an inactive default fetcher and permits photos above 2 MiB without raising the feed cap', async () => {
    expect(typeof fetchRssPhoto).toBe('function');
    expect(FEED_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(RSS_PHOTO_MAX_SOURCE_BYTES).toBe(20 * 1024 * 1024);
    const large = Buffer.alloc(6_604_333, 1);
    const photo = photoSetup(async () => response(large, { 'content-type': 'image/jpeg', 'content-length': String(large.length) }));
    expect((await photo.fetch(photoUrl, new AbortController().signal)).equals(large)).toBe(true);
    const feed = setup(async () => response(large));
    await expect(feed.fetch(url, {}, new AbortController().signal)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('accepts exactly 20 MiB and rejects undeclared chunked overruns while destroying each stream', async () => {
    const maximum = Buffer.alloc(RSS_PHOTO_MAX_SOURCE_BYTES);
    const exact = response(maximum);
    const photo = photoSetup(async () => exact);
    expect((await photo.fetch(photoUrl, new AbortController().signal)).length).toBe(RSS_PHOTO_MAX_SOURCE_BYTES);
    expect(exact.body.destroyed).toBe(true);
    const oversized = Readable.from([maximum, Buffer.from([1])]);
    photo.request.mockResolvedValueOnce({ status: 200, headers: {}, body: oversized });
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(oversized.destroyed).toBe(true);
  });

  it('enforces declared and actual caller budgets, including lying Content-Length and one-byte budgets', async () => {
    const declared = response(bytes, { 'content-length': String(RSS_PHOTO_MAX_SOURCE_BYTES + 1) });
    const photo = photoSetup(async () => declared);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(declared.body.destroyed).toBe(true);
    const smallDeclared = response(bytes, { 'content-length': '4' });
    photo.request.mockResolvedValueOnce(smallDeclared);
    await expect(photo.fetch(photoUrl, new AbortController().signal, 3)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(smallDeclared.body.destroyed).toBe(true);
    const lying = response(bytes, { 'content-length': '1' });
    photo.request.mockResolvedValueOnce(lying);
    await expect(photo.fetch(photoUrl, new AbortController().signal, 3)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(lying.body.destroyed).toBe(true);
    photo.request.mockResolvedValueOnce(response(Buffer.from([1])));
    await expect(photo.fetch(photoUrl, new AbortController().signal, 1)).resolves.toEqual(Buffer.from([1]));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, RSS_PHOTO_MAX_SOURCE_BYTES + 1, '4' as unknown as number])('rejects invalid byte budget %s before DNS or requests', async maxBytes => {
    const photo = photoSetup();
    await expect(photo.fetch(photoUrl, new AbortController().signal, maxBytes)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(photo.lookup).not.toHaveBeenCalled();
    expect(photo.request).not.toHaveBeenCalled();
  });

  it.each([gzipSync, deflateSync, brotliCompressSync])('rejects compressed photos rather than misaccounting decoded batch bytes', async compress => {
    const encoding = compress === gzipSync ? 'gzip' : compress === deflateSync ? 'deflate' : 'br';
    const large = Buffer.alloc(FEED_MAX_BYTES + 1, 1);
    const compressed = compress(large);
    const reply = response(compressed, { 'content-type': 'image/png', 'content-encoding': encoding });
    const photo = photoSetup(async () => reply);
    await expect(photo.fetch(photoUrl, new AbortController().signal, large.length)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(reply.body.destroyed).toBe(true);
    const bomb = response(compressed, { 'content-encoding': encoding });
    photo.request.mockResolvedValueOnce(bomb);
    await expect(photo.fetch(photoUrl, new AbortController().signal, large.length - 1)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(bomb.body.destroyed).toBe(true);
  });

  it('rejects unaccounted compressed overhead even when decoded data would fit', async () => {
    const original = Buffer.alloc(128);
    const compressed = gzipSync(original, { level: 0 });
    expect(compressed.length).toBeGreaterThan(original.length);
    const reply = response(compressed, { 'content-encoding': 'gzip' });
    const photo = photoSetup(async () => reply);
    await expect(photo.fetch(photoUrl, new AbortController().signal, original.length)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(reply.body.destroyed).toBe(true);
  });

  it('rejects compressed response headers before reading any body bytes', async () => {
    const read = vi.fn();
    const stream = new Readable({ read });
    const photo = photoSetup(async () => ({ status: 200, headers: { 'content-encoding': ' GZIP ' }, body: stream }));
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(read).not.toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it.each([undefined, '', 'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml', 'IMAGE/AVIF; charset=binary', 'IMAGE/SVG+XML; charset=utf-8', 'IMAGE/JPEG; charset=binary', 'application/octet-stream', 'binary/octet-stream', 'application/binary'])('accepts MIME %s and leaves content validation to the preparer', async mime => {
    const photo = photoSetup(async () => response(bytes, mime === undefined ? {} : { 'content-type': mime }));
    await expect(photo.fetch(photoUrl, new AbortController().signal)).resolves.toEqual(bytes);
  });

  it.each(['image/avif', 'image/svg+xml'])('keeps byte and encoding restrictions for newly admitted MIME %s', async mime => {
    const compressed = response(gzipSync(bytes), { 'content-type': mime, 'content-encoding': 'gzip' });
    const photo = photoSetup(async () => compressed);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(compressed.body.destroyed).toBe(true);
    const oversized = response(bytes, { 'content-type': mime, 'content-length': '1' });
    photo.request.mockResolvedValueOnce(oversized);
    await expect(photo.fetch(photoUrl, new AbortController().signal, bytes.length - 1)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(oversized.body.destroyed).toBe(true);
  });

  it.each(['text/html', 'image/gif', 'IMAGE/GIF; charset=binary', 'video/mp4', 'video/webm', 'image/heic', 'image/avif-sequence', 'application/svg+xml', 'application/xml', 'application/json', 'text/plain', 'application/pdf'])('rejects MIME %s without retaining the body', async mime => {
    const reply = response('private response body', { 'content-type': mime });
    const photo = photoSetup(async () => reply);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_FEED', message: 'INVALID_FEED' });
    expect(reply.body.destroyed).toBe(true);
  });

  it.each(['zstd', 'compress', 'gzip, br'])('rejects unsupported compression %s and closes the body', async encoding => {
    const reply = response(bytes, { 'content-encoding': encoding });
    const photo = photoSetup(async () => reply);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_FEED' });
    expect(reply.body.destroyed).toBe(true);
  });

  it('accepts identity encoding and redacts transport or encoding errors', async () => {
    const photo = photoSetup(async () => response(bytes, { 'content-encoding': 'identity' }));
    await expect(photo.fetch(photoUrl, new AbortController().signal)).resolves.toEqual(bytes);
    photo.request.mockRejectedValueOnce(new Error('secret URL and response body'));
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'NETWORK', message: 'NETWORK' });
    const broken = response('not a gzip stream', { 'content-encoding': 'gzip' });
    photo.request.mockResolvedValueOnce(broken);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_FEED', message: 'INVALID_FEED' });
    expect(broken.body.destroyed).toBe(true);
  });

  it.each([204, 206, 304, 400, 401, 403, 404, 429, 500])('requires HTTP 200, not %i', async status => {
    const reply = response('private response body', {}, status);
    const photo = photoSetup(async () => reply);
    const code = status === 401 || status === 403 ? 'BLOCKED' : 'HTTP_ERROR';
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code, message: code, status });
    expect(reply.body.destroyed).toBe(true);
  });

  it.each(['https://localhost/a.jpg', 'http://127.1/a.jpg', 'http://2130706433/a.jpg', 'http://[::ffff:127.0.0.1]/a.jpg',
    'http://169.254.169.254/a.jpg', 'https://host.internal/a.jpg', 'file:///tmp/a.jpg', 'ftp://images.example.com/a.jpg',
    'https://user:password@images.example.com/a.jpg', 'https://images.example.com:8080/a.jpg', 'http://images.example.com:443/a.jpg',
    'https://images.example.com/\na.jpg',
  ])('rejects unsafe photo URL %s before DNS', async input => {
    const photo = photoSetup();
    await expect(photo.fetch(input, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(photo.lookup).not.toHaveBeenCalled();
    expect(photo.request).not.toHaveBeenCalled();
  });

  it('preserves signed queries/default ports and sends only fixed public headers across origins', async () => {
    const redirect = response('ignored', { location: 'https://other.example.com:443/a.jpg?z=9&sig=x%2By%2Fz&b=2',
      'set-cookie': ['secret-cookie'], etag: 'private-validator', 'last-modified': 'private-date' }, 302);
    const photo = photoSetup();
    photo.request.mockResolvedValueOnce(redirect);
    await photo.fetch('HTTPS://IMAGES.EXAMPLE.COM:443/photo.jpg?b=2&a=1#ignored', new AbortController().signal);
    expect(photo.request.mock.calls.map(([url]) => url.href)).toEqual([photoUrl, 'https://other.example.com/a.jpg?z=9&sig=x%2By%2Fz&b=2']);
    expect(redirect.body.destroyed).toBe(true);
    for (const [, options] of photo.request.mock.calls) {
      expect(options.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
      expect(options.headers).toEqual({ 'user-agent': 'MisakaRSS/0.1', accept: 'image/jpeg, image/png, image/webp, image/avif;q=0.9, image/svg+xml;q=0.8, application/octet-stream;q=0.5', 'accept-encoding': 'identity' });
    }
    expect(photo.request.mock.calls[0]![1].signal).toBe(photo.request.mock.calls[1]![1].signal);
    expect(photo.lookup).toHaveBeenCalledTimes(2);
    photo.request.mockResolvedValueOnce(response(bytes));
    await photo.fetch('http://images.example.com:80/a.jpg?b=2&a=1', new AbortController().signal);
    expect(photo.request.mock.lastCall![0].href).toBe('http://images.example.com/a.jpg?b=2&a=1');
  });

  it.each([{ addresses: [] }, { addresses: [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] },
    { addresses: [{ address: '198.18.1.2', family: 4 }] }])('rejects empty or non-public resolved addresses $addresses', async ({ addresses }) => {
    const photo = photoSetup();
    photo.lookup.mockResolvedValue(addresses);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(photo.request).not.toHaveBeenCalled();
  });

  it('accepts literal public IPv4/IPv6 without performing unnecessary DNS', async () => {
    const photo = photoSetup();
    await photo.fetch('https://8.8.8.8/photo.jpg', new AbortController().signal);
    await photo.fetch('https://[2606:4700:4700::1111]/photo.jpg', new AbortController().signal);
    expect(photo.lookup).not.toHaveBeenCalled();
    expect(photo.request.mock.calls[0]![1].addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect(photo.request.mock.calls[1]![1].addresses).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
  });

  it('revalidates same-host DNS after redirect to prevent rebinding', async () => {
    const redirect = response('', { location: '/second.jpg' }, 301);
    const photo = photoSetup(async () => redirect);
    photo.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(photo.request).toHaveBeenCalledTimes(1);
    expect(photo.lookup).toHaveBeenCalledTimes(2);
    expect(redirect.body.destroyed).toBe(true);
  });

  it.each(['http://169.254.169.254/photo.jpg', 'https://user:password@other.example.com/photo.jpg', 'https://other.example.com:8080/photo.jpg', 'file:///tmp/photo.jpg'])('rejects unsafe redirect %s and destroys the old response', async location => {
    const redirect = response('', { location }, 307);
    const photo = photoSetup(async () => redirect);
    await expect(photo.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(photo.request).toHaveBeenCalledTimes(1);
    expect(redirect.body.destroyed).toBe(true);
  });

  it('allows at most four redirects and rejects redirect responses with no location', async () => {
    const redirects: FeedTransportResponse[] = [];
    const photo = photoSetup(async () => {
      const reply = redirects.length < 4 ? response('', { location: '/next.jpg' }, [301, 302, 303, 308][redirects.length]!) : response(bytes);
      redirects.push(reply); return reply;
    });
    await expect(photo.fetch(photoUrl, new AbortController().signal)).resolves.toEqual(bytes);
    expect(photo.request).toHaveBeenCalledTimes(5);
    expect(photo.lookup).toHaveBeenCalledTimes(5);
    expect(redirects.every(reply => reply.body.destroyed)).toBe(true);
    const loop = photoSetup(async () => response('', { location: '/loop.jpg' }, 302));
    await expect(loop.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 302 });
    expect(loop.request).toHaveBeenCalledTimes(5);
    const missing = response('', {}, 301);
    const noLocation = photoSetup(async () => missing);
    await expect(noLocation.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 301 });
    expect(missing.body.destroyed).toBe(true);
  });

  it('bounds DNS and response-header waits and rejects pre-aborted requests before lookup', async () => {
    const dns = photoSetup(undefined, 20);
    dns.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(dns.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(dns.request).not.toHaveBeenCalled();
    const headers = photoSetup(() => new Promise(() => {}), 20);
    await expect(headers.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(headers.request.mock.calls[0]![1].signal.aborted).toBe(true);
    const caller = new AbortController(); caller.abort();
    const aborted = photoSetup();
    await expect(aborted.fetch(photoUrl, caller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(aborted.lookup).not.toHaveBeenCalled();
    expect(aborted.request).not.toHaveBeenCalled();
  });

  it.each([undefined, 'identity'])('destroys stalled %s bodies on total timeout or caller cancellation', async encoding => {
    const stalled = new Readable({ read() {} });
    const timed = photoSetup(async () => ({ status: 200, headers: { 'content-encoding': encoding }, body: stalled }), 20);
    await expect(timed.fetch(photoUrl, new AbortController().signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(stalled.destroyed).toBe(true);
    const reading = Promise.withResolvers<void>();
    const cancelled = new Readable({ read() { reading.resolve(); } });
    const photo = photoSetup(async () => ({ status: 200, headers: { 'content-encoding': encoding }, body: cancelled }));
    const caller = new AbortController();
    const rejected = expect(photo.fetch(photoUrl, caller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await reading.promise;
    caller.abort();
    await rejected;
    expect(cancelled.destroyed).toBe(true);
  });

  it('destroys a response that arrives after the caller cancelled its pending transport', async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<FeedTransportResponse>();
    const photo = photoSetup(() => { started.resolve(); return pending.promise; });
    const caller = new AbortController();
    const rejected = expect(photo.fetch(photoUrl, caller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await started.promise;
    caller.abort();
    await rejected;
    const late = response(bytes);
    pending.resolve(late);
    await vi.waitFor(() => expect(late.body.destroyed).toBe(true));
  });

  it('destroys a received response when cancellation races the awaiting continuation', async () => {
    const caller = new AbortController();
    const reply = response(bytes);
    const photo = photoSetup(() => new Promise(resolve => {
      resolve(reply);
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => caller.abort()))));
    }));
    await expect(photo.fetch(photoUrl, caller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(reply.body.destroyed).toBe(true);
  });

  it('keeps the existing DoH byte boundaries rather than using the photo allowance', async () => {
    const query = vi.fn<FeedTransport>(async () => response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }], padding: 'x'.repeat(65_536) })));
    await expect(resolvePublicAddresses('images.example.com', new AbortController().signal, query)).rejects.toMatchObject({ code: 'NETWORK' });
    query.mockImplementation(async () => response(Buffer.alloc(FEED_MAX_BYTES + 1)));
    await expect(resolvePublicAddresses('images.example.com', new AbortController().signal, query)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});

describe('RSS and Atom parsing', () => {
  it.each([
    '<media:content url="https://images.example.com/motion.gif"/>',
    '<enclosure url="https://images.example.com/motion.gif" type="application/octet-stream"/>',
    '<media:group><media:content url="https://images.example.com/motion.gif"/></media:group>',
  ])('accepts clear GIF metadata without an image MIME hint: %s', media => {
    const entry = parseFeed(`<rss xmlns:media="urn:media"><channel><item><guid>gif</guid>${media}</item></channel></rss>`, url).entries[0]!;
    expect(entry.images).toEqual(['https://images.example.com/motion.gif']);
    expect(entry.animationIndices).toEqual([0]);
    expect(entry.imagePositions).toEqual([]);
  });
  it('keeps old image-only identities when admitting previously ignored GIF metadata', () => {
    const body = '<description><![CDATA[<img src="https://images.example.com/one.jpg"/>]]></description>';
    const original = parseFeed(`<rss><channel><item>${body}</item></channel></rss>`, url).entries[0]!;
    const updated = parseFeed(`<rss><channel><item><content url="https://images.example.com/motion.gif"/>${body}</item></channel></rss>`, url).entries[0]!;
    expect(updated.id).toBe(original.id);
    expect(updated.images).toEqual(['https://images.example.com/motion.gif', 'https://images.example.com/one.jpg']);
    expect(updated.animationIndices).toEqual([0]);
    expect(updated.imagePositions).toEqual([{ offset: 0, imageIndex: 1 }]);
  });
  it('does not invent an image from a GIF-shaped feed URL when metadata has no source', () => {
    const entry = parseFeed('<rss><channel><item><guid>empty-media</guid><content/></item></channel></rss>', 'https://feeds.example.com/feed.gif').entries[0]!;
    expect(entry.images).toBeUndefined();
    expect(entry.animationIndices).toBeUndefined();
  });
  it.each([
    ['https://images.example.com/one.jpg', ['https://images.example.com/one.jpg']],
    ['/pictures/one.jpg?b=2&amp;a=1#part', ['https://feeds.example.com/pictures/one.jpg?b=2&a=1']],
    ['http://127.0.0.1/private.jpg', undefined],
  ])('retains safe Atom image content src %s', (source, images) => {
    const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>photo-1</id><title>Photo</title><content type="image/jpeg" src="${source}"/></entry></feed>`, url);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.images).toEqual(images);
  });
  it('accepts a valid empty feed', () => { expect(parseFeed(empty, url)).toEqual({ title: 'Empty feed', entries: [] }); });
  it('keeps stable IDs, full content, paragraphs and safe relative article links', () => {
    const xml = '<rss xmlns:content="urn:content"><channel><title>News</title><item><guid>001</guid><title>Title &amp; more</title><link>/article?a=1</link><content:encoded><![CDATA[<p>First</p><script>secret()</script><p>Second &amp; third</p>]]></content:encoded><pubDate>Mon, 09 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>';
    const result = parseFeed(xml, url);
    expect(result.entries[0]).toMatchObject({ title: 'Title & more', content: 'First\n\nSecond & third', url: 'https://feeds.example.com/article?a=1', publishedAt: '2026-11-09T00:00:00.000Z' });
    expect(parseFeed(xml.replace('First', 'Changed'), url).entries[0]!.id).toBe(result.entries[0]!.id);
  });
  it('handles Atom alternate links and XHTML content without script text', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>abc</id><title>Article</title><link rel="self" href="/self"/><link rel="alternate" href="/public"/><content type="xhtml"><div><p>Hello</p><script>secret</script><p>World</p></div></content></entry></feed>';
    expect(parseFeed(xml, url).entries[0]).toMatchObject({ title: 'Article', content: 'Hello\n\nWorld', url: 'https://feeds.example.com/public' });
  });
  it.each(['cdata', 'escaped', 'xhtml'] as const)('retains %s anchor labels, relative destinations and exact adjacent-text boundaries', format => {
    const body = '<p>前面<a href="../download?a=1&amp;b=2#part"><b>下载</b> 页面</a>后面普通文字</p>';
    const encoded = format === 'cdata' ? `<description><![CDATA[${body}]]></description>` : format === 'xhtml'
      ? `<content type="xhtml"><div>${body}</div></content>`
      : `<description>${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</description>`;
    const item = parseFeed(`<rss><channel><item><guid>linked</guid><link>https://news.example.com/articles/one</link>${encoded}</item></channel></rss>`, url).entries[0]!;
    expect(item.content).toBe('前面下载 页面后面普通文字');
    expect(item.contentLinks).toEqual([{ offset: 2, length: 5, url: 'https://news.example.com/download?a=1&b=2#part' }]);
    expect(item.content.slice(item.contentLinks![0]!.offset, item.contentLinks![0]!.offset + item.contentLinks![0]!.length)).toBe('下载 页面');
  });
  it('retains Unicode hrefs and normalizes whitespace without shifting link ranges', () => {
    const body = '<p>  😀 before \n <a href="https://example.com/文档#章节">  Open\t <b>this</b>\n page </a>  after  </p>';
    const item = parseFeed(`<rss><channel><item><description><![CDATA[${body}]]></description></item></channel></rss>`, url).entries[0]!;
    expect(item.content).toBe('😀 before\nOpen this\npage after');
    expect(item.contentLinks).toEqual([{ offset: 10, length: 14, url: 'https://example.com/%E6%96%87%E6%A1%A3#%E7%AB%A0%E8%8A%82' }]);
    expect(item.content.slice(10, 24)).toBe('Open this\npage');
  });
  it('leaves unsafe anchor text literal rather than retargeting a URL-shaped label', () => {
    const item = parseFeed('<rss><channel><item><description><![CDATA[<a href="javascript:alert(1)">example.com</a> 后面 <a href="http://127.0.0.1">https://safe.example.com</a><script>https://hidden.example.com</script>]]></description></item></channel></rss>', url).entries[0]!;
    expect(item.content).toBe('example.com 后面 https://safe.example.com');
    expect(item.contentLinks).toEqual([]);
  });
  it('handles prefixed Atom XHTML links, block boundaries and ignored elements', () => {
    const xml = '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:xhtml="http://www.w3.org/1999/xhtml"><entry><id>namespaced</id><link href="https://example.com/post"/><content type="xhtml"><xhtml:div><xhtml:p>before <xhtml:a href="/target#part">link</xhtml:a> after</xhtml:p><xhtml:script>secret()</xhtml:script><xhtml:style>hidden CSS</xhtml:style><xhtml:p>next<xhtml:br/>line</xhtml:p></xhtml:div></content></entry></feed>';
    expect(parseFeed(xml, url).entries[0]).toMatchObject({ content: 'before link after\n\nnext\nline',
      contentLinks: [{ offset: 7, length: 4, url: 'https://example.com/target#part' }],
    });
    expect(() => parseFeed(xml.replace('<xhtml:br/>', '<xhtml:br/>'.repeat(60)), url)).not.toThrow();
  });
  it('limits extracted links and stops at UTF-16 truncation without skipping ahead', () => {
    const body = 'x'.repeat(11_999) + '😀 next <a href="https://example.com">later</a>';
    const item = parseFeed(`<rss><channel><item><description><![CDATA[${body}]]></description></item></channel></rss>`, url).entries[0]!;
    expect(item.content).toBe('x'.repeat(11_999));
    expect(item.contentLinks).toEqual([]);
    expect(findFeedLinks('example.com '.repeat(100))).toHaveLength(FEED_MAX_LINKS);
    expect(() => parseFeed(`<feed><entry><content type="xhtml"><div>${'<section>'.repeat(60)}text${'</section>'.repeat(60)}</div></content></entry></feed>`, url)).toThrow('INVALID_FEED');
  });
  it('supports RDF feeds, deduplicates entries and rejects unsafe article links', () => {
    const item = '<item><title>Item</title><link>http://127.0.0.1/private</link><guid>unique</guid><description>Body</description></item>';
    const feed = parseFeed(`<rdf:RDF xmlns:rdf="urn:rdf"><channel><title>RDF</title></channel>${item}${item}</rdf:RDF>`, url);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).not.toHaveProperty('url');
  });
  it('distinguishes browser challenges from malformed feeds and rejects DTDs', () => {
    expect(() => parseFeed('<!DOCTYPE html><html><title>Verification - AppAgg</title><body>Verification failed.</body></html>', url)).toThrow('BLOCKED');
    expect(() => parseFeed('<html><body>Ordinary web page</body></html>', url)).toThrow('INVALID_FEED');
    expect(() => parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>', url)).toThrow('INVALID_FEED');
    expect(() => parseFeed('<rss><channel><title>broken', url)).toThrow('INVALID_FEED');
  });
  it('bounds nested XML, item counts and content size', () => {
    expect(() => parseFeed('<rss><channel>' + '<x>'.repeat(60) + '</x>'.repeat(60) + '</channel></rss>', url)).toThrow('INVALID_FEED');
    const items = Array.from({ length: 210 }, (_, i) => `<item><guid>${i}</guid><description>${'x'.repeat(100)}</description></item>`).join('');
    expect(parseFeed(`<rss><channel><title>Many</title>${items}</channel></rss>`, url).entries).toHaveLength(200);
    expect(parseFeed(`<rss><channel><title>Long</title><item><description>${'x'.repeat(20_000)}</description></item></channel></rss>`, url).entries[0]!.content).toHaveLength(12_000);
  });
});

describe('RSS image extraction', () => {
  const wrap = (item: string) => `<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="urn:content"><channel><item>${item}</item></channel></rss>`;
  const body = (images: readonly string[]) => `<description><![CDATA[${images.map(image => `<img src="${image}">`).join('')}]]></description>`;

  it.each(['html', 'enclosures'])('extracts appinn-shaped JPEG/AVIF and SVG %s sources as static photos', source => {
    const images = ['jpg', 'avif', 'svg'].map(extension => `https://img3.appinn.com/static/wp-content/uploads/2026/11/sample.${extension}`);
    const mime = ['image/jpeg', 'image/avif', 'image/svg+xml'];
    const item = source === 'html' ? body(images) : images.map((image, index) => `<enclosure url="${image}" type="${mime[index]}"/>`).join('');
    const entry = parseFeed(wrap(item), 'https://www.appinn.com/feed/').entries[0]!;
    expect(entry.images).toEqual(images);
    expect(entry.animationIndices).toEqual([]);
    expect(entry.imagePositions).toEqual(source === 'html' ? images.map((_image, imageIndex) => ({ offset: 0, imageIndex })) : []);
  });

  it.each([11, 51, 75, FEED_MAX_IMAGES])('retains all %i unique HTML images instead of capping at ten or fifty', count => {
    const images = Array.from({ length: count }, (_, index) => `https://images.example.com/${index}.jpg`);
    const entry = parseFeed(wrap(`<guid>gallery</guid>${body(images)}`), url).entries[0]!;
    expect(entry.images).toEqual(images);
    expect(entry).not.toHaveProperty('image');
  });

  it('preserves metadata priority, nested group order, and then HTML element order', () => {
    const xml = wrap(`<guid>ordered</guid>
      <enclosure type="image/jpeg" url="/enclosure.jpg"/>
      <media:content medium="image" url="/content-1.jpg"><media:thumbnail url="/content-thumb.jpg"/></media:content>
      <media:thumbnail url="/thumb-1.jpg"/><media:thumbnail url="/thumb-2.jpg"/>
      <media:content type="image/png" url="/content-2.png"/>
      <media:content medium="video" type="video/mp4" url="/movie.mp4"><media:thumbnail url="/video-thumb.jpg"/></media:content>
      <enclosure type="audio/mpeg" url="/audio.mp3"/>
      <media:group><media:content medium="image" url="/group-content.jpg"/><media:thumbnail url="/group-thumb.jpg"/>
        <media:group><media:content type="image/webp" url="/nested.webp"/></media:group>
      </media:group>
      <media:group><media:content type="image/avif" url="/next-group.avif"/></media:group>
      ${body(['/body-1.jpg', '/body-2.jpg'])}`);
    expect(parseFeed(xml, url).entries[0]!.images).toEqual([
      'thumb-1.jpg', 'thumb-2.jpg', 'content-1.jpg', 'content-thumb.jpg', 'content-2.png', 'video-thumb.jpg', 'enclosure.jpg',
      'group-thumb.jpg', 'group-content.jpg', 'nested.webp', 'next-group.avif', 'body-1.jpg', 'body-2.jpg',
    ].map(path => `https://feeds.example.com/${path}`));
  });

  it('accepts Atom image enclosures and prefixed XHTML without changing text or link ranges', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:xhtml="http://www.w3.org/1999/xhtml"><entry><id>atom-gallery</id>
      <link rel="alternate" href="https://news.example.com/articles/one"/>
      <link rel="enclosure" type="image/jpeg" href="media/first.jpg"/>
      <link rel="enclosure" type="image/png" href="media/second.png"/>
      <link rel="enclosure" type="video/mp4" href="media/video.mp4"/>
      <content type="xhtml"><xhtml:div><xhtml:p>before <xhtml:a href="../target#part">link</xhtml:a> after</xhtml:p>
        <xhtml:img src="images/body.jpg"/><xhtml:template><xhtml:img src="/ignored.jpg"/></xhtml:template>
        <xhtml:script><xhtml:img src="/script.jpg"/></xhtml:script><xhtml:img src="../last.jpg"/>
      </xhtml:div></content></entry></feed>`;
    const entry = parseFeed(xml, url).entries[0]!;
    expect(entry).toMatchObject({ content: 'before link after', contentLinks: [{ offset: 7, length: 4, url: 'https://news.example.com/target#part' }], images: [
      'https://feeds.example.com/media/first.jpg', 'https://feeds.example.com/media/second.png',
      'https://news.example.com/articles/images/body.jpg', 'https://news.example.com/last.jpg',
    ] });
    expect(entry).not.toHaveProperty('image');
  });

  it('deduplicates exact normalized URLs, preserves signed queries, and resolves each source against its own base', () => {
    const xml = wrap(`<guid>relative</guid><link>https://news.example.com/articles/one</link>
      <media:thumbnail url="HTTPS://IMAGES.EXAMPLE.COM:443/a/../photo.jpg?b=2&amp;a=1#thumb"/>
      <media:content medium="image" url="https://images.example.com/photo.jpg?b=2&amp;a=1#content"/>
      <enclosure type="image/jpeg" url="../media/photo.jpg?z=9&amp;sig=x%2By%2Fz"/>
      ${body(['https://images.example.com/photo.jpg?b=2&amp;a=1', 'https://images.example.com/photo.jpg?a=1&amp;b=2',
        '../photo.jpg?z=9&amp;sig=x%2By%2Fz', '//images.example.com/last.jpg', '../photo.jpg?z=9&amp;sig=x%2By%2Fz#duplicate'])}`);
    expect(parseFeed(xml, 'https://feeds.example.com/feeds/rss.xml').entries[0]!.images).toEqual([
      'https://images.example.com/photo.jpg?b=2&a=1', 'https://feeds.example.com/media/photo.jpg?z=9&sig=x%2By%2Fz',
      'https://images.example.com/photo.jpg?a=1&b=2', 'https://news.example.com/photo.jpg?z=9&sig=x%2By%2Fz', 'https://images.example.com/last.jpg',
    ]);
  });

  it('filters unsafe image URLs before counting and falls back to the feed base for unsafe article URLs', () => {
    const unsafe = ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://images.example.com/a.jpg',
      'http://127.0.0.1/a.jpg', 'http://2130706433/a.jpg', 'http://[::ffff:127.0.0.1]/a.jpg', 'http://169.254.169.254/a.jpg',
      'https://localhost/a.jpg', 'https://host.internal/a.jpg', 'https://user:password@images.example.com/a.jpg',
      'https://images.example.com:8080/a.jpg', 'https://images.example.com/\nprivate.jpg', 'https://images.example.com/\u202eprivate.jpg',
      'https://images.example.com/' + 'x'.repeat(2048), 'x'.repeat(2048), 'https://images.example.com/' + '\u00e9'.repeat(400)];
    const maximum = 'https://images.example.com/'.padEnd(2048, 'x');
    const entry = parseFeed(wrap(`<guid>safe</guid><link>http://127.0.0.1/article</link>
      <media:thumbnail url="http://127.0.0.1/thumbnail.jpg"/>
      <enclosure type="image/jpeg" url="https://user:pass@images.example.com/enclosure.jpg"/>
      ${body([...unsafe, '../safe.jpg', maximum])}`), url).entries[0]!;
    expect(entry.images).toEqual(['https://feeds.example.com/safe.jpg', maximum]);
    expect(entry).not.toHaveProperty('url');
    expect(parseFeed(wrap(`<guid>no-images</guid>${body(unsafe)}`), url).entries[0]).not.toHaveProperty('images');
  });

  it.each(['cdata', 'escaped', 'xhtml'] as const)('excludes ignored %s images but collects images after body truncation', format => {
    const hidden = ['script', 'style', 'template', 'iframe', 'object', 'noscript']
      .map(tag => `<${tag}><img src="/${tag}.jpg"/></${tag}>`).join('');
    const html = `<img src="/first.jpg"/><p>${'x'.repeat(11_999)}\u{1f600} next</p>${hidden}<template><div><template><img src="/nested.jpg"/></template><img src="/still-hidden.jpg"/></div></template><img src="/last.jpg"/>`;
    const content = format === 'cdata' ? `<description><![CDATA[${html}]]></description>` : format === 'xhtml'
      ? `<content type="xhtml"><div>${html}</div></content>`
      : `<description>${html.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</description>`;
    const entry = parseFeed(wrap(content), url).entries[0]!;
    expect(entry.content).toBe('x'.repeat(11_999));
    expect(entry.contentLinks).toEqual([]);
    expect(entry.images).toEqual(['https://feeds.example.com/first.jpg', 'https://feeds.example.com/last.jpg']);
  });

  it('collects alternate body images without changing selected content, links, or identity', () => {
    const primary = '<content:encoded><![CDATA[Primary <a href="/target">link</a><img src="/primary.jpg">]]></content:encoded>';
    const original = parseFeed(wrap(primary), url).entries[0]!;
    const entry = parseFeed(wrap(`${primary}<description><![CDATA[Alternate<img src="/alternate.jpg"><template><img src="/hidden.jpg"></template>]]></description>
      <summary><![CDATA[<img src="/primary.jpg"><img src="/summary.jpg">]]></summary>`), url).entries[0]!;
    expect(entry).toMatchObject({ id: original.id, content: original.content, contentLinks: original.contentLinks,
      images: ['https://feeds.example.com/primary.jpg', 'https://feeds.example.com/alternate.jpg', 'https://feeds.example.com/summary.jpg'] });
  });

  it('uses one src per image element without expanding responsive or lazy alternatives', () => {
    const entry = parseFeed(wrap('<description><![CDATA[<img src="/photo.jpg" srcset="/small.jpg 1x, /large.jpg 2x" data-src="/lazy.jpg"><img data-src="/lazy-only.jpg">]]></description>'), url).entries[0]!;
    expect(entry.images).toEqual(['https://feeds.example.com/photo.jpg']);
  });

  it('rejects excess unique images instead of silently truncating, without counting rejected or duplicate candidates', () => {
    expect(FEED_MAX_IMAGES).toBe(1000);
    const images = Array.from({ length: FEED_MAX_IMAGES }, (_, index) => `https://images.example.com/${index}.jpg`);
    expect(parseFeed(wrap(`<content:encoded>Primary</content:encoded>${body([...images, ...images, ...Array<string>(1001).fill('http://127.0.0.1/private.jpg')])}`), url).entries[0]!.images).toEqual(images);
    expect(() => parseFeed(wrap(body([...images, 'https://images.example.com/overflow.jpg'])), url)).toThrow(new FeedFetchError('TOO_LARGE'));
    expect(() => parseFeed(wrap(`<media:group>${images.map(image => `<media:content medium="image" url="${image}"/>`).join('')}</media:group>${body(['/extra.jpg'])}`), url)).toThrow(new FeedFetchError('TOO_LARGE'));
  });

  it('enforces the exact compact JSON image byte budget independently from count and feed size', () => {
    expect(FEED_MAX_IMAGE_BYTES).toBe(1024 * 1024);
    const images = Array.from({ length: 512 }, (_, index) => `https://images.example.com/${index}/`.padEnd(index === 511 ? 2044 : 2045, 'x'));
    expect(Buffer.byteLength(JSON.stringify(images))).toBe(FEED_MAX_IMAGE_BYTES);
    const xml = wrap(body(images));
    expect(Buffer.byteLength(xml)).toBeLessThan(FEED_MAX_BYTES);
    expect(parseFeed(xml, url).entries[0]!.images).toEqual(images);
    images[511] += 'x';
    expect(Buffer.byteLength(JSON.stringify(images))).toBe(FEED_MAX_IMAGE_BYTES + 1);
    expect(() => parseFeed(wrap(body(images)), url)).toThrow(new FeedFetchError('TOO_LARGE'));
    expect(() => parseFeed('x'.repeat(FEED_MAX_BYTES + 1), url)).toThrow(new FeedFetchError('TOO_LARGE'));
  });

  it('retains distinct image-only entries, deduplicates repeats, and discards empty or unsafe-only entries', () => {
    const xml = `<rss><channel><item>${body(['/first.jpg'])}</item><item>${body(['/second.jpg'])}</item>
      <item>${body(['/first.jpg#repeat'])}</item><item>${body(['http://127.0.0.1/private.jpg'])}</item><item/>
      <item>${body(['/first.jpg', '/second.jpg'])}</item></channel></rss>`;
    const entries = parseFeed(xml, url).entries;
    expect(entries.map(entry => entry.images)).toEqual([['https://feeds.example.com/first.jpg'], ['https://feeds.example.com/second.jpg'],
      ['https://feeds.example.com/first.jpg', 'https://feeds.example.com/second.jpg']]);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
    expect(parseFeed(xml, url).entries.map(entry => entry.id)).toEqual(entries.map(entry => entry.id));
    expect(entries.every(entry => entry.title === '' && entry.content === '' && entry.url === undefined)).toBe(true);
  });

  it.each([
    ['<guid>stable-guid</guid>', 'stable-guid'], ['<id>stable-atom-id</id>', 'stable-atom-id'],
    ['<link>/article</link>', 'https://feeds.example.com/article'], ['<title>Title</title>', 'Title\n'],
    ['<description>Body</description>', '\nBody'], ['<title>Title</title><description>Body</description>', 'Title\nBody'],
  ])('preserves the existing non-image identity for %s', (identity, rawId) => {
    const original = parseFeed(wrap(identity), url).entries[0]!;
    const changed = parseFeed(wrap(`${identity}<media:thumbnail url="/new.jpg"/>`), url).entries[0]!;
    expect(original.id).toBe(createHash('sha256').update(rawId).digest('hex'));
    expect(changed.id).toBe(original.id);
    expect(changed.images).toEqual(['https://feeds.example.com/new.jpg']);
    expect(original).not.toHaveProperty('images');
  });

  it('does not fetch image targets or perform image DNS lookups', async () => {
    const f = setup(async () => response(wrap(body(['https://images.example.com/first.jpg', 'https://other.example.com/second.jpg']))));
    const result = await f.fetch(url, {}, new AbortController().signal);
    expect(result.feed!.entries[0]!.images).toHaveLength(2);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(f.lookup).toHaveBeenCalledWith('feeds.example.com', expect.any(AbortSignal));
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

describe('RSS animations and image positions', () => {
  const parse = (html: string, extra = '') => parseFeed(`<rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="urn:content"><channel><item>${extra}<description><![CDATA[${html}]]></description></item></channel></rss>`, url).entries[0]!;

  it('records stable UTF-16 boundaries before pending whitespace without shifting content, links, or identity', () => {
    const html = '<p> \t\u524d\u{1f600} <img src="/one.jpg"> \n<a href="/target">\u5de6<img src="/two.jpg"> \u53f3</a><img src="/one.jpg">\u540e</p>';
    const entry = parse(html);
    const original = parse(html.replaceAll(/<img[^>]*>/g, ''));
    expect(entry.content).toBe('\u524d\u{1f600}\n\u5de6 \u53f3\u540e');
    expect(entry.imagePositions).toEqual([{ offset: 3, imageIndex: 0 }, { offset: 5, imageIndex: 1 }, { offset: 7, imageIndex: 0 }]);
    expect(entry.animationIndices).toEqual([]);
    expect(entry.contentLinks).toEqual([{ offset: 4, length: 3, url: 'https://feeds.example.com/target' }]);
    expect(entry).toMatchObject({ content: original.content, contentLinks: original.contentLinks, id: original.id });
    expect(parse('<p>Alpha</p><img src="/one.jpg"><p>Beta</p>')).toMatchObject({ content: 'Alpha\n\nBeta', imagePositions: [{ offset: 5, imageIndex: 0 }] });
  });

  it('keeps repeated start/end and image-only occurrences, and clamps positions affected by final trimming', () => {
    expect(parse('<img src="/one.jpg"><img src="/one.jpg">')).toMatchObject({ content: '', images: ['https://feeds.example.com/one.jpg'],
      imagePositions: [{ offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 0 }] });
    expect(parse('<img src="/one.jpg">A\u{1f600}<img src="/two.jpg"><img src="/one.jpg">')).toMatchObject({ content: 'A\u{1f600}',
      imagePositions: [{ offset: 0, imageIndex: 0 }, { offset: 3, imageIndex: 1 }, { offset: 3, imageIndex: 0 }] });
    expect(parse('A&nbsp;<img src="/one.jpg">')).toMatchObject({ content: 'A', imagePositions: [{ offset: 1, imageIndex: 0 }] });
    expect(parse('A\u{1f600}&nbsp;<img src="/one.jpg">')).toMatchObject({ content: 'A\u{1f600}', imagePositions: [{ offset: 3, imageIndex: 0 }] });
  });

  it('emits known-empty metadata for metadata-only and alternate-body images, but no fields on imageless entries', () => {
    expect(parse('Primary', '<media:thumbnail url="/metadata.jpg"/>')).toMatchObject({ images: ['https://feeds.example.com/metadata.jpg'], animationIndices: [], imagePositions: [] });
    expect(parse('<img src="/alternate.gif">', '<content:encoded>Primary</content:encoded>')).toMatchObject({ content: 'Primary',
      images: ['https://feeds.example.com/alternate.gif'], animationIndices: [0], imagePositions: [] });
    expect(parse('<img src="/metadata.jpg">', '<media:thumbnail url="/metadata.jpg"/>')).toMatchObject({ images: ['https://feeds.example.com/metadata.jpg'],
      imagePositions: [{ offset: 0, imageIndex: 0 }] });
    const plain = parse('Plain text');
    expect(plain).not.toHaveProperty('images');
    expect(plain).not.toHaveProperty('animationIndices');
    expect(plain).not.toHaveProperty('imagePositions');
  });

  it('collects images after truncation without fabricating positions or split-surrogate boundaries', () => {
    const entry = parse('<img src="/early.jpg">' + 'x'.repeat(11_999) + '\u{1f600}<img src="/late.gif">');
    expect(entry.content).toBe('x'.repeat(11_999));
    expect(entry.images).toEqual(['https://feeds.example.com/early.jpg', 'https://feeds.example.com/late.gif']);
    expect(entry.animationIndices).toEqual([1]);
    expect(entry.imagePositions).toEqual([{ offset: 0, imageIndex: 0 }]);
    const exact = parse('x'.repeat(12_000) + '<img src="/at-limit.jpg"> \t\nextra<img src="/beyond.jpg">');
    expect(exact.content).toHaveLength(12_000);
    expect(exact.imagePositions).toEqual([{ offset: 12_000, imageIndex: 0 }]);
    expect(exact.images).toEqual(['https://feeds.example.com/at-limit.jpg', 'https://feeds.example.com/beyond.jpg']);
    expect(parse('x'.repeat(12_000) + ' \t\n<img src="/at-limit.jpg">').imagePositions).toEqual([{ offset: 12_000, imageIndex: 0 }]);
  });

  it.each([
    ['https://images.example.com/photo.GIF?b=2&a=1', true],
    ['https://images.example.com/photo%2e%47i%46?next=.jpg', true],
    ['https://images.example.com/photo.gif#preview', true],
    ['https://images.example.com/photo.jpg?next=.gif', false],
    ['https://images.example.com/photo.jpg#.gif', false],
    ['https://images.example.com/photo.gif/more', false],
    ['https://images.example.com/photo%252egif', false],
    ['https://images.example.com/photo.gif%3fnext=.jpg', false],
    ['https://images.example.com/photo.mp4?format=gif', false],
    ['https://images.example.com/photo.webp', false], ['https://images.example.com/photo.apng', false],
    ['https://images.example.com/bad%GG.gif', true], ['https://images.example.com/bad%GG%2egif', false], ['not a URL', false],
    ['file:///tmp/photo.gif', false], ['http://127.0.0.1/photo.gif', false],
  ])('classifies GIF URL %s as %s using only its safe once-decoded pathname', (input, expected) => {
    expect(isGifImageUrl(input)).toBe(expected);
  });

  it('classifies GIF MIME metadata and upgrades duplicate image indexes without reordering signed URLs', () => {
    const entry = parse('<img src="/plain.jpg"><img src="/asset?b=2&amp;a=1"><img src="/encoded%2eGIF"><img src="/plain.jpg?next=.gif">', `
      <media:thumbnail url="/asset?b=2&amp;a=1"/><media:thumbnail url="/plain.jpg"/>
      <media:content type="image/gif" url="/third"/>
      <media:group><media:content type="IMAGE/GIF; charset=binary" url="/asset?b=2&amp;a=1#repeat"/></media:group>
      <enclosure type="video/mp4" url="/ordinary.mp4"/>
      <media:content type="image/webp" url="/static.webp"/>`);
    expect(entry.images).toEqual(['https://feeds.example.com/asset?b=2&a=1', 'https://feeds.example.com/plain.jpg',
      'https://feeds.example.com/third', 'https://feeds.example.com/static.webp', 'https://feeds.example.com/encoded%2eGIF',
      'https://feeds.example.com/plain.jpg?next=.gif']);
    expect(entry.animationIndices).toEqual([0, 2, 4]);
    expect(entry.imagePositions).toEqual([{ offset: 0, imageIndex: 1 }, { offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 4 }, { offset: 0, imageIndex: 5 }]);
  });

  it('supports GIF Atom content/enclosures and prefixed XHTML image occurrences', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="http://www.w3.org/1999/xhtml"><entry><id>gif</id>
      <link rel="alternate" href="https://news.example.com/articles/one"/><link rel="enclosure" type="image/gif" href="/asset?z=3&amp;sig=abc"/>
      <content type="xhtml"><x:div><x:p>\u{1f600}<x:img src="../animation.GiF?b=2&amp;a=1"/>text</x:p></x:div></content></entry>
      <entry><content type="image/gif" src="/external"/></entry></feed>`;
    const entries = parseFeed(xml, url).entries;
    expect(entries[0]).toMatchObject({ content: '\u{1f600}text', images: ['https://feeds.example.com/asset?z=3&sig=abc', 'https://news.example.com/animation.GiF?b=2&a=1'],
      animationIndices: [0, 1], imagePositions: [{ offset: 2, imageIndex: 1 }] });
    expect(entries[1]).toMatchObject({ images: ['https://feeds.example.com/external'], animationIndices: [0], imagePositions: [] });
  });

  it('accepts clearly GIF video/source URLs or MIME without inferring ordinary MP4 animations', () => {
    const entry = parse('A<video src="/first.GIF?b=2&amp;a=1"></video>B<video><source type="image/gif" src="/asset"></video>C' +
      '<video autoplay muted loop src="/loop.mp4"><source src="/other.mp4" type="video/mp4"></video>' +
      '<video src="/plain.jpg?next=.gif"></video><video><source src="/encoded%2eGIF"></video>' +
      '<img src="/plain.webp"><img src="/plain.apng">');
    expect(entry.content).toBe('ABC');
    expect(entry.images).toEqual(['https://feeds.example.com/first.GIF?b=2&a=1', 'https://feeds.example.com/asset',
      'https://feeds.example.com/encoded%2eGIF', 'https://feeds.example.com/plain.webp', 'https://feeds.example.com/plain.apng']);
    expect(entry.animationIndices).toEqual([0, 1, 2]);
    expect(entry.imagePositions).toEqual([{ offset: 1, imageIndex: 0 }, { offset: 2, imageIndex: 1 }, { offset: 3, imageIndex: 2 },
      { offset: 3, imageIndex: 3 }, { offset: 3, imageIndex: 4 }]);
  });

  it('allows later body MIME hints to upgrade the same image without changing the image-only ID', () => {
    const original = parse('<img src="/asset">');
    const entry = parse('<img src="/asset"><video><source type="image/gif" src="/asset#repeat"></video>');
    expect(entry).toMatchObject({ id: original.id, images: original.images, animationIndices: [0],
      imagePositions: [{ offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 0 }] });
    expect(original.animationIndices).toEqual([]);
  });

  it('preserves existing image-only IDs when GIF video/source elements add new gallery images', () => {
    const original = parse('<img src="/one.jpg"><img src="/two.jpg">');
    const entry = parse('<video src="/new.gif"></video><img src="/one.jpg"><video><source type="image/gif" src="/new-asset"></video><img src="/two.jpg">');
    expect(entry.id).toBe(original.id);
    expect(entry.images).toEqual(['https://feeds.example.com/new.gif', 'https://feeds.example.com/one.jpg', 'https://feeds.example.com/new-asset', 'https://feeds.example.com/two.jpg']);
    const reordered = parse('<video src="/two.jpg" type="image/gif"></video><img src="/one.jpg"><img src="/two.jpg">');
    expect(reordered.id).toBe(original.id);
    const videoOnly = parse('<video src="/new.gif"></video>');
    expect(videoOnly.id).toBe(createHash('sha256').update(JSON.stringify(videoOnly.images)).digest('hex'));
    expect(parse('<video src="/other.gif"></video>').id).not.toBe(videoOnly.id);
  });

  it('excludes unsafe and sanitizer-ignored GIF sources and positions', () => {
    const ignored = ['script', 'style', 'template', 'iframe', 'object', 'noscript']
      .map(tag => `<${tag}><img src="/${tag}.gif"><video src="/${tag}-video.gif"><source type="image/gif" src="/${tag}-source"></video></${tag}>`).join('');
    const entry = parse(`${ignored}<img src="http://127.0.0.1/private.gif"><video src="data:image/gif;base64,AAAA"></video>
      <source type="image/gif" src="http://169.254.169.254/private"><img src="/safe.gif">`, '<enclosure type="image/gif" url="file:///tmp/secret.gif"/>');
    expect(entry).toMatchObject({ images: ['https://feeds.example.com/safe.gif'], animationIndices: [0], imagePositions: [{ offset: 0, imageIndex: 0 }] });
  });

  it('enforces the position count independently from unique images, alternate bodies, and late images', () => {
    expect(FEED_MAX_IMAGE_POSITIONS).toBe(1000);
    const image = '<img src="/repeat.gif">';
    const entry = parse(image.repeat(FEED_MAX_IMAGE_POSITIONS));
    expect(entry.images).toEqual(['https://feeds.example.com/repeat.gif']);
    expect(entry.animationIndices).toEqual([0]);
    expect(entry.imagePositions).toEqual(Array.from({ length: FEED_MAX_IMAGE_POSITIONS }, () => ({ offset: 0, imageIndex: 0 })));
    expect(() => parse(image.repeat(FEED_MAX_IMAGE_POSITIONS + 1))).toThrow(new FeedFetchError('TOO_LARGE'));
    expect(parse(image.repeat(FEED_MAX_IMAGE_POSITIONS + 1), '<content:encoded>Primary</content:encoded>').imagePositions).toEqual([]);
    expect(parse('x'.repeat(12_001) + image.repeat(FEED_MAX_IMAGE_POSITIONS + 1)).imagePositions).toEqual([]);
    expect(parse('<img src="http://127.0.0.1/private.gif">'.repeat(1001) + image).imagePositions).toEqual([{ offset: 0, imageIndex: 0 }]);
  });
});

describe('RSS explicit URL boundaries', () => {
  it.each([
    ['访问example.com后面普通文字', 'example.com', 'https://example.com/'],
    ['请看www.example.dev以及下一段', 'www.example.dev', 'https://www.example.dev/'],
    ['前https://example.com/a?q=1&b=2#part后面的文字', 'https://example.com/a?q=1&b=2#part', 'https://example.com/a?q=1&b=2#part'],
    ['（https://example.com/a）。', 'https://example.com/a', 'https://example.com/a'],
    ['(https://en.wikipedia.org/wiki/Function_(mathematics)).', 'https://en.wikipedia.org/wiki/Function_(mathematics)', 'https://en.wikipedia.org/wiki/Function_(mathematics)'],
    ['example.app, next paragraph', 'example.app', 'https://example.app/'],
    ['https://example.com/path---after', 'https://example.com/path', 'https://example.com/path'],
    ['查看https://bücher.de/page后面的文字', 'https://bücher.de/page', 'https://xn--bcher-kva.de/page'],
    ['bücher.de普通说明', 'bücher.de', 'https://xn--bcher-kva.de/'],
    ['😀example.com👉普通文字', 'example.com', 'https://example.com/'],
  ])('isolates the link in %s', (content, label, url) => {
    const links = findFeedLinks(content);
    expect(links).toEqual([{ offset: content.indexOf(label), length: label.length, url }]);
  });
  it.each(['user@example.com', 'ftp://example.com/file', 'javascript://example.com', 'http://127.0.0.1/a', 'http://[::1]/a',
    'https://user:password@example.com/a', 'https://example.com:8080/a', 'https://host.local/a', 'example.comafter', 'v1.2.3',
    'https://example.com%2Fevil.com/a', 'example.com%2Fevil.com/a', 'https://例子example.com/a', '中文.example.com', 'https://example.com\\evil.com/a',
  ])('does not create an unsafe or ambiguous link for %s', content => {
    expect(findFeedLinks(content)).toEqual([]);
  });
  it('keeps fragment and signed parameter order without fetching linked pages', () => {
    expect(contentLinkUrl('../a?b=2&a=1#part', 'https://example.com/articles/one')).toBe('https://example.com/a?b=2&a=1#part');
    expect(contentLinkUrl('https://example.com/\nprivate')).toBeUndefined();
    expect(contentLinkUrl('https://example.com/\u202eprivate')).toBeUndefined();
    expect(findFeedLinks('https://example.com/' + 'x'.repeat(3000))).toEqual([]);
  });
});

describe('RSS rich formatting integration', () => {
  const wrap = (body: string, extra = '') => `<rss xmlns:content="urn:content" xmlns:media="urn:media"><channel><item>${extra}<description><![CDATA[${body}]]></description></item></channel></rss>`;

  it.each(['cdata', 'escaped', 'xhtml'] as const)('preserves rich blocks and anchor order from %s bodies', variant => {
    const html = '<p>before <b>bold</b> <a href="/target#part"><em>linked</em> text</a></p><pre><code class="language-zig">\tvar x = &lt;1&gt;;\n\n</code></pre>' +
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
    const encoded = variant === 'cdata' ? `<description><![CDATA[${html}]]></description>` : variant === 'xhtml' ? `<content type="xhtml"><div>${html}</div></content>`
      : `<description>${html.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</description>`;
    const entry = parseFeed(`<feed><entry><id>one</id><link href="https://news.example.com/post"/>${encoded}</entry></feed>`, url).entries[0]!;
    expect(entry.content).toBe('before bold linked text\n\n\tvar x = <1>;\n\n\n\nA\tB\n1\t2');
    expect(entry.contentLinks).toEqual([{ offset: 12, length: 11, url: 'https://news.example.com/target#part' }]);
    expect(entry.contentFormat!.blocks.map(block => block.type)).toEqual(['paragraph', 'pre', 'table']);
    expect(entry.contentFormat!.blocks[1]).toMatchObject({ language: 'zig' });
  });

  it('handles namespaced XHTML blocks and literal escaped tags without widening sanitization', () => {
    const xml = '<feed xmlns:x="http://www.w3.org/1999/xhtml"><entry><id>one</id><content type="xhtml"><x:div><x:h2>Head</x:h2>' +
      '<x:pre><x:code class="language-text">  &lt;img src="/literal.jpg"&gt;\n</x:code></x:pre><x:table><x:tr><x:td><x:img src="/actual.jpg"/></x:td><x:td>cell</x:td></x:tr></x:table>' +
      '<x:script>secret</x:script><x:template><x:img src="/hidden.jpg"/></x:template></x:div></content></entry></feed>';
    const entry = parseFeed(xml, url).entries[0]!;
    expect(entry.contentFormat!.blocks.map(block => block.type)).toEqual(['heading', 'pre', 'table']);
    expect(entry.content).toContain('  <img src="/literal.jpg">\n');
    expect(entry.content).not.toContain('secret');
    expect(entry.images).toEqual(['https://feeds.example.com/actual.jpg']);
  });

  it('reuses metadata/chosen/alternate manifest indexes and attaches only chosen-body occurrences', () => {
    const entry = parseFeed(wrap('<b>ignored alternate</b><img src="/alternate.jpg">', '<media:thumbnail url="/meta.jpg"/><enclosure url="/motion.gif"/>' +
      '<content:encoded><![CDATA[<pre><img src="/chosen.jpg">  code\n</pre><table><tr><td><a href="/article"><img src="/chosen.jpg"><img src="/meta.jpg"></a></td><td><video><source type="image/gif" src="/source"></video></td></tr></table>]]></content:encoded>'), url).entries[0]!;
    expect(entry.images).toEqual(['meta.jpg', 'motion.gif', 'chosen.jpg', 'source', 'alternate.jpg'].map(path => 'https://feeds.example.com/' + path));
    expect(entry.animationIndices).toEqual([1, 3]);
    expect(entry.contentLinks).toEqual([]);
    expect(entry.imagePositions).toEqual([{ offset: 0, imageIndex: 2 }, { offset: 9, imageIndex: 2 }, { offset: 9, imageIndex: 0 }, { offset: 10, imageIndex: 3 }]);
    const table = entry.contentFormat!.blocks[1]!;
    if (table.type !== 'table') throw new Error();
    expect(table.cells[0]!.map(cell => cell.images)).toEqual([[1, 2], [3]]);
  });

  it('never emits format for plain chosen text even if an alternate contains code or tables', () => {
    const entry = parseFeed(wrap('<pre>alternate<img src="/other.gif"></pre>', '<content:encoded><![CDATA[<p>Plain <a href="/link">link</a></p>]]></content:encoded>'), url).entries[0]!;
    expect(entry.content).toBe('Plain link');
    expect(entry.contentLinks).toEqual([{ offset: 6, length: 4, url: 'https://feeds.example.com/link' }]);
    expect(entry.contentFormat).toBeUndefined();
    expect(entry.imagePositions).toEqual([]);
    expect(entry.animationIndices).toEqual([0]);
  });

  it.each([
    ['<pre><code>  a\t b\n\n    c\n</code></pre>', 'a b\n\nc'],
    ['<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>', 'AB\n\nCD'],
    ['<pre>  ' + 'x'.repeat(13_000) + '</pre>', 'x'.repeat(12_000)],
  ])('keeps known legacy fallback hashes for code/table entries without guid or URL', (html, legacy) => {
    const entry = parseFeed(wrap(html, '<title>Title</title>'), url).entries[0]!;
    expect(entry.contentFormat).toBeDefined();
    expect(entry.id).toBe(createHash('sha256').update('Title\n' + legacy).digest('hex'));
    expect(entry.content).not.toBe(legacy);
    expect(entry.content.length).toBeLessThanOrEqual(12_000);
    const duplicates = `<rss><channel><item><title>Title</title><description><![CDATA[${html}]]></description></item>` +
      `<item><title>Title</title><description><![CDATA[${html}]]></description></item></channel></rss>`;
    expect(parseFeed(duplicates, url).entries).toHaveLength(1);
  });

  it('keeps original image-only identity even if formatting and new GIF sources are added', () => {
    const original = parseFeed(wrap('<img src="/one.jpg">'), url).entries[0]!;
    const formatted = parseFeed(wrap('<pre><video src="/new.gif"></video><img src="/one.jpg"></pre>'), url).entries[0]!;
    expect(formatted.contentFormat).toBeDefined();
    expect(formatted.id).toBe(original.id);
    expect(formatted.images).toEqual(['https://feeds.example.com/new.gif', 'https://feeds.example.com/one.jpg']);
    expect(formatted.imagePositions).toEqual([{ offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 1 }]);
  });

  it.each(['<pre> \t\n</pre>', '<table><tr><td></td><td></td></tr></table>', '<h1></h1><hr>'])('does not invent new entries from formatting-only whitespace: %s', html => {
    expect(parseFeed(wrap(html), url).entries).toEqual([]);
    expect(parseFeed(wrap(html, '<guid>existing</guid>'), url).entries[0]!.id).toBe(createHash('sha256').update('existing').digest('hex'));
  });

  it('falls back to all legacy projection fields when a table cannot be represented safely', () => {
    const entry = parseFeed(wrap('<p>before<img src="/a.jpg"></p><table><tr><td colspan="2"><a href="/link">wide</a><img src="/b.jpg"></td></tr></table>'), url).entries[0]!;
    expect(entry.contentFormat).toBeUndefined();
    expect(entry.content).toBe('before\n\nwide');
    expect(entry.contentLinks).toEqual([{ offset: 8, length: 4, url: 'https://feeds.example.com/link' }]);
    expect(entry.imagePositions).toEqual([{ offset: 6, imageIndex: 0 }, { offset: 12, imageIndex: 1 }]);
  });

  it.each([50, 64])('falls back atomically when eight %i-row tables exceed the aggregate native-block budget', rows => {
    const table = '<table><tr><td><a href="/cell">cell</a><img src="/repeat.gif"></td></tr>' +
      '<tr><td>x</td></tr>'.repeat(rows - 1) + '</table>';
    const body = '<p>Before <a href="/before">link</a><img src="/body.jpg"></p>' + table.repeat(8) +
      '<p>After <a href="/after#part">link</a> <a href="javascript:alert(1)">example.com</a><img src="/after.jpg"></p>';
    const extra = '<title>Aggregate</title><media:thumbnail url="/meta.gif"/><summary><![CDATA[Alternate<img src="/alternate.gif">]]></summary>';
    // p/span preserves the old table-row text projection, without requesting any rich formatting.
    const legacyBody = body.replaceAll(/<\/?table>/g, '').replaceAll('<tr>', '<p>').replaceAll('</tr>', '</p>')
      .replaceAll('<td>', '<span>').replaceAll('</td>', '</span>');
    const legacy = parseFeed(wrap(legacyBody, extra), url).entries[0]!;
    const entry = parseFeed(wrap(body, extra), url).entries[0]!;
    expect(legacy).not.toHaveProperty('contentFormat');
    expect(entry).not.toHaveProperty('contentFormat');
    expect(entry).toEqual(legacy);
    expect(entry.id).toBe(createHash('sha256').update(`Aggregate\n${legacy.content}`).digest('hex'));
    expect(entry.content).toBe(['Before link', ...Array.from({ length: 8 }, () => ['cell', ...Array<string>(rows - 1).fill('x')]).flat(), 'After link example.com'].join('\n\n'));
    expect(entry.contentLinks!.map(link => link.url)).toEqual(['/before', ...Array<string>(8).fill('/cell'), '/after#part'].map(path => 'https://feeds.example.com' + path));
    expect(entry.images).toEqual(['meta.gif', 'body.jpg', 'repeat.gif', 'after.jpg', 'alternate.gif'].map(path => 'https://feeds.example.com/' + path));
    expect(entry.animationIndices).toEqual([0, 2, 4]);
    expect(entry.imagePositions!.map(position => position.imageIndex)).toEqual([1, ...Array<number>(8).fill(2), 3]);
  });

  it('preserves existing malicious HTML/XML and image limits rather than turning them into format fallback', () => {
    expect(() => parseFeed(wrap('<b>x</b>' + '<br>'.repeat(20_000)), url)).toThrow(new FeedFetchError('INVALID_FEED'));
    expect(() => parseFeed(wrap('<section>'.repeat(49) + '<pre>x</pre>' + '</section>'.repeat(49)), url)).toThrow(new FeedFetchError('INVALID_FEED'));
    expect(() => parseFeed(wrap('<pre>' + '<img src="/same.jpg">'.repeat(1001) + '</pre>'), url)).toThrow(new FeedFetchError('TOO_LARGE'));
    expect(() => parseFeed(wrap('<b>' + 'x'.repeat(FEED_MAX_BYTES) + '</b>'), url)).toThrow(new FeedFetchError('TOO_LARGE'));
  });
});
