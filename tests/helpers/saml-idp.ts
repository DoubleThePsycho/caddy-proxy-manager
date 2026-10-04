/**
 * An in-process SAML 2.0 identity provider for the SAML tests: RSA keys with
 * self-signed certificates, responses built as XML and signed with
 * xml-crypto (the library every SAML stack uses for XML signatures), and
 * the tampered variants the tests feed the service provider (XML signature
 * wrapping, comments, SHA-1).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export const IDP_ENTITY_ID = 'https://idp.example.com/saml/metadata';
export const IDP_SSO_URL = 'https://idp.example.com/saml/sso';
export const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

export const ALGORITHMS = {
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  rsaSha512: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  sha512: 'http://www.w3.org/2001/04/xmlenc#sha512',
} as const;

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export type TestKey = { privateKey: string; certificate: string };

/** An RSA key and a self-signed certificate for it. */
export function createTestKey(commonName = 'idp.example.com', bits = 2048): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privatePem) as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
  return { privateKey: privatePem, certificate: forge.pki.certificateToPem(cert) };
}

export function newId(): string {
  return `_${randomBytes(16).toString('hex')}`;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ResponseOptions = {
  /** The SP: its entity ID (audience) and ACS URL (recipient, destination). */
  sp: { entityId: string; acsUrl: string };
  /** The AuthnRequest answered; null for an IdP-initiated response (no InResponseTo anywhere). */
  requestId: string | null;
  /** Overrides of single parts; undefined keeps the default, null leaves the attribute out. */
  responseInResponseTo?: string | null;
  confirmationInResponseTo?: string | null;
  destination?: string | null;
  recipient?: string;
  audience?: string;
  issuer?: string;
  assertionIssuer?: string;
  responseId?: string;
  assertionId?: string;
  now?: number;
  issueInstant?: number;
  notBefore?: number | null;
  notOnOrAfter?: number | null;
  confirmationNotOnOrAfter?: number | null;
  nameId?: string;
  nameIdFormat?: string;
  attributes?: Record<string, string | string[]>;
  status?: string;
};

/** A SAML 2.0 Response with one assertion, unsigned. */
export function buildResponseXml(options: ResponseOptions): string {
  const now = options.now ?? Date.now();
  const responseInResponseTo = options.responseInResponseTo === undefined ? options.requestId : options.responseInResponseTo;
  const confirmationInResponseTo = options.confirmationInResponseTo === undefined ? options.requestId : options.confirmationInResponseTo;
  const destination = options.destination === undefined ? options.sp.acsUrl : options.destination;
  const notBefore = options.notBefore === undefined ? now - 30_000 : options.notBefore;
  const notOnOrAfter = options.notOnOrAfter === undefined ? now + 5 * 60_000 : options.notOnOrAfter;
  const confirmationNotOnOrAfter = options.confirmationNotOnOrAfter === undefined ? now + 5 * 60_000 : options.confirmationNotOnOrAfter;
  const issuer = options.issuer ?? IDP_ENTITY_ID;
  const attributes = Object.entries(options.attributes ?? {}).map(([name, value]) => {
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escape(item)}</saml:AttributeValue>`)
      .join('');
    return `<saml:Attribute Name="${escape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">${values}</saml:Attribute>`;
  }).join('');
  const attr = (name: string, value: string | null | undefined) => (value === null || value === undefined ? '' : ` ${name}="${escape(value)}"`);
  return [
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"`,
    ` ID="${options.responseId ?? newId()}" Version="2.0" IssueInstant="${iso(options.issueInstant ?? now)}"`,
    `${attr('Destination', destination)}${attr('InResponseTo', responseInResponseTo)}>`,
    `<saml:Issuer>${escape(issuer)}</saml:Issuer>`,
    `<samlp:Status><samlp:StatusCode Value="${options.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>`,
    `<saml:Assertion ID="${options.assertionId ?? newId()}" Version="2.0" IssueInstant="${iso(options.issueInstant ?? now)}">`,
    `<saml:Issuer>${escape(options.assertionIssuer ?? issuer)}</saml:Issuer>`,
    `<saml:Subject>`,
    `<saml:NameID Format="${options.nameIdFormat ?? PERSISTENT}">${escape(options.nameId ?? 'subject-0001')}</saml:NameID>`,
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">`,
    `<saml:SubjectConfirmationData${attr('InResponseTo', confirmationInResponseTo)}`,
    `${attr('NotOnOrAfter', confirmationNotOnOrAfter === null ? null : iso(confirmationNotOnOrAfter))}`,
    `${attr('Recipient', options.recipient ?? options.sp.acsUrl)}/>`,
    `</saml:SubjectConfirmation>`,
    `</saml:Subject>`,
    `<saml:Conditions${attr('NotBefore', notBefore === null ? null : iso(notBefore))}${attr('NotOnOrAfter', notOnOrAfter === null ? null : iso(notOnOrAfter))}>`,
    `<saml:AudienceRestriction><saml:Audience>${escape(options.audience ?? options.sp.entityId)}</saml:Audience></saml:AudienceRestriction>`,
    `</saml:Conditions>`,
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${newId()}">`,
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>`,
    `</saml:AuthnStatement>`,
    attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '',
    `</saml:Assertion>`,
    `</samlp:Response>`,
  ].join('');
}

export type SignOptions = {
  key: TestKey;
  /** What carries a signature. */
  target: 'assertion' | 'response' | 'both';
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
};

function signElement(xml: string, element: 'Assertion' | 'Response', options: SignOptions): string {
  const path = element === 'Response' ? "/*[local-name(.)='Response']" : "//*[local-name(.)='Assertion']";
  const sig = new SignedXml({
    privateKey: options.key.privateKey,
    publicCert: options.key.certificate,
    signatureAlgorithm: options.signatureAlgorithm ?? ALGORITHMS.rsaSha256,
    canonicalizationAlgorithm: EXC_C14N,
  });
  sig.addReference({
    xpath: path,
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: options.digestAlgorithm ?? ALGORITHMS.sha256,
  });
  sig.computeSignature(xml, {
    prefix: 'ds',
    location: { reference: `${path}/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return sig.getSignedXml();
}

/** Signs the assertion, the response, or both (assertion first, as IdPs do). */
export function signResponse(xml: string, options: SignOptions): string {
  let signed = xml;
  if (options.target === 'assertion' || options.target === 'both') signed = signElement(signed, 'Assertion', options);
  if (options.target === 'response' || options.target === 'both') signed = signElement(signed, 'Response', options);
  return signed;
}

export function encode(xml: string): string {
  return Buffer.from(xml, 'utf8').toString('base64');
}

/** A complete posted SAMLResponse: built, signed and base64-encoded. */
export function signedResponse(options: ResponseOptions & { key: TestKey; target?: SignOptions['target']; signatureAlgorithm?: string; digestAlgorithm?: string }): string {
  return encode(signResponse(buildResponseXml(options), {
    key: options.key,
    target: options.target ?? 'assertion',
    signatureAlgorithm: options.signatureAlgorithm,
    digestAlgorithm: options.digestAlgorithm,
  }));
}

// ── Tampering ─────────────────────────────────────────────────────────

const SAML = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol';
const DS = 'http://www.w3.org/2000/09/xmldsig#';

export function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

export function serialize(doc: Document): string {
  return new XMLSerializer().serializeToString(doc as never);
}

function firstElement(parent: Node, namespace: string, localName: string): Element {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).namespaceURI === namespace && (child as Element).localName === localName) {
      return child as Element;
    }
  }
  throw new Error(`no ${localName}`);
}

