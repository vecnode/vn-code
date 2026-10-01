/**
 * dsh-browser — the URL and destination policy, as a PURE module.
 *
 * Everything about "may this page be loaded at all" lives here, with no socket,
 * no clock and no filesystem, so the tracked check can drive the whole table
 * directly and the gate, the tools and the tab cannot disagree about a rule.
 *
 * The rules, and why each one is here:
 *
 *   - **https only.** A browser that shows a page to a user who is signed into
 *     this harness has no business rendering a plaintext document: `http:` is
 *     refused by name, and so is every other scheme (`file:`, `data:`, `blob:`,
 *     `javascript:`, `ftp:`), because a URL scheme is an instruction.
 *   - **port 443 only** by default. A page on `:8443` is reachable, but it is
 *     reachable *inside* a network, which is the definition of the surface this
 *     policy exists to keep closed. `ports` is config, defaulting to `[443]`.
 *   - **no credentials in the URL.** `https://user:pass@host/` puts a secret in
 *     the address bar, in the render history and in the tool call.
 *   - **no IP-literal hosts.** A literal needs no resolution, so it is the
 *     cheapest way to aim a fetch at a loopback or private service; refusing all
 *     of them costs nothing a public hostname cannot do.
 *   - **a qualified public hostname.** Two or more DNS labels, so `localhost`,
 *     `intranet` and `router` are refused before anything is resolved.
 *   - **public-unicast addresses only, and the WHOLE answer set must be public.**
 *     One private address in a round-robin answer is enough to send a request to
 *     the wrong place, so the set is refused as a unit - the same rule the
 *     harness's own `web-fetch-http` transport applies (`resolvePublicAddresses`
 *     rejects the complete answer set, then pins the connection to what it
 *     validated, so a second lookup cannot rebind the name).
 *   - **an empty allowlist means "any public host"**, and a non-empty one means
 *     only those hosts: the deployment can narrow the browser to an intranet's
 *     public namespace without any code change. A blocklist is always honoured.
 *
 * This module deliberately does NOT mirror the harness's fetch transport: it
 * cannot, because a real browser engine resolves and connects for itself. The
 * gate applies these checks per connection instead, which is why the rules have
 * to be stated here as data a socket handler can consult.
 */

/** The longest URL this policy will look at, matching the harness's own cap. */
export const MAX_URL_LENGTH = 2048

/** The only port a URL may name unless the deployment configures more. */
export const DEFAULT_PORTS = [443]

/**
 * One code per refusal. The code is the machine-readable half (the tab colours
 * by it, the tools report it) and `refusalMessage` is the sentence a person
 * reads; keeping them apart means a message can be improved without breaking a
 * consumer that keys on the code.
 */
export const REFUSAL = {
  MALFORMED: 'MALFORMED_URL',
  TOO_LONG: 'URL_TOO_LONG',
  NOT_HTTPS: 'HTTPS_ONLY',
  CREDENTIALS: 'CREDENTIALS_REFUSED',
  PORT: 'PORT_REFUSED',
  LITERAL: 'IP_LITERAL_REFUSED',
  NOT_QUALIFIED: 'PUBLIC_HOSTNAME_REQUIRED',
  HOST_BLOCKED: 'HOST_BLOCKLISTED',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWLISTED',
  NO_ADDRESS: 'DESTINATION_UNRESOLVED',
  NOT_PUBLIC: 'DESTINATION_NOT_PUBLIC',
}

/**
 * The user-facing sentence for one refusal.
 * @param code - one of {@link REFUSAL}.
 * @param details - `host`, `port`, `scheme`, `address`, `length` when known.
 * @returns a sentence naming what was refused and what to do instead.
 */
