/**
 * A software WebAuthn authenticator for the passkey tests: an ES256 key pair
 * that answers registration ("none" attestation) and authentication requests
 * the way a browser and a platform authenticator would, with or without user
 * verification.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

function b64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function uint16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export type SoftAuthenticatorOptions = {
  origin: string;
  rpId: string;
  /** Whether the authenticator verifies the person (PIN, biometrics). */
  userVerified?: boolean;
};

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;
  private userHandle: string | null = null;
  userVerified: boolean;

  constructor(private readonly options: SoftAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.userVerified = options.userVerified ?? true;
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private coseKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]));
  }

  private flags(attested: boolean): number {
    return FLAG_UP | (this.userVerified ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | (attested ? FLAG_AT : 0);
  }

  /** The browser's answer to navigator.credentials.create() with these options. */
  register(creation: { challenge: string; user?: { id?: string } }, origin = this.options.origin): Record<string, unknown> {
    this.userHandle = creation.user?.id ?? null;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: creation.challenge, origin, crossOrigin: false,
    }));
    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags(true)]),
      uint32(this.counter),
      Buffer.alloc(16), // AAGUID: none
      uint16(this.credentialId.length),
      this.credentialId,
      Buffer.from(this.coseKey()),
    ]);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', new Uint8Array(authData)],
    ]) as never);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The browser's answer to navigator.credentials.get() with these options. */
  authenticate(request: { challenge: string }, origin = this.options.origin): Record<string, unknown> {
    this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: request.challenge, origin, crossOrigin: false,
    }));
    const authenticatorData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags(false)]),
      uint32(this.counter),
    ]);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