/** Sets the text of the first NameID (and nothing else) in an element. */
function setNameId(assertion: Element, value: string): void {
  const subject = firstElement(assertion, SAML, 'Subject');
  const nameId = firstElement(subject, SAML, 'NameID');
  while (nameId.firstChild) nameId.removeChild(nameId.firstChild);
  nameId.appendChild(nameId.ownerDocument!.createTextNode(value));
}

/** Removes the Signature child of an element, if any. */
function dropSignature(element: Element): void {
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).namespaceURI === DS && (child as Element).localName === 'Signature') {
      element.removeChild(child);
      return;
    }
  }
}

export type WrappingVariant =
  /** An evil assertion inserted before the signed one (XSW3). */
  | 'sibling-before'
  /** An evil assertion inserted after the signed one. */
  | 'sibling-after'
  /** The signed assertion nested inside the evil one (XSW4). */
  | 'nested'
  /** The signed assertion moved into samlp:Extensions, the evil one in its place (XSW7). */
  | 'extensions'
  /** The signed assertion moved into a ds:Object of the evil assertion's copied signature (XSW8). */
  | 'signature-object'
  /** An evil assertion with the signed one's ID, the signed one kept in Extensions. */
  | 'same-id';

/**
 * Takes a response with a signed assertion and adds an evil, unsigned
 * assertion that names `evilNameId`, in one of the classic XML signature
 * wrapping layouts.
 */
