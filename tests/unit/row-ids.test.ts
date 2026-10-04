/**
 * Row ids from requests (src/lib/row-ids.ts): only what an id column can
 * hold reaches a query, so SQLite and PostgreSQL answer the same.
 */
import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../../src/lib/api-errors';
import { isRowId, MAX_ROW_ID, parseRowId, routeRowId } from '../../src/lib/row-ids';

describe('parseRowId', () => {
  it.each([
    ['1', 1],
    ['42', 42],
    ['007', 7],
    ['2147483647', MAX_ROW_ID],
    [1, 1],
    [MAX_ROW_ID, MAX_ROW_ID],
  ])('reads %j as %j', (raw, id) => {
    expect(parseRowId(raw)).toBe(id);
  });

  it.each([
    'not-a-number', '', ' 1', '1 ', '+1', '-1', '0', '1.5', '1e3', '0x10', '2147483648', '99999999999999',
    0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, true, {}, ['1'],
  ])('refuses %j', (raw) => {
    expect(parseRowId(raw)).toBeNull();
  });

  it('isRowId accepts only integers from 1 to MAX_ROW_ID', () => {
    expect(isRowId(1)).toBe(true);
    expect(isRowId(MAX_ROW_ID)).toBe(true);
    expect(isRowId(MAX_ROW_ID + 1)).toBe(false);
    expect(isRowId('1')).toBe(false);
  });
});

describe('routeRowId', () => {
  it('answers 404 with the route\'s message for text that names no row', () => {
    expect(routeRowId('12', 'Instance not found')).toBe(12);
    let error: unknown;
    try {
      routeRowId('2147483648', 'Instance not found');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 404, message: 'Instance not found' });
    expect(() => routeRowId('abc')).toThrow('Resource not found');
  });
});
