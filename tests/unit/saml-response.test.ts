/**
 * Verifying SAML responses (ee/saml/response.ts) with responses signed
 * in-process by a test identity provider (tests/helpers/saml-idp.ts):
 * signatures, XML signature wrapping, algorithms, time, audience,
 * recipient, destination, issuer, InResponseTo and IdP-initiated responses.
 * No database: the caller's binding and replay checks are covered in
 * saml-sign-in.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { serviceProviderUrls } from '@/ee/saml/store';
import { SamlResponseError, decodeSamlResponse, verifySamlResponse, type ExpectedResponse } from '@/ee/saml/response';
import {
  ALGORITHMS,
  EMAIL_FORMAT,
  IDP_ENTITY_ID,
  buildResponseXml,
  createTestKey,
  encode,
  injectNameIdComment,
  newId,
  signResponse,
  signedResponse,
  tamperNameId,
  wrapAssertion,
  wrapResponse,
  type ResponseOptions,
  type TestKey,
  type WrappingVariant,
} from '../helpers/saml-idp';

const PROVIDER_ID = 7;
const sp = serviceProviderUrls(PROVIDER_ID);

let idp: TestKey;
let rolledOver: TestKey;
let attacker: TestKey;

beforeAll(() => {
  idp = createTestKey('idp.example.com');
  rolledOver = createTestKey('idp-next.example.com');
  attacker = createTestKey('attacker.example.org');
});

function expected(requestId: string, overrides: Partial<ExpectedResponse> = {}): ExpectedResponse {
  return {
    provider: { id: PROVIDER_ID, idpEntityId: IDP_ENTITY_ID, idpCertificates: [idp.certificate] },
    requestId,
    requestCreatedAt: Date.now() - 5_000,
    ...overrides,
  };
}

function options(requestId: string | null, overrides: Partial<ResponseOptions> = {}): ResponseOptions {
  return { sp, requestId, nameId: 'subject-alice', attributes: { email: 'alice@example.com' }, ...overrides };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SamlResponseError) return error.reason;
    throw error;
  }
  throw new Error('the response was accepted');
}

describe('signatures', () => {
  it('accepts a response whose assertion is signed by the provider certificate', async () => {
    const requestId = newId();
    const identity = await verifySamlResponse(signedResponse({ ...options(requestId), key: idp }), expected(requestId));
    expect(identity).toMatchObject({ issuer: IDP_ENTITY_ID, nameId: 'subject-alice', nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' });
    expect(identity.attributes.get('email')).toEqual(['alice@example.com']);
    expect(identity.assertionId).toMatch(/^_[0-9a-f]+$/);
    expect(identity.replayUntil).toBeGreaterThan(Date.now());
  });

  it('accepts a signature on the Response only (Keycloak default), and on both', async () => {
    for (const target of ['response', 'both'] as const) {
      const requestId = newId();
      const identity = await verifySamlResponse(signedResponse({ ...options(requestId), key: idp, target }), expected(requestId));
      expect(identity.nameId).toBe('subject-alice');
    }
  });

  it('accepts any of several certificates (rollover)', async () => {
    const requestId = newId();
    const identity = await verifySamlResponse(
      signedResponse({ ...options(requestId), key: rolledOver }),
      expected(requestId, { provider: { id: PROVIDER_ID, idpEntityId: IDP_ENTITY_ID, idpCertificates: [idp.certificate, rolledOver.certificate] } })
    );
    expect(identity.nameId).toBe('subject-alice');
  });

  it('refuses an unsigned response', async () => {
    const requestId = newId();
    expect(await reasonOf(verifySamlResponse(encode(buildResponseXml(options(requestId))), expected(requestId)))).toBe('signature');
  });

  it('refuses a response signed with another key, even with that key\'s certificate in KeyInfo', async () => {
    const requestId = newId();
    for (const target of ['assertion', 'response', 'both'] as const) {
      expect(await reasonOf(verifySamlResponse(signedResponse({ ...options(requestId), key: attacker, target }), expected(requestId)))).toBe('signature');
    }
  });

  it('refuses a signed assertion changed after signing', async () => {
    const requestId = newId();
    const signed = signResponse(buildResponseXml(options(requestId)), { key: idp, target: 'assertion' });
    expect(await reasonOf(verifySamlResponse(encode(tamperNameId(signed, 'subject-mallory')), expected(requestId)))).toBe('signature');
  });

  it('reads the signed value of a NameID split by a comment, never the part before it', async () => {
    const requestId = newId();
    const signed = signResponse(
      buildResponseXml(options(requestId, { nameId: 'admin@example.com.attacker.test', nameIdFormat: EMAIL_FORMAT })),
      { key: idp, target: 'assertion' }
    );
    const identity = await verifySamlResponse(encode(injectNameIdComment(signed, 'admin@example.com'.length)), expected(requestId));
    expect(identity.nameId).toBe('admin@example.com.attacker.test');
  });
});

describe('XML signature wrapping', () => {
  const variants: WrappingVariant[] = ['sibling-before', 'sibling-after', 'nested', 'extensions', 'signature-object', 'same-id'];

  it.each(variants)('refuses an evil assertion added to a signed one (%s)', async (variant) => {
    const requestId = newId();
    const signed = signResponse(buildResponseXml(options(requestId)), { key: idp, target: 'assertion' });
    const wrapped = encode(wrapAssertion(signed, variant, 'subject-mallory'));
    expect(['wrapping', 'signature']).toContain(await reasonOf(verifySamlResponse(wrapped, expected(requestId))));
  });

  it.each(['in-signature', 'sibling'] as const)('refuses an evil Response around a signed one (%s)', async (variant) => {
    const requestId = newId();
    const signed = signResponse(buildResponseXml(options(requestId)), { key: idp, target: 'response' });
    const wrapped = encode(wrapResponse(signed, variant, 'subject-mallory'));
    expect(['wrapping', 'signature']).toContain(await reasonOf(verifySamlResponse(wrapped, expected(requestId))));
  });

  it('refuses a signature that is neither on the Response nor on the Assertion', async () => {
    const requestId = newId();
    const signed = signResponse(buildResponseXml(options(requestId)), { key: idp, target: 'assertion' });
    const moved = signed.replace('<samlp:Status>', '<samlp:Extensions><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></samlp:Extensions><samlp:Status>');
    expect(await reasonOf(verifySamlResponse(encode(moved), expected(requestId)))).toBe('wrapping');
  });

  it('refuses a document with a DOCTYPE (entity expansion) before parsing it', async () => {
    const requestId = newId();
    const xml = `<!DOCTYPE r [<!ENTITY x "x">]>${buildResponseXml(options(requestId))}`;
    expect(await reasonOf(verifySamlResponse(encode(xml), expected(requestId)))).toBe('malformed');
  });

  it('refuses an encrypted assertion (not supported)', async () => {
    const requestId = newId();
    const xml = buildResponseXml(options(requestId)).replace('</samlp:Response>', '<saml:EncryptedAssertion/></samlp:Response>');
    expect(await reasonOf(verifySamlResponse(encode(xml), expected(requestId)))).toBe('unsupported');
  });
});

describe('algorithms', () => {
  it('refuses an RSA-SHA1 signature over the HTTP-POST binding, whatever the IdP chose', async () => {
    const requestId = newId();
    for (const target of ['assertion', 'response'] as const) {
      const response = signedResponse({ ...options(requestId), key: idp, target, signatureAlgorithm: ALGORITHMS.rsaSha1, digestAlgorithm: ALGORITHMS.sha1 });
      expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('algorithm');
    }
  });

  it('refuses a SHA-1 digest under an RSA-SHA256 signature', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId), key: idp, digestAlgorithm: ALGORITHMS.sha1 });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('algorithm');
  });

  it('refuses SHA-1 on the Response even when the assertion is signed with SHA-256', async () => {
    const requestId = newId();
    const assertionSigned = signResponse(buildResponseXml(options(requestId)), { key: idp, target: 'assertion' });
    const both = signResponse(assertionSigned, { key: idp, target: 'response', signatureAlgorithm: ALGORITHMS.rsaSha1, digestAlgorithm: ALGORITHMS.sha1 });
    expect(await reasonOf(verifySamlResponse(encode(both), expected(requestId)))).toBe('algorithm');
  });

  it('accepts RSA-SHA512', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId), key: idp, signatureAlgorithm: ALGORITHMS.rsaSha512, digestAlgorithm: ALGORITHMS.sha512 });
    expect((await verifySamlResponse(response, expected(requestId))).nameId).toBe('subject-alice');
  });
});

describe('time', () => {
  it('refuses an expired assertion (SubjectConfirmationData and Conditions)', async () => {
    const requestId = newId();
    const past = Date.now() - 10 * 60_000;
    for (const overrides of [{ confirmationNotOnOrAfter: past }, { notOnOrAfter: past }]) {
      const response = signedResponse({ ...options(requestId, overrides), key: idp });
      expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('expired');
    }
  });

  it('refuses a bearer confirmation without NotOnOrAfter', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { confirmationNotOnOrAfter: null }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('expired');
  });

  it('refuses an assertion that is not valid yet', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { notBefore: Date.now() + 10 * 60_000 }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('not_yet_valid');
  });

  it('allows a small clock skew', async () => {
    const requestId = newId();
    const response = signedResponse({
      ...options(requestId, { notBefore: Date.now() + 20_000, notOnOrAfter: Date.now() - 20_000, confirmationNotOnOrAfter: Date.now() - 20_000 }),
      key: idp,
    });
    expect((await verifySamlResponse(response, expected(requestId))).nameId).toBe('subject-alice');
  });

  it('refuses an assertion issued before the sign-in started', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { issueInstant: Date.now() - 30 * 60_000 }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('expired');
  });
});

describe('audience, recipient, destination and issuer', () => {
  it('refuses another audience', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { audience: 'https://other-sp.example.org/saml' }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('audience');
  });

  it('refuses an assertion for another provider of the same dashboard', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { sp: serviceProviderUrls(PROVIDER_ID + 1) }), key: idp, target: 'assertion' });
    expect(['audience', 'destination']).toContain(await reasonOf(verifySamlResponse(response, expected(requestId))));
  });

  it('refuses another recipient', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { recipient: 'https://sp.example.org/acs' }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('recipient');
  });

  it('refuses another destination, and a signed Response without one', async () => {
    const requestId = newId();
    const other = signedResponse({ ...options(requestId, { destination: 'https://sp.example.org/acs' }), key: idp });
    expect(await reasonOf(verifySamlResponse(other, expected(requestId)))).toBe('destination');
    const missing = signedResponse({ ...options(requestId, { destination: null }), key: idp, target: 'response' });
    expect(await reasonOf(verifySamlResponse(missing, expected(requestId)))).toBe('destination');
    // Optional when only the assertion is signed.
    const unsignedResponse = signedResponse({ ...options(requestId, { destination: null }), key: idp, target: 'assertion' });
    expect((await verifySamlResponse(unsignedResponse, expected(requestId))).nameId).toBe('subject-alice');
  });

  it('refuses another issuer, on the Response or the Assertion', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { issuer: 'https://idp.example.org/other' }), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('issuer');
    const assertion = signedResponse({ ...options(requestId, { assertionIssuer: 'https://idp.example.org/other' }), key: idp });
    expect(await reasonOf(verifySamlResponse(assertion, expected(requestId)))).toBe('issuer');
  });

  it('reports an error status of the identity provider', async () => {
    const requestId = newId();
    const response = encode(buildResponseXml(options(requestId, { status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' })));
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('status');
  });
});

describe('SP-initiated only', () => {
  it('refuses an IdP-initiated response (no InResponseTo)', async () => {
    const response = signedResponse({ ...options(null), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(newId())))).toBe('idp_initiated');
  });

  it('refuses a response to another sign-in', async () => {
    const response = signedResponse({ ...options(newId()), key: idp });
    expect(await reasonOf(verifySamlResponse(response, expected(newId())))).toBe('in_response_to');
  });

  it('refuses a captured assertion re-wrapped in a Response that answers this sign-in', async () => {
    // The assertion (signed) answers request A; the unsigned Response around it claims request B.
    const captured = newId();
    const requestId = newId();
    const response = signedResponse({
      ...options(captured, { responseInResponseTo: requestId }),
      key: idp,
      target: 'assertion',
    });
    expect(await reasonOf(verifySamlResponse(response, expected(requestId)))).toBe('in_response_to');
  });

  it('refuses an assertion without InResponseTo in its SubjectConfirmationData', async () => {
    const requestId = newId();
    const response = signedResponse({ ...options(requestId, { confirmationInResponseTo: null }), key: idp, target: 'assertion' });
    expect(['idp_initiated', 'in_response_to']).toContain(await reasonOf(verifySamlResponse(response, expected(requestId))));
  });
});

describe('decoding', () => {
  it('refuses what is not base64 XML', async () => {
    expect(() => decodeSamlResponse('not base64!')).toThrow(SamlResponseError);
    expect(await reasonOf(verifySamlResponse(encode('<not-saml/>'), expected(newId())))).toBe('malformed');
    expect(await reasonOf(verifySamlResponse(encode('<unclosed'), expected(newId())))).toBe('malformed');
  });
});
