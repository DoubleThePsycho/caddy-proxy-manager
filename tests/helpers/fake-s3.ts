import { createHash } from 'node:crypto';

export type FakeObject = { body: Buffer; contentType: string | null; metadata: Record<string, string>; lastModified: Date };
export type FakeRequest = { method: string; url: URL; headers: Record<string, string>; body: Buffer | null };
export type FakeFailure = { status: number; code?: string; headers?: Record<string, string> };

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorResponse(failure: FakeFailure): Response {
  const body = failure.code
    ? `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${failure.code}</Code><Message>detail that must not leak</Message>` +
      '<StringToSign>AWS4-HMAC-SHA256 secret-bearing</StringToSign></Error>'
    : '';
  return new Response(body || null, { status: failure.status, headers: { 'content-type': 'application/xml', ...(failure.headers ?? {}) } });
}

/**
 * An in-memory S3 bucket behind a fetch function: PUT, GET, DELETE and
 * ListObjectsV2, path-style or virtual-hosted. Checks that every request is
 * SigV4-signed with the expected access key and that the signed payload hash
 * matches the body.
 */
export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: FakeRequest[] = [];
  /** Keys per ListObjectsV2 page, to exercise pagination. */
  pageSize = 1000;
  /** Returns a failure to answer a request with, or null to serve it. */
  fail: (method: string, key: string | null, url: URL) => FakeFailure | null = () => null;
  /** Called with each object read, to tamper with what GET returns. */
  tamper: ((body: Buffer) => Buffer) | null = null;
  /** Keys a listing shows (to simulate listings that lag behind writes). */
  listed: (key: string) => boolean = () => true;

  constructor(
    readonly options: { endpoint: string; bucket: string; pathStyle: boolean; accessKeyId: string; region?: string }
  ) {}

  put(key: string, body: string | Buffer, lastModified = new Date(), metadata: Record<string, string> = {}): void {
    this.objects.set(key, { body: Buffer.from(body), contentType: 'application/json', metadata, lastModified });
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  /** The object key of a request, or null for a bucket-level request. */
  private keyOf(url: URL): string | null {
    const endpoint = new URL(this.options.endpoint);
    if (this.options.pathStyle) {
      if (url.host !== endpoint.host) throw new Error(`unexpected host ${url.host}`);
      const [, bucket, ...rest] = url.pathname.split('/');
      if (bucket !== this.options.bucket) throw new Error(`unexpected bucket ${bucket}`);
      return rest.length === 0 ? null : decodeURIComponent(rest.join('/'));
    }
    if (url.host !== `${this.options.bucket}.${endpoint.host}`) throw new Error(`unexpected host ${url.host}`);
    const path = url.pathname.slice(1);
    return path === '' ? null : decodeURIComponent(path);
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    const body = init.body ? Buffer.from(init.body as Uint8Array) : null;
    this.requests.push({ method, url, headers, body });

    if (init.redirect !== 'manual') throw new Error('redirects must not be followed');
    if (!(init.signal instanceof AbortSignal)) throw new Error('requests must have a timeout');
    const region = this.options.region ?? 'us-east-1';
    const credential = new RegExp(
      `^AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/\\d{8}/${region}/s3/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$`
    );
    if (!credential.test(headers.authorization ?? '')) return errorResponse({ status: 403, code: 'SignatureDoesNotMatch' });
    const payloadHash = createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
    if (headers['x-amz-content-sha256'] !== payloadHash) return errorResponse({ status: 400, code: 'XAmzContentSHA256Mismatch' });

    const key = this.keyOf(url);
    const failure = this.fail(method, key, url);
    if (failure) return errorResponse(failure);

    if (key === null) {
      if (method !== 'GET' || url.searchParams.get('list-type') !== '2') return errorResponse({ status: 400, code: 'InvalidRequest' });
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token');
      const all = this.keys().filter((candidate) => candidate.startsWith(prefix) && this.listed(candidate));
      const start = after ? all.findIndex((candidate) => candidate > after) : 0;
      const page = start < 0 ? [] : all.slice(start, start + this.pageSize);
      const truncated = start >= 0 && start + this.pageSize < all.length;
      const contents = page
        .map((candidate) => {
          const object = this.objects.get(candidate)!;
          return `<Contents><Key>${escapeXml(candidate)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified>` +
            `<ETag>&quot;x&quot;</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
        })
        .join('');
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        `<Name>${this.options.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
        `<MaxKeys>${this.pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}` +
        (truncated ? `<NextContinuationToken>${escapeXml(page[page.length - 1])}</NextContinuationToken>` : '') +
        '</ListBucketResult>';
      return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
    }

    if (method === 'PUT') {
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        if (name.startsWith('x-amz-meta-')) metadata[name.slice('x-amz-meta-'.length)] = value;
      }
      this.objects.set(key, { body: body ?? Buffer.alloc(0), contentType: headers['content-type'] ?? null, metadata, lastModified: new Date() });
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    if (method === 'GET') {
      const object = this.objects.get(key);
      if (!object) return errorResponse({ status: 404, code: 'NoSuchKey' });
      const responseHeaders: Record<string, string> = { 'content-type': object.contentType ?? 'binary/octet-stream' };
      for (const [name, value] of Object.entries(object.metadata)) responseHeaders[`x-amz-meta-${name}`] = value;
      const served = this.tamper ? this.tamper(object.body) : object.body;
      return new Response(new Uint8Array(served), { status: 200, headers: responseHeaders });
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return errorResponse({ status: 405, code: 'MethodNotAllowed' });
  };
}