export function refusalMessage(code, details = {}) {
  const host = details.host ? String(details.host) : 'that address'
  switch (code) {
    case REFUSAL.MALFORMED:
      return 'That is not a URL the browser can read. Give an address like https://example.com/page.'
    case REFUSAL.TOO_LONG:
      return 'That URL is ' + String(details.length ?? '?') + ' characters; the browser accepts up to ' + String(MAX_URL_LENGTH) + '.'
    case REFUSAL.NOT_HTTPS:
      return 'This browser only navigates the secure web: https:// only' + (details.scheme ? ', not ' + String(details.scheme) + ':' : '') + '. A plaintext page can be altered in transit, and this browser runs beside a signed-in harness session.'
    case REFUSAL.CREDENTIALS:
      return 'That URL carries a username or password. Credentials are refused in an address: they would be stored in the render history and shown in the tool call.'
    case REFUSAL.PORT:
      return 'This browser only reaches port 443 (https), not port ' + String(details.port ?? '?') + '. Other ports reach services inside the network, which is the surface this policy keeps closed.'
    case REFUSAL.LITERAL:
      return 'This browser refuses an IP-literal address (' + host + '). A literal needs no resolution, so it is the shortest path to a private service; use a public hostname instead.'
    case REFUSAL.NOT_QUALIFIED:
      return '"' + host + '" is not a qualified public hostname. A single-label name like localhost or intranet resolves inside this machine or this network, so it is refused before anything is looked up.'
    case REFUSAL.HOST_BLOCKED:
      return '"' + host + '" is on this deployment\u2019s blocklist.'
    case REFUSAL.HOST_NOT_ALLOWED:
      return '"' + host + '" is not on this deployment\u2019s allowlist, and that allowlist is in force.'
    case REFUSAL.NO_ADDRESS:
      return '"' + host + '" did not resolve to any address.'
    case REFUSAL.NOT_PUBLIC:
      return '"' + host + '" resolves to ' + String(details.address ?? 'a non-public address') + ', which is loopback, private, link-local or otherwise not a public internet destination. The whole answer set is refused, because one private address in a round-robin is enough to send a request somewhere it must not go.'
    default:
      return 'That destination is refused by this browser\u2019s policy.'
  }
}

/** One refusal in the shape every caller passes around. */
function refuse(code, details = {}) {
  return { ok: false, code, message: refusalMessage(code, details), details }
}

/**
 * Lower-case a URL hostname and drop the DNS root dot.
 * @param host - a URL's `hostname`, possibly bracketed for IPv6.
 * @returns the comparable form.
 */
export function normalizeHost(host) {
  let text = String(host ?? '').trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (text.endsWith('.')) text = text.slice(0, -1)
  return text
}

/**
 * Whether a host is a literal IPv4 or IPv6 address rather than a name.
 * @param host - a normalized host.
 * @returns true for `127.0.0.1`, `::1`, `2001:db8::1` and the like.
 */
export function isIpLiteral(host) {
  const text = String(host ?? '')
  if (text.includes(':')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(text)
}

/**
 * Whether a host matches one entry of an allow/block list: either the exact
 * host, or a `*.suffix` wildcard, which matches subdomains but never the bare
 * suffix itself (`*.example.com` does not match `example.com`).
 * @param host - a normalized host.
 * @param patterns - the list.
 * @returns true when any pattern matches.
 */
export function hostMatches(host, patterns) {
  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const pattern = normalizeHost(raw)
    if (pattern === '') continue
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      if (suffix !== '' && host.length > suffix.length + 1 && host.endsWith('.' + suffix)) return true
      continue
    }
    if (host === pattern) return true
  }
  return false
}

/**
 * Validate one URL against the network-independent policy: https, no embedded
 * credentials, an allowed port, a qualified hostname that is not an IP literal,
 * and the deployment's own lists.
 *
 * A bare host (`example.com`, `example.com/x`) is read as https, because that is
 * what a person means when they type it into an address bar; an explicit scheme
 * is never rewritten.
 *
 * @param input - the raw address.
 * @param options - `ports`, `allowHosts`, `blockHosts` (all optional).
 * @returns `{ok: true, url, host, port}` or a refusal.
 */
