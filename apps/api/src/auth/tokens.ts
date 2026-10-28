import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export const ENV = Symbol('ENV');

export interface AccessClaims {
  sub: string;
  typ: 'user' | 'device';
  /** Para tokens de dispositivo: usuario titular. */
  uid?: string;
}

const enc = (s: string) => new TextEncoder().encode(s);

export async function signAccess(secret: string, claims: AccessClaims, ttlS: number): Promise<string> {
  return new SignJWT({ typ: claims.typ, ...(claims.uid ? { uid: claims.uid } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('geo-api')
    .setAudience(claims.typ === 'device' ? 'geo-device' : 'geo-user')
    .setExpirationTime(`${ttlS}s`)
    .sign(enc(secret));
}

export async function verifyAccess(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, enc(secret), { issuer: 'geo-api', audience: ['geo-user', 'geo-device'], algorithms: ['HS256'] });
  const typ = payload.typ;
  if ((typ !== 'user' && typ !== 'device') || typeof payload.sub !== 'string') throw new Error('token inválido');
  return { sub: payload.sub, typ, uid: typeof payload.uid === 'string' ? payload.uid : undefined };
}

/** Token opaco aleatorio (refresh, reset). Solo se guarda su hash. */
export function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}
