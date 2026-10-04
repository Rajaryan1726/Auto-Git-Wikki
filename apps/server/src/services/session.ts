import { SignJWT, jwtVerify } from 'jose';
import { SESSION_TTL_SECONDS } from '../lib/cookies.js';
import { env } from '../lib/env.js';

const ISSUER = 'autowiki';
const secret = new TextEncoder().encode(env.SESSION_JWT_SECRET);

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

/** Returns the user id for a valid session token, or null if invalid/expired. */
export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ['HS256'] });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
