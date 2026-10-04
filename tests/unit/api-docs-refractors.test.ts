/**
 * The API reference's fallback for the OpenAPI 3.1 refractors
 * (app/(dashboard)/api-docs/apidom-refractors.ts): a no-op where ApiDOM's
 * registration ran, and when it did not (Turbopack drops it), refractors that
 * turn our own OpenAPI document into the same ApiDOM as ApiDOM's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/src/lib/api-auth', () => ({
  requireApiPermission: vi.fn((request: unknown) => import('@/tests/helpers/permission-mocks').then((m) => m.viaRequireApiAdmin(request))),
  requireApiAdmin: vi.fn().mockResolvedValue({ userId: 1, role: 'admin', authMethod: 'bearer' }),
  apiErrorResponse: vi.fn(),
}));

import { toValue } from '@swagger-api/apidom-core';
import { OpenApi3_1Element, SchemaElement } from '@swagger-api/apidom-ns-openapi-3-1';
import { OPENAPI_3_1_REFRACTORS, ensureOpenApi31Refractors } from '@/app/(dashboard)/api-docs/apidom-refractors';
import { GET } from '@/app/api/v1/openapi.json/route';

type Refract = (value: unknown, options?: unknown) => { element: string };
const refractOf = (element: object) => (element as { refract: Refract }).refract;
const originals = new Map(OPENAPI_3_1_REFRACTORS.map(([element]) => [element, refractOf(element)]));

afterEach(() => {
  for (const [element, refract] of originals) (element as { refract: Refract }).refract = refract;
});

async function ourSpec(): Promise<unknown> {
  return (await GET({ headers: { get: () => null } } as any)).json();
}

describe('OpenAPI 3.1 refractors for Swagger UI', () => {
  it('lists every element ApiDOM registers, and leaves its refractors alone', () => {
    expect(OPENAPI_3_1_REFRACTORS).toHaveLength(32);
    for (const [element] of OPENAPI_3_1_REFRACTORS) expect(typeof refractOf(element)).toBe('function');
    expect(ensureOpenApi31Refractors()).toBe(0);
    for (const [element, refract] of originals) expect(refractOf(element)).toBe(refract);
  });

  it('puts back refractors that give the same ApiDOM for our OpenAPI document', async () => {
    const spec = await ourSpec();
    const expected = toValue(refractOf(OpenApi3_1Element)(spec));
    const expectedSchema = toValue(refractOf(SchemaElement)({ type: 'object', properties: { id: { type: 'integer' } } }));

    for (const [element] of OPENAPI_3_1_REFRACTORS) delete (element as { refract?: Refract }).refract;
    expect(ensureOpenApi31Refractors()).toBe(32);

    const document = refractOf(OpenApi3_1Element)(spec);
    expect(document.element).toBe('openApi3_1');
    expect(toValue(document)).toEqual(expected);
    const schema = refractOf(SchemaElement)({ type: 'object', properties: { id: { type: 'integer' } } });
    expect(schema.element).toBe('schema');
    expect(toValue(schema)).toEqual(expectedSchema);
  });
});
