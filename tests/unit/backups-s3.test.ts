/**
 * The S3 client against a mocked fetch: addressing styles, signed uploads
 * with checksum metadata, downloads with a size limit, paginated listings,
 * deletes, and error messages that never leak credentials or bodies.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { S3Client, S3Error, describeNetworkError, parseListObjectsV2 } from '@/ee/backups/s3';
import { FakeS3 } from '../helpers/fake-s3';

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY-secret';
const CREDENTIALS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: SECRET };

function setup(options: { endpoint?: string; bucket?: string; pathStyle?: boolean; region?: string } = {}) {
  const location = {
    endpoint: options.endpoint ?? 'https://s3.eu-central-1.amazonaws.com',
    bucket: options.bucket ?? 'backups',
    pathStyle: options.pathStyle ?? false,
    region: options.region ?? 'eu-central-1',
  };
  const fake = new FakeS3({ ...location, accessKeyId: CREDENTIALS.accessKeyId });
  const client = new S3Client(location, CREDENTIALS, { fetch: fake.fetch });
  return { fake, client };
}

describe('addressing', () => {
  it('uses virtual-hosted URLs by default and path-style on request', () => {
    const { client } = setup();
    expect(client.url('a/b c+d.json').toString()).toBe('https://backups.s3.eu-central-1.amazonaws.com/a/b%20c%2Bd.json');
    expect(client.url(undefined, [['list-type', '2'], ['prefix', 'a/b']]).toString()).toBe(
      'https://backups.s3.eu-central-1.amazonaws.com/?list-type=2&prefix=a%2Fb'
    );
    const path = setup({ endpoint: 'http://minio:9000', pathStyle: true, region: 'us-east-1' }).client;
    expect(path.url('x/y.json').toString()).toBe('http://minio:9000/backups/x/y.json');
    expect(path.url().toString()).toBe('http://minio:9000/backups');
  });

  it('always uses path-style for an IP address endpoint', () => {
    const client = new S3Client({ endpoint: 'http://10.0.0.5:9000', bucket: 'b-1', pathStyle: false, region: 'us-east-1' }, CREDENTIALS);
    expect(client.url('k').toString()).toBe('http://10.0.0.5:9000/b-1/k');
  });

  it('refuses keys the URL parser would rewrite', () => {
    const { client } = setup();
    expect(() => client.url('a/../b')).toThrow(S3Error);
  });
});

describe('putObject', () => {
  it('signs the payload and sends Content-Type and checksum metadata', async () => {
    const { fake, client } = setup();
    const body = Buffer.from('{"format":"ingressi-configuration"}');
    const sha = createHash('sha256').update(body).digest('hex');
    await client.putObject('folder/file.json', body, { contentType: 'application/json', metadata: { sha256: sha } });

    const [request] = fake.requests;
    expect(request.method).toBe('PUT');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-amz-content-sha256']).toBe(sha);
    expect(request.headers['x-amz-meta-sha256']).toBe(sha);
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=[0-9a-f]{64}$/
    );
    expect(JSON.stringify(request.headers)).not.toContain(SECRET);
    expect(fake.objects.get('folder/file.json')?.body.equals(body)).toBe(true);
    expect(fake.objects.get('folder/file.json')?.metadata).toEqual({ sha256: sha });
  });

  it('turns S3 errors into safe messages', async () => {
    const { fake, client } = setup();
    fake.fail = () => ({ status: 403, code: 'AccessDenied' });
    const error = await client.putObject('k', Buffer.from('x'), { contentType: 'text/plain' }).catch((e) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error).toMatchObject({ status: 403, code: 'AccessDenied' });
    expect(error.message).toBe(
      'HTTP 403 (AccessDenied) from the storage: access denied; check that the key may read, write, list and delete objects in the bucket'
    );
    expect(error.message).not.toMatch(/leak|secret|AWS4/);
  });

  it('does not follow redirects and names the bucket region', async () => {
    const { fake, client } = setup();
    fake.fail = () => ({ status: 301, code: 'PermanentRedirect', headers: { 'x-amz-bucket-region': 'us-west-2' } });
    await expect(client.putObject('k', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(
      /HTTP 301 \(PermanentRedirect\).*\(the bucket is in region us-west-2\)$/
    );
  });

  it('ignores error codes that are not plain tokens', async () => {
    const fetch = vi.fn(async () => new Response('<Error><Code>Bad code with spaces &amp; stuff</Code></Error>', { status: 500 }));
    const custom = new S3Client({ endpoint: 'https://s3.example.com', bucket: 'bkt', pathStyle: true, region: 'us-east-1' }, CREDENTIALS, { fetch });
    await expect(custom.putObject('k', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toThrow(/^HTTP 500 from the storage$/);
  });

  it('reports network failures and timeouts by code only', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.1:9000' } });
    const fetch = vi.fn(async () => { throw refused; });
    const client = new S3Client({ endpoint: 'http://10.0.0.1:9000', bucket: 'bkt', pathStyle: true, region: 'us-east-1' }, CREDENTIALS, { fetch });
    await expect(client.deleteObject('k')).rejects.toThrow(/^Connection failed \(ECONNREFUSED\)$/);
    expect(describeNetworkError(new DOMException('The operation timed out.', 'TimeoutError'), 30_000)).toBe('Timed out after 30 s');
    expect(describeNetworkError(new Error('https://user:pass@host/'), 30_000)).toBe('Connection failed');
  });

  it('passes a timeout signal and never follows redirects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new S3Client({ endpoint: 'https://s3.example.com', bucket: 'bkt', pathStyle: true, region: 'us-east-1' }, CREDENTIALS, { fetch, timeoutMs: 1234 });
    await client.deleteObject('k');
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('getObject', () => {
  it('returns the body and the metadata', async () => {
    const { fake, client } = setup({ endpoint: 'http://minio:9000', pathStyle: true, region: 'us-east-1' });
    fake.put('a.json', '{"x":1}', new Date(), { sha256: 'abc' });
    const result = await client.getObject('a.json', 1024);
    expect(result.body.toString()).toBe('{"x":1}');
    expect(result.metadata).toEqual({ sha256: 'abc' });
  });

  it('refuses objects larger than the limit', async () => {
    const { fake, client } = setup();
    fake.put('big.json', 'x'.repeat(2048));
    await expect(client.getObject('big.json', 1024)).rejects.toThrow(/larger than/);
  });

  it('reports a missing object', async () => {
    const { client } = setup();
    await expect(client.getObject('missing.json', 1024)).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' });
  });
});

describe('listObjects', () => {
  it('follows continuation tokens and decodes XML entities', async () => {
    const { fake, client } = setup();
    fake.pageSize = 2;
    for (const key of ['p/a&b.json', 'p/b.json', 'p/c.json', 'p/d.json', 'p/e.json', 'other/x.json']) fake.put(key, key);
    const result = await client.listObjects('p/');
    expect(result.complete).toBe(true);
    expect(result.objects.map((object) => object.key)).toEqual(['p/a&b.json', 'p/b.json', 'p/c.json', 'p/d.json', 'p/e.json']);
    expect(result.objects[0]).toMatchObject({ size: 10, lastModified: expect.stringMatching(/Z$/) });
    const lists = fake.requests.filter((request) => request.url.searchParams.get('list-type') === '2');
    expect(lists).toHaveLength(3);
    expect(lists[1].url.searchParams.get('continuation-token')).toBe('p/b.json');
  });

  it('parses a ListObjectsV2 document and rejects anything else', () => {
    const page = parseListObjectsV2(
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a&lt;b&#x2F;c&#39;</Key><Size>5</Size>' +
        '<LastModified>2026-10-01T00:00:00.000Z</LastModified></Contents><NextContinuationToken>tok&amp;en</NextContinuationToken></ListBucketResult>'
    );
    expect(page).toEqual({
      objects: [{ key: "a<b/c'", size: 5, lastModified: '2026-10-01T00:00:00.000Z' }],
      isTruncated: true,
      nextContinuationToken: 'tok&en',
    });
    expect(() => parseListObjectsV2('<html>login</html>')).toThrow(S3Error);
  });
});

describe('deleteObject', () => {
  it('deletes and treats a missing object as deleted', async () => {
    const { fake, client } = setup();
    fake.put('gone.json', 'x');
    await client.deleteObject('gone.json');
    expect(fake.objects.has('gone.json')).toBe(false);
    const fetch = vi.fn(async () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    const other = new S3Client({ endpoint: 'https://s3.example.com', bucket: 'bkt', pathStyle: true, region: 'us-east-1' }, CREDENTIALS, { fetch });
    await expect(other.deleteObject('missing')).resolves.toBeUndefined();
  });
});
