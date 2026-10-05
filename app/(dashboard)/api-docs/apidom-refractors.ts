/**
 * Puts back the refractors of the OpenAPI 3.1 elements when the bundler
 * dropped them.
 *
 * Swagger UI resolves an OpenAPI 3.1 document (ours is one) through
 * swagger-client's ApiDOM strategy, which calls `OpenApi3_1Element.refract()`
 * and the other elements' static `refract`. ApiDOM assigns those in
 * src/refractor/registration.mjs of @swagger-api/apidom-ns-openapi-3-1, a
 * module whose only effect is the assignments (the package lists it under
 * `sideEffects`). Turbopack resolves imports of the elements straight to
 * their own modules and never runs registration.mjs, in development and in
 * production builds alike, so loading a spec or expanding an operation
 * failed with "OpenApi3_1Element.refract is not a function".
 *
 * This does what registration.mjs does, from the package's public exports,
 * for the elements that have no refractor of their own; where the bundler
 * kept registration.mjs (webpack, Node, the tests) it changes nothing.
 * Our @swagger-api/apidom-* dependencies stay at the versions swagger-client
 * pins, so this patches the copy Swagger UI loads (a second copy would be
 * patched in vain). tests/unit/api-docs-refractors.test.ts checks both.
 */
import { dereference, dispatchRefractorPlugins, refract as baseRefract, visit } from "@swagger-api/apidom-core";
import {
  CallbackElement,
  ComponentsElement,
  ContactElement,
  DiscriminatorElement,
  EncodingElement,
  ExampleElement,
  ExternalDocumentationElement,
  HeaderElement,
  InfoElement,
  JsonSchemaDialectElement,
  LicenseElement,
  LinkElement,
  MediaTypeElement,
  OAuthFlowElement,
  OAuthFlowsElement,
  OpenapiElement,
  OpenApi3_1Element,
  OperationElement,
  ParameterElement,
  PathItemElement,
  PathsElement,
  ReferenceElement,
  RequestBodyElement,
  ResponseElement,
  ResponsesElement,
  SchemaElement,
  SecurityRequirementElement,
  SecuritySchemeElement,
  ServerElement,
  ServerVariableElement,
  TagElement,
  XmlElement,
  createToolbox,
  getNodeType,
  keyMap,
  specificationObj,
} from "@swagger-api/apidom-ns-openapi-3-1";

type RefractOptions = { specPath?: string[]; plugins?: unknown[] };
type Refractor = (value: unknown, options?: RefractOptions) => unknown;
type VisitorClass = new (options: { specObj: unknown }) => { element: unknown };

const objects = (...rest: string[]) => ["visitors", "document", "objects", ...rest];

/** Each element and the path of its visitor in the refractor specification, as registration.mjs lists them. */
export const OPENAPI_3_1_REFRACTORS: readonly (readonly [object, string[]])[] = [
  [CallbackElement, objects("Callback", "$visitor")],
  [ComponentsElement, objects("Components", "$visitor")],
  [ContactElement, objects("Contact", "$visitor")],
  [ExampleElement, objects("Example", "$visitor")],
  [DiscriminatorElement, objects("Discriminator", "$visitor")],
  [EncodingElement, objects("Encoding", "$visitor")],
  [ExternalDocumentationElement, objects("ExternalDocumentation", "$visitor")],
  [HeaderElement, objects("Header", "$visitor")],
  [InfoElement, objects("Info", "$visitor")],
  [JsonSchemaDialectElement, objects("OpenApi", "fixedFields", "jsonSchemaDialect")],
  [LicenseElement, objects("License", "$visitor")],
  [LinkElement, objects("Link", "$visitor")],
  [MediaTypeElement, objects("MediaType", "$visitor")],
  [OAuthFlowElement, objects("OAuthFlow", "$visitor")],
  [OAuthFlowsElement, objects("OAuthFlows", "$visitor")],
  [OpenapiElement, objects("OpenApi", "fixedFields", "openapi")],
  [OpenApi3_1Element, objects("OpenApi", "$visitor")],
  [OperationElement, objects("Operation", "$visitor")],
  [ParameterElement, objects("Parameter", "$visitor")],
  [PathItemElement, objects("PathItem", "$visitor")],
  [PathsElement, objects("Paths", "$visitor")],
  [ReferenceElement, objects("Reference", "$visitor")],
  [RequestBodyElement, objects("RequestBody", "$visitor")],
  [ResponseElement, objects("Response", "$visitor")],
  [ResponsesElement, objects("Responses", "$visitor")],
  [SchemaElement, objects("Schema", "$visitor")],
  [SecurityRequirementElement, objects("SecurityRequirement", "$visitor")],
  [SecuritySchemeElement, objects("SecurityScheme", "$visitor")],
  [ServerElement, objects("Server", "$visitor")],
  [ServerVariableElement, objects("ServerVariable", "$visitor")],
  [TagElement, objects("Tag", "$visitor")],
  [XmlElement, objects("XML", "$visitor")],
];

/** ApiDOM's refract for OpenAPI 3.1 (src/refractor/index.mjs): generic ApiDOM made semantic by the visitor at `specPath`. */
function refractWith(value: unknown, specPath: string[], plugins: unknown[]): unknown {
  const element = baseRefract(value);
  const resolvedSpec = dereference(specificationObj);
  const RootVisitorClass = specPath.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    resolvedSpec
  ) as VisitorClass;
  const rootVisitor = new RootVisitorClass({ specObj: resolvedSpec });
  visit(element, rootVisitor);
  return dispatchRefractorPlugins(rootVisitor.element as Parameters<typeof dispatchRefractorPlugins>[0], plugins as Parameters<typeof dispatchRefractorPlugins>[1], {
    toolboxCreator: createToolbox,
    visitorOptions: { keyMap, nodeTypeGetter: getNodeType },
  });
}

export function createRefractor(specPath: string[]): Refractor {
  return (value, options = {}) => refractWith(value, options.specPath ?? specPath, options.plugins ?? []);
}

/** Gives every OpenAPI 3.1 element without a refractor of its own the one ApiDOM would have; returns how many it added. */
export function ensureOpenApi31Refractors(): number {
  let added = 0;
  for (const [element, specPath] of OPENAPI_3_1_REFRACTORS) {
    if (Object.prototype.hasOwnProperty.call(element, "refract")) continue;
    (element as { refract?: Refractor }).refract = createRefractor(specPath);
    added++;
  }
  return added;
}
