// SPDX-License-Identifier: Elastic-2.0
/**
 * SAML metadata: reading an identity provider's metadata once, when an
 * administrator saves it (never fetched by URL), and writing this service
 * provider's metadata for the IdP.
 */
import { X509Certificate } from "node:crypto";
import {
  BINDING_HTTP_POST,
  BINDING_HTTP_REDIRECT,
  LIMITS,
  NAMEID_FORMAT_PERSISTENT,
  XML_NS,
} from "./constants";
import { serviceProviderUrls } from "./store";
import { XmlInputError, allElements, attribute, childrenNamed, escapeXml, parseXml, simpleText } from "./xml";

export type IdpMetadata = {
  entityId: string;
  ssoUrl: string;
  /** PEM signing certificates, in document order. */
  certificates: string[];
};

/** Wraps base64 DER as a PEM certificate. */
export function derBase64ToPem(base64: string): string {
  const body = base64.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/** The base64 DER of a PEM certificate, for metadata. */
export function pemToDerBase64(pem: string): string {
  return new X509Certificate(pem).raw.toString("base64");
}

function idpDescriptorOf(root: Element): { entity: Element; descriptor: Element } {
  const md = XML_NS.metadata;
  let entities: Element[];
  if (root.namespaceURI === md && root.localName === "EntityDescriptor") {
    entities = [root];
  } else if (root.namespaceURI === md && root.localName === "EntitiesDescriptor") {
    entities = allElements(root).filter((element) => element.namespaceURI === md && element.localName === "EntityDescriptor");
  } else {
    throw new XmlInputError("The metadata must be an EntityDescriptor");
  }
  const withIdp = entities.flatMap((entity) =>
    childrenNamed(entity, md, "IDPSSODescriptor")
      .filter((descriptor) => (attribute(descriptor, "protocolSupportEnumeration") ?? "").split(/\s+/).includes(XML_NS.protocol))
      .map((descriptor) => ({ entity, descriptor }))
  );
  if (withIdp.length === 0) throw new XmlInputError("The metadata has no SAML 2.0 IDPSSODescriptor");
  if (withIdp.length > 1) throw new XmlInputError("The metadata describes more than one identity provider; paste the one to use");
  return withIdp[0];
}

/**
 * Reads the entity ID, the HTTP-Redirect single sign-on URL and the signing
 * certificates from IdP metadata. Throws XmlInputError with a message that
 * is safe to show. The metadata's own signature is not checked: the
 * administrator who pastes it vouches for it, as for certificates typed in.
 */
export function parseIdpMetadata(xml: string): IdpMetadata {
  if (xml.length > LIMITS.metadataXml) throw new XmlInputError("The metadata is too large");
  const doc = parseXml(xml, "The metadata");
  const { entity, descriptor } = idpDescriptorOf(doc.documentElement);
  const entityId = attribute(entity, "entityID")?.trim();
  if (!entityId) throw new XmlInputError("The metadata has no entityID");

  const services = childrenNamed(descriptor, XML_NS.metadata, "SingleSignOnService");
  const redirect = services.find((service) => attribute(service, "Binding") === BINDING_HTTP_REDIRECT);
  if (!redirect) {
    const onlyPost = services.some((service) => attribute(service, "Binding") === BINDING_HTTP_POST);
    throw new XmlInputError(
      onlyPost
        ? "The identity provider offers single sign-on only with the HTTP-POST binding; the HTTP-Redirect binding is needed"
        : "The metadata has no HTTP-Redirect SingleSignOnService"
    );
  }
  const ssoUrl = attribute(redirect, "Location")?.trim();
  if (!ssoUrl) throw new XmlInputError("The SingleSignOnService has no Location");

  const certificates: string[] = [];
  for (const key of childrenNamed(descriptor, XML_NS.metadata, "KeyDescriptor")) {
    const use = attribute(key, "use");
    if (use !== null && use !== "signing") continue;
    for (const element of allElements(key)) {
      if (element.namespaceURI !== XML_NS.dsig || element.localName !== "X509Certificate") continue;
      const text = simpleText(element)?.replace(/\s+/g, "");
      if (!text || !/^[A-Za-z0-9+/]+=*$/.test(text)) throw new XmlInputError("The metadata holds a certificate that cannot be read");
      const pem = derBase64ToPem(text);
      try {
        new X509Certificate(pem);
      } catch {
        throw new XmlInputError("The metadata holds a certificate that cannot be read");
      }
      if (!certificates.includes(pem)) certificates.push(pem);
    }
  }
  if (certificates.length === 0) throw new XmlInputError("The metadata has no signing certificate");
  return { entityId, ssoUrl, certificates };
}

/**
 * This dashboard's SP metadata for provider `id`: entity ID, the HTTP-POST
 * assertion consumer service, that assertions must be signed, the NameID
 * format asked for (persistent, unless an attribute holds the account id)
 * and, when AuthnRequests are signed, the signing certificate.
 */
export function buildServiceProviderMetadata(provider: {
  id: number;
  spCertificate: string | null;
  signsRequests: boolean;
  subjectAttribute: string | null;
}): string {
  const sp = serviceProviderUrls(provider.id);
  const keyDescriptor = provider.signsRequests && provider.spCertificate
    ? [
      `    <md:KeyDescriptor use="signing">`,
      `      <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${pemToDerBase64(provider.spCertificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
      `    </md:KeyDescriptor>`,
    ]
    : [];
  const nameIdFormat = provider.subjectAttribute === null
    ? [`    <md:NameIDFormat>${NAMEID_FORMAT_PERSISTENT}</md:NameIDFormat>`]
    : [];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<md:EntityDescriptor xmlns:md="${XML_NS.metadata}" xmlns:ds="${XML_NS.dsig}" entityID="${escapeXml(sp.entityId)}">`,
    `  <md:SPSSODescriptor protocolSupportEnumeration="${XML_NS.protocol}" AuthnRequestsSigned="${provider.signsRequests ? "true" : "false"}" WantAssertionsSigned="true">`,
    ...keyDescriptor,
    ...nameIdFormat,
    `    <md:AssertionConsumerService Binding="${BINDING_HTTP_POST}" Location="${escapeXml(sp.acsUrl)}" index="0" isDefault="true"/>`,
    `  </md:SPSSODescriptor>`,
    `</md:EntityDescriptor>`,
    ``,
  ].join("\n");
}
