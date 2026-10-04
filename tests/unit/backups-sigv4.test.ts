/**
 * AWS Signature V4 against the examples AWS publishes: the SigV4 test suite
 * (get-vanilla, get-vanilla-query-order-key-case) and the S3 header-based
 * authentication examples (GET object, PUT object, GET bucket lifecycle,
 * list objects).
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAYLOAD_SHA256,
  amzDate,
  canonicalQueryString,
  canonicalUri,
  sha256Hex,
  signV4,
  uriEncode,
} from '@/ee/backups/sigv4';

const SUITE_CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const SUITE_DATE = new Date('2015-08-30T12:36:00Z');
const S3_CREDENTIALS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_DATE = new Date('2013-05-24T00:00:00Z');

function suite(url: string) {
  return signV4({
    method: 'GET',
    url: new URL(url),
    headers: { Host: 'example.amazonaws.com' },
    payloadHash: EMPTY_PAYLOAD_SHA256,
    region: 'us-east-1',
    service: 'service',
    credentials: SUITE_CREDENTIALS,
    date: SUITE_DATE,
  });
}

function s3(method: string, url: string, headers: Record<string, string>, payloadHash = EMPTY_PAYLOAD_SHA256) {
  return signV4({
    method,
    url: new URL(url),
    headers: { 'x-amz-content-sha256': payloadHash, ...headers },
    payloadHash,
    region: 'us-east-1',
    service: 's3',
    credentials: S3_CREDENTIALS,
    date: S3_DATE,
  });
}

describe('SigV4 test suite', () => {
  it('get-vanilla', () => {
    const result = suite('https://example.amazonaws.com/');
    expect(result.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' + EMPTY_PAYLOAD_SHA256
    );
    expect(result.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n' +
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63'
    );
    expect(result.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('get-vanilla-query-order-key-case', () => {
    const result = suite('https://example.amazonaws.com/?Param2=value2&Param1=value1');
    expect(result.signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });
});

describe('S3 header-based authentication examples', () => {
  it('GET object with a range', () => {
    const result = s3('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { Range: 'bytes=0-9' });
    expect(result.canonicalRequest).toBe(
      'GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n' +
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}\nx-amz-date:20130524T000000Z\n\n` +
        `host;range;x-amz-content-sha256;x-amz-date\n${EMPTY_PAYLOAD_SHA256}`
    );
    expect(result.stringToSign.split('\n')[3]).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    expect(result.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT object (path with a reserved character, signed payload)', () => {
    const body = 'Welcome to Amazon S3.';
    const hash = sha256Hex(body);
    expect(hash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const result = s3(
      'PUT',
      'https://examplebucket.s3.amazonaws.com/test$file.text',
      { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      hash
    );
    expect(result.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(result.signedHeaders).toBe('date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
    expect(result.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET bucket lifecycle (sub-resource without a value)', () => {
    const result = s3('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle', {});
    expect(result.canonicalRequest.split('\n')[2]).toBe('lifecycle=');
    expect(result.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('list objects (sorted query parameters)', () => {
    const result = s3('GET', 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', {});
    expect(result.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
    expect(result.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('encoding helpers', () => {
  it('encodes like S3 UriEncode', () => {
    expect(uriEncode('a b/c~d_e.f-g')).toBe('a%20b%2Fc~d_e.f-g');
    expect(uriEncode('a b/c', false)).toBe('a%20b/c');
    expect(uriEncode('é+=*')).toBe('%C3%A9%2B%3D%2A');
  });

  it('canonicalizes paths once and query strings sorted', () => {
    expect(canonicalUri(new URL('https://h.example.com/a%20b/c$d'))).toBe('/a%20b/c%24d');
    expect(canonicalQueryString(new URL('https://h.example.com/?prefix=a%2Fb&list-type=2&continuation-token=x%2By'))).toBe(
      'continuation-token=x%2By&list-type=2&prefix=a%2Fb'
    );
    expect(amzDate(new Date('2026-10-02T03:04:05.678Z'))).toBe('20261002T030405Z');
  });

  it('signs the host of the URL and never returns the secret', () => {
    const result = signV4({
      method: 'PUT',
      url: new URL('http://minio.internal:9000/bucket/key.json'),
      headers: { 'Content-Type': 'application/json' },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: 'us-east-1',
      service: 's3',
      credentials: S3_CREDENTIALS,
      date: S3_DATE,
    });
    expect(result.canonicalRequest).toContain('host:minio.internal:9000\n');
    expect(result.headers.host).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(S3_CREDENTIALS.secretAccessKey);
  });
});