export function wrapAssertion(signedXml: string, variant: WrappingVariant, evilNameId: string): string {
  const doc = parse(signedXml);
  const response = doc.documentElement;
  const original = firstElement(response, SAML, 'Assertion');
  const evil = original.cloneNode(true) as Element;
  setNameId(evil, evilNameId);
  if (variant !== 'signature-object' && variant !== 'same-id') dropSignature(evil);
  if (variant !== 'same-id') evil.setAttribute('ID', newId());

  switch (variant) {
    case 'sibling-before':
      response.insertBefore(evil, original);
      break;
    case 'sibling-after':
      response.insertBefore(evil, original.nextSibling);
      break;
    case 'nested':
      response.replaceChild(evil, original);
      evil.appendChild(original);
      break;
    case 'extensions':
    case 'same-id': {
      const extensions = doc.createElementNS(SAMLP, 'samlp:Extensions');
      response.replaceChild(evil, original);
      extensions.appendChild(original);
      response.insertBefore(extensions, firstElement(response, SAMLP, 'Status'));
      if (variant === 'same-id') dropSignature(evil);
      break;
    }
    case 'signature-object': {
      // The evil assertion keeps a copy of the original signature, whose ds:Object holds the signed assertion.
      response.replaceChild(evil, original);
      const signature = firstElement(evil, DS, 'Signature');
      const object = doc.createElementNS(DS, 'ds:Object');
      object.appendChild(original);
      signature.appendChild(object);
      break;
    }
  }
  return serialize(doc);
}

/** A signed response copied into the Signature of an evil response (XSW1) or next to it (XSW2). */
export function wrapResponse(signedXml: string, variant: 'in-signature' | 'sibling', evilNameId: string): string {
  const doc = parse(signedXml);
  const original = doc.documentElement;
  const evil = original.cloneNode(true) as Element;
  evil.setAttribute('ID', newId());
  setNameId(firstElement(evil, SAML, 'Assertion'), evilNameId);
  const signature = firstElement(evil, DS, 'Signature');
  if (variant === 'in-signature') {
    signature.appendChild(original.cloneNode(true));
  } else {
    evil.removeChild(signature);
    evil.appendChild(original.cloneNode(true));
  }
  const evilDoc = parse('<root/>');
  evilDoc.replaceChild(evilDoc.importNode(evil, true), evilDoc.documentElement);
  return serialize(evilDoc);
}

/** Splits the NameID text with a comment, after `at` characters (comment injection, CVE-2017-11427). */
export function injectNameIdComment(signedXml: string, at: number): string {
  const doc = parse(signedXml);
  const assertion = firstElement(doc.documentElement, SAML, 'Assertion');
  const nameId = firstElement(firstElement(assertion, SAML, 'Subject'), SAML, 'NameID');
  const text = nameId.textContent ?? '';
  while (nameId.firstChild) nameId.removeChild(nameId.firstChild);
  nameId.appendChild(doc.createTextNode(text.slice(0, at)));
  nameId.appendChild(doc.createComment(''));
  nameId.appendChild(doc.createTextNode(text.slice(at)));
  return serialize(doc);
}

/** Changes the NameID of a signed response without re-signing it. */
export function tamperNameId(signedXml: string, value: string): string {
  const doc = parse(signedXml);
  setNameId(firstElement(doc.documentElement, SAML, 'Assertion'), value);
  return serialize(doc);
}

/** The ID of the AuthnRequest in an HTTP-Redirect sign-in URL, and the query it came with. */
export function readAuthnRequest(url: string): { id: string; xml: string; params: URLSearchParams } {
  const params = new URL(url).searchParams;
  const encoded = params.get('SAMLRequest');
  if (!encoded) throw new Error('no SAMLRequest');
  const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = parse(xml).documentElement.getAttribute('ID');
  if (!id) throw new Error('no ID');
  return { id, xml, params };
}

/** IdP metadata for the test IdP. */
export function idpMetadataXml(certificates: string[], options: { ssoUrl?: string; entityId?: string; postOnly?: boolean } = {}): string {
  const keys = certificates
    .map((pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, ''))
    .map((der) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${der}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`)
    .join('');
  const binding = options.postOnly ? 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' : 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
  return `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="${DS}" entityID="${options.entityId ?? IDP_ENTITY_ID}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keys}` +
    `<md:SingleSignOnService Binding="${binding}" Location="${options.ssoUrl ?? IDP_SSO_URL}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`;
}
