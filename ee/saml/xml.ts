// SPDX-License-Identifier: Elastic-2.0
/**
 * Strict XML helpers for SAML messages and metadata, on @xmldom/xmldom.
 *
 * Documents with a DOCTYPE (and so any entity declaration) are refused
 * before parsing, and every parser warning or error is fatal: a SAML message
 * or metadata document never needs either.
 */
import { DOMParser } from "@xmldom/xmldom";

export class XmlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlInputError";
  }
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** Parses `text` or throws XmlInputError. `what` names the document in messages. */
export function parseXml(text: string, what: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XmlInputError(`${what} must not contain a DOCTYPE`);
  const fail = (message: string) => {
    throw new XmlInputError(`${what} is not well-formed XML (${message.split("\n")[0].slice(0, 160)})`);
  };
  let doc: Document;
  try {
    doc = new DOMParser({
      locator: {},
      errorHandler: { warning: fail, error: fail, fatalError: fail },
    }).parseFromString(text, "text/xml") as unknown as Document;
  } catch (error) {
    if (error instanceof XmlInputError) throw error;
    throw new XmlInputError(`${what} is not well-formed XML`);
  }
  if (!doc || !doc.documentElement) throw new XmlInputError(`${what} is not an XML document`);
  if (doc.doctype) throw new XmlInputError(`${what} must not contain a DOCTYPE`);
  return doc;
}

/** The element children of `node`, in document order. */
export function elementChildren(node: Node): Element[] {
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) result.push(child as Element);
  }
  return result;
}

export function childrenNamed(node: Node, namespace: string, localName: string): Element[] {
  return elementChildren(node).filter((child) => child.namespaceURI === namespace && child.localName === localName);
}

/** The only child of that name, null when there is none; throws when there are several. */
export function onlyChild(node: Node, namespace: string, localName: string, what: string): Element | null {
  const found = childrenNamed(node, namespace, localName);
  if (found.length > 1) throw new XmlInputError(`${what} has more than one ${localName}`);
  return found[0] ?? null;
}

/** Every element below `root` (root included), in document order. */
export function allElements(root: Element): Element[] {
  const result: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    result.push(element);
    const children = elementChildren(element);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return result;
}

/**
 * The text of a simple element: its text and CDATA children joined, comments
 * skipped. Null when it has element children (not a simple value).
 */
export function simpleText(element: Element): string | null {
  let text = "";
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === ELEMENT_NODE) return null;
    if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) text += child.nodeValue ?? "";
  }
  return text;
}

export function attribute(element: Element, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