export function parseTargetUrl(input, options = {}) {
  const ports = Array.isArray(options.ports) && options.ports.length > 0 ? options.ports.map(Number) : DEFAULT_PORTS
  const allowHosts = Array.isArray(options.allowHosts) ? options.allowHosts : []
  const blockHosts = Array.isArray(options.blockHosts) ? options.blockHosts : []
  const raw = String(input ?? '').trim()
  if (raw === '') return refuse(REFUSAL.MALFORMED, { input: raw })
  if (raw.length > MAX_URL_LENGTH) return refuse(REFUSAL.TOO_LONG, { length: raw.length })
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ? raw : 'https://' + raw
  let url
  try {
    url = new URL(withScheme)
  } catch (err) {
    return refuse(REFUSAL.MALFORMED, { input: raw })
  }
  if (url.protocol !== 'https:') return refuse(REFUSAL.NOT_HTTPS, { scheme: url.protocol.replace(':', '') })
  if (url.username !== '' || url.password !== '') return refuse(REFUSAL.CREDENTIALS, { host: normalizeHost(url.hostname) })
  const port = url.port === '' ? 443 : Number(url.port)
  if (!ports.includes(port)) return refuse(REFUSAL.PORT, { port })
  const host = normalizeHost(url.hostname)
  if (host === '') return refuse(REFUSAL.MALFORMED, { input: raw })
  if (isIpLiteral(host)) return refuse(REFUSAL.LITERAL, { host })
  // Two or more labels, each a legal DNS label: this is what refuses
  // `localhost`, `intranet`, `router` and a trailing-dot trick.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return refuse(REFUSAL.NOT_QUALIFIED, { host })
  }
  if (blockHosts.length > 0 && hostMatches(host, blockHosts)) return refuse(REFUSAL.HOST_BLOCKED, { host })
  if (allowHosts.length > 0 && !hostMatches(host, allowHosts)) return refuse(REFUSAL.HOST_NOT_ALLOWED, { host })
  return { ok: true, url: url.href, host, port }
}

/** One CIDR: the leading bytes and the prefix length. */
const V4_BLOCKED = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, including the 169.254.169.254 metadata service
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, 255.255.255.255 included
]

/**
 * IPv6 ranges this policy refuses. Translation and transition prefixes are
 * blocked outright rather than classified: their eventual IPv4 destination is
 * not visible in the address, so it cannot be validated here.
 */
const V6_BLOCKED = [
  [[0x00, 0x64, 0xff, 0x9b], 96], // 64:ff9b::/96 NAT64
  [[0x20, 0x01, 0x00, 0x00], 32], // 2001::/32 Teredo
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 2001:db8::/32 documentation
  [[0x20, 0x02], 16], // 6to4
  [[0x01, 0x00], 64], // 100::/64 discard-only
  [[0xfc], 7], // unique local
  [[0xfe, 0x80], 10], // link-local
  [[0xff], 8], // multicast
]

/** Whether `bytes` falls inside one CIDR. A short prefix implies zero bytes. */
function inCidr(bytes, prefix, bits) {
  const whole = bits >> 3
  for (let i = 0; i < whole; i++) if (bytes[i] !== (prefix[i] ?? 0)) return false
  const rest = bits & 7
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (bytes[whole] & mask) === ((prefix[whole] ?? 0) & mask)
}

/** Parse one dotted-quad. Leading zeros are refused: `010.0.0.1` is ambiguous. */
function parseV4(text) {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i]
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part[0] === '0') return null
    const value = Number(part)
    if (value > 255) return null
    bytes[i] = value
  }
  return { family: 4, bytes }
}

/** Parse one IPv6 address, `::` compression and a trailing IPv4 form included. */
function parseV6(text) {
  const firstDouble = text.indexOf('::')
  if (firstDouble !== text.lastIndexOf('::')) return null
  let headText = text
  let tailText = ''
  const compressed = firstDouble !== -1
  if (compressed) {
    headText = text.slice(0, firstDouble)
    tailText = text.slice(firstDouble + 2)
  }
  const groups = []
  const push = (parts) => {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1 && part.includes('.')) {
        const v4 = parseV4(part)
        if (v4 === null) return false
        groups.push((v4.bytes[0] << 8) | v4.bytes[1], (v4.bytes[2] << 8) | v4.bytes[3])
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false
      groups.push(Number.parseInt(part, 16))
    }
    return true
  }
  if (!push(headText === '' ? [] : headText.split(':'))) return null
  const headLength = groups.length
  if (!push(tailText === '' ? [] : tailText.split(':'))) return null
  const tailLength = groups.length - headLength
  if (compressed) {
    // `::` must stand for at least one group.
    if (headLength + tailLength > 7) return null
  } else if (groups.length !== 8) {
    return null
  }
  const full = compressed
    ? [...groups.slice(0, headLength), ...new Array(8 - headLength - tailLength).fill(0), ...groups.slice(headLength)]
    : groups
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (full[i] >> 8) & 0xff
    bytes[i * 2 + 1] = full[i] & 0xff
  }
  return { family: 6, bytes }
}

