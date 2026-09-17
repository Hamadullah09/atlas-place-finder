import dns from 'node:dns';
import https from 'node:https';
import { isIP } from 'node:net';
import { config } from '../config.js';

/**
 * Downloading from arbitrary websites without handing them the local network.
 *
 * Most imagery comes from a fixed set of hosts and is checked against an
 * allowlist. Web image search is the exception: its results point at whatever
 * site published the photo, so an allowlist cannot apply. A URL from there
 * could just as well name a router, a printer or a cloud metadata service, and
 * this process would dutifully fetch it. So those downloads are held to a
 * different rule -- the address actually connected to must be public.
 *
 * The check runs inside the socket's own DNS lookup rather than before it, so
 * the address that was validated is the address that is used. Resolving first
 * and fetching afterwards would let a hostile DNS server answer "public" to the
 * check and "private" to the connection.
 */

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 45_000;

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. broadcast
];

/** True for any address that is not a routable public internet address. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    return PRIVATE_V4.some(([base, bits]) => inIpv4Range(address, base, bits));
  }

  if (version === 6) {
    const lower = address.toLowerCase();

    // An IPv4 address wearing IPv6 clothes is judged as IPv4.
    const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
      ?? /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);

    if (lower === '::' || lower === '::1') return true;
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
    if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true; // documentation
    return false;
  }

  // Not an address at all; nothing to connect to.
  return true;
}

/** Names that never belong to a public site, whatever DNS says. */
function isLocalName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan')
    || host.endsWith('.home.arpa');
}

/**
 * The lookup the socket uses. Rejecting here, rather than beforehand, is what
 * makes the check binding: this is the answer the connection is made with.
 */
const guardedLookup: typeof dns.lookup = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((entry) => isPrivateAddress(entry.address));
    if (list.length === 0 || blocked) {
      const reason = blocked ? `resolves to non-public address ${blocked.address}` : 'did not resolve';
      callback(Object.assign(new Error(`refusing ${hostname}: ${reason}`), { code: 'EPRIVATE' }), '', 0);
      return;
    }
    if (options.all) {
      callback(null, list);
      return;
    }
    callback(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dns.lookup;

/** Validates what can be judged from the URL alone, before any network use. */
export function checkPublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('not a valid URL');
  }

  if (url.protocol !== 'https:') throw new Error('only https images are fetched');
  if (url.username || url.password) throw new Error('credentials in image URLs are refused');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new Error(`refusing non-public address ${host}`);
  if (!isIP(host) && isLocalName(host)) throw new Error(`refusing local hostname ${host}`);

  return url;
}

function getOnce(url: URL): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  const maxBytes = config.limits.maxImageBytes;

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: guardedLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': config.userAgent,
        Accept: 'image/*',
      },
    }, (response) => {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, location: response.headers.location, contentType: '', body: Buffer.alloc(0) });
        return;
      }

      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        reject(new Error(`image is ${declared} bytes, over the ${maxBytes} limit`));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(new Error(`image exceeded the ${maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status,
        contentType: String(response.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });

    request.on('timeout', () => request.destroy(new Error('image download timed out')));
    request.on('error', reject);
  });
}

/**
 * Downloads an image from an untrusted origin.
 *
 * Redirects are followed by hand so that every hop goes through the same
 * check; letting the client follow them would let a public URL bounce the
 * request somewhere private.
 */
export async function fetchPublicImage(value: string): Promise<{ buffer: Buffer; contentType: string }> {
  let current = checkPublicHttpsUrl(value);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await getOnce(current);

    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error(`redirect without a location (${response.status})`);
      current = checkPublicHttpsUrl(new URL(response.location, current).href);
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`image request failed with status ${response.status}`);
    }
    if (!response.contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`not an image (${response.contentType || 'no content type'})`);
    }

    return { buffer: response.body, contentType: response.contentType };
  }

  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
