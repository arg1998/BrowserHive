/** @module domain/auth/cookie — session cookie name, attributes as data, and header parsing (spec 03 §3.3). */

/** Name of the operator session cookie. */
export const SESSION_COOKIE_NAME = 'browserhive_session';
/** `Max-Age` of the session cookie: the 8-hour absolute lifetime, in seconds. */
export const SESSION_COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Cookie attributes, kept as data so no HTTP framework leaks into the app layer. */
export interface CookieAttributes {
  readonly httpOnly: true;
  readonly sameSite: 'Strict';
  readonly path: '/';
  /** Set only when the request arrived over HTTPS (trusted proxy `X-Forwarded-Proto: https`). */
  readonly secure: boolean;
  /** Seconds; `0` clears the cookie. */
  readonly maxAge: number;
}

/** A cookie ready to serialize into `Set-Cookie`. */
export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly attributes: CookieAttributes;
}

/** The session cookie for a freshly minted token. */
export function sessionCookie(token: string, options: { readonly secure: boolean }): SetCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    attributes: {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure: options.secure,
      maxAge: SESSION_COOKIE_MAX_AGE_S,
    },
  };
}

/** A cookie that clears the session (logout). */
export function clearSessionCookie(options: { readonly secure: boolean }): SetCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: '',
    attributes: {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      secure: options.secure,
      maxAge: 0,
    },
  };
}

/** Renders a {@link SetCookie} as a `Set-Cookie` header value. */
export function serializeCookie(cookie: SetCookie): string {
  const parts = [`${cookie.name}=${cookie.value}`, `Max-Age=${cookie.attributes.maxAge}`];
  parts.push(`Path=${cookie.attributes.path}`, `SameSite=${cookie.attributes.sameSite}`);
  if (cookie.attributes.httpOnly) parts.push('HttpOnly');
  if (cookie.attributes.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Parses a `Cookie` request header into a name → value map (first occurrence wins). */
export function parseCookieHeader(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const name = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (name.length > 0 && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** The session token carried by a `Cookie` header, or `undefined`. */
export function sessionTokenFromCookie(header: string | undefined): string | undefined {
  const value = parseCookieHeader(header).get(SESSION_COOKIE_NAME);
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Extracts the token of an `Authorization: Bearer <token>` header (case-insensitive scheme, surrounding whitespace trimmed). */
export function bearerTokenFromHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}