/**
 * Parse a textual address into its bytes, or `null` when it is not one.
 * A zone id (`fe80::1%eth0`) is refused: it names an interface, not a destination.
 * @param input - an IPv4 or IPv6 address.
 * @returns `{family, bytes}` or null.
 */
export function parseAddress(input) {
  const text = String(input ?? '').trim()
  if (text === '' || text.includes('%')) return null
  return text.includes(':') ? parseV6(text) : parseV4(text)
}

/** Whether four already-parsed bytes are a public unicast IPv4 destination. */
function isPublicV4(bytes) {
  for (const [prefix, bits] of V4_BLOCKED) if (inCidr(bytes, prefix, bits)) return false
  return true
}

/**
 * Whether one address is a globally reachable public unicast destination.
 * IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible IPv6 are classified by the
 * address they embed. An address this cannot parse is NOT public: an unreadable
 * destination is refused, not trusted.
 * @param input - an address string, or a parsed `{family, bytes}`.
 * @returns true only for a public unicast destination.
 */
export function isPublicAddress(input) {
  const parsed = typeof input === 'string' ? parseAddress(input) : input
  if (parsed === null || parsed === undefined || !parsed.bytes) return false
  const bytes = parsed.bytes
  if (parsed.family === 4) return isPublicV4(bytes)
  let allZero = true
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== 0) {
      allZero = false
      break
    }
  }
  if (allZero) return false // ::
  let compatible = true
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== 0) {
      compatible = false
      break
    }
  }
  if (compatible) return isPublicV4(bytes.slice(12, 16)) // ::a.b.c.d (deprecated form)
  let mapped = bytes[10] === 0xff && bytes[11] === 0xff
  if (mapped) {
    for (let i = 0; i < 10; i++) {
      if (bytes[i] !== 0) {
        mapped = false
        break
      }
    }
  }
  if (mapped) return isPublicV4(bytes.slice(12, 16)) // ::ffff:a.b.c.d
  return !V6_BLOCKED.some(([prefix, bits]) => inCidr(bytes, prefix, bits))
}

/**
 * Validate the complete answer set for one hostname. The set is refused as a
 * unit when ANY entry is not public, so a round-robin answer cannot smuggle one
 * private destination past a check that only looked at the first.
 * @param host - the hostname the set belongs to (for the message).
 * @param addresses - resolver answers, as strings or `{address}` objects.
 * @returns `{ok: true, addresses}` or a refusal.
 */
export function checkAddresses(host, addresses) {
  const list = (Array.isArray(addresses) ? addresses : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.address))
    .filter((value) => typeof value === 'string' && value !== '')
  if (list.length === 0) return refuse(REFUSAL.NO_ADDRESS, { host })
  for (const address of list) {
    if (!isPublicAddress(address)) return refuse(REFUSAL.NOT_PUBLIC, { host, address })
  }
  return { ok: true, addresses: list }
}

/**
 * The policy as a plain snapshot, for a route or a tool result that has to state
 * what is in force rather than describe it.
 * @param options - the same `ports` / `allowHosts` / `blockHosts` configuration.
 * @returns the effective rules.
 */
export function policySnapshot(options = {}) {
  return {
    schemes: ['https'],
    ports: Array.isArray(options.ports) && options.ports.length > 0 ? options.ports.map(Number) : DEFAULT_PORTS,
    allowHosts: Array.isArray(options.allowHosts) ? options.allowHosts.map(normalizeHost).filter(Boolean) : [],
    blockHosts: Array.isArray(options.blockHosts) ? options.blockHosts.map(normalizeHost).filter(Boolean) : [],
    ipLiterals: 'refused',
    destinations: 'public unicast only, whole answer set',
    maxUrlLength: MAX_URL_LENGTH,
  }
}
