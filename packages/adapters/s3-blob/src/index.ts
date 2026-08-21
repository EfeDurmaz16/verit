import { AwsV4Signer } from "aws4fetch";
import { Effect } from "effect";
import type { ObjectStorePort, StoredObject } from "@verit/ports";
import { assertSafeObjectKey, StoreError } from "@verit/ports";

export interface S3ObjectStoreConfig {
  /** Origin only, no bucket and no trailing slash, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** R2 wants `auto`. MinIO and AWS want a real region. */
  readonly region: string;
}

/** Bucket names go straight into the URL path, so only the S3 alphabet is allowed. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The variable names. Only a name from here ever appears in an error. */
const ENV = {
  endpoint: "VERIT_S3_ENDPOINT",
  bucket: "VERIT_S3_BUCKET",
  accessKeyId: "VERIT_S3_ACCESS_KEY_ID",
  secretAccessKey: "VERIT_S3_SECRET_ACCESS_KEY",
} as const;

/** Optional, so it is not part of the all-or-nothing check above. */
const REGION_ENV = "VERIT_S3_REGION";

/**
 * Reads the S3 configuration out of an environment.
 *
 * Three outcomes, and the middle one is the point: none of the variables set
 * means "this deployment does not use S3", so the caller falls back to the
 * filesystem store. Some of them set means a half-finished configuration, and
 * that throws rather than silently writing run logs to a disk that Vercel
 * discards. Only variable names appear in the error, never their values.
 */
export const s3ConfigFromEnv = (
  env: Record<string, string | undefined>,
): S3ObjectStoreConfig | null => {
  const present = Object.values(ENV).filter((name) => (env[name] ?? "").length > 0);
  if (present.length === 0) return null;

  const missing = Object.values(ENV).filter((name) => (env[name] ?? "").length === 0);
  if (missing.length > 0) {
    throw new StoreError(`S3 object store is half configured, missing: ${missing.join(", ")}`);
  }

  const endpoint = (env[ENV.endpoint] ?? "").replace(/\/+$/, "");
  const bucket = env[ENV.bucket] ?? "";
  let origin: URL;
  try {
    origin = new URL(endpoint);
  } catch {
    throw new StoreError(`${ENV.endpoint} is not a URL`);
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new StoreError(`${ENV.endpoint} must be http or https`);
  }
  if (!BUCKET.test(bucket)) {
    throw new StoreError(`${ENV.bucket} is not a valid S3 bucket name`);
  }

  return {
    endpoint,
    bucket,
    accessKeyId: env[ENV.accessKeyId] ?? "",
    secretAccessKey: env[ENV.secretAccessKey] ?? "",
    // R2 aliases an empty region and us-east-1 onto `auto`; every other server
    // wants its own, so it stays configurable with R2's answer as the default.
    region: env[REGION_ENV] || "auto",
  };
};

/**
 * aws4fetch signs S3 header requests as `UNSIGNED-PAYLOAD` unless the header is
 * already set. The bodies here are whole log files that are in memory anyway,
 * so hashing them is cheap and puts the body inside the signature: a truncated
 * or altered upload is then rejected by the server rather than stored. WebCrypto
 * rather than node:crypto, to keep the adapter usable on an edge runtime.
 */
const signedBody = async (
  body: string | Uint8Array,
): Promise<{ readonly bytes: ArrayBuffer; readonly sha256: string }> => {
  const source = typeof body === "string" ? new TextEncoder().encode(body) : body;
  // One copy into a plain, whole ArrayBuffer, so the bytes that are hashed and
  // the bytes that are sent cannot differ: a caller's view may be a subarray.
  const bytes = new Uint8Array(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return { bytes: bytes.buffer, sha256 };
};

/** The S3 error code, which is safe to show. The rest of the body is not quoted. */
const errorCode = (body: string): string => /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? "";

const failed = (what: string, res: Response, body: string): StoreError => {
  const code = errorCode(body);
  return new StoreError(`s3 object ${what} failed: ${res.status}${code ? ` ${code}` : ""}`);
};

/**
 * The S3-compatible object store. Path style (`<endpoint>/<bucket>/<key>`),
 * which is what R2's account endpoint and MinIO both serve, so one shape covers
 * both. The key alphabet enforced by the port needs no URL escaping, which is
 * why the key can be concatenated: a key that would need escaping is refused
 * before it reaches the URL.
 *
 * Credentials live only inside the signer and only ever reach the wire as an
 * `Authorization` header. No branch here puts a header or a response body into
 * an error or a log.
 */
export const makeS3ObjectStore = (config: S3ObjectStoreConfig): ObjectStorePort => {
  /** Derived signing keys, reused across requests within a day. */
  const keyCache = new Map<string, ArrayBuffer>();

  const url = (key: string): string => {
    assertSafeObjectKey(key);
    return `${config.endpoint}/${config.bucket}/${key}`;
  };

  /**
   * Signs, then sends as `fetch(url, init)`.
   *
   * Not `AwsClient.fetch`, which hands `fetch` a `Request`. Next.js patches the
   * global `fetch` and rebuilds a `Request` input from `request.body`, a stream,
   * so the outgoing PUT loses its `Content-Length` and S3 answers
   * 411 MissingContentLength. Passing an init with a buffer body keeps the
   * length, on a patched `fetch` and a plain one alike.
   */
  const send = async (
    method: "GET" | "PUT" | "DELETE",
    target: string,
    body?: { readonly bytes: ArrayBuffer; readonly sha256: string },
    contentType?: string,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body) {
      headers["Content-Type"] = contentType ?? "application/octet-stream";
      headers["X-Amz-Content-Sha256"] = body.sha256;
    }
    const signed = await new AwsV4Signer({
      method,
      url: target,
      headers,
      body: body?.bytes,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      cache: keyCache,
    }).sign();

    // `cache` is not in Node's own RequestInit, but a framework that wraps
    // fetch reads it. An object store call is never served from a cache.
    const init: RequestInit & { cache: "no-store" } = {
      method,
      headers: signed.headers,
      body: body?.bytes,
      cache: "no-store",
    };
    return fetch(signed.url.toString(), init);
  };

  return {
    put: (key, body, contentType) =>
      Effect.tryPromise({
        try: async () => {
          const target = url(key);
          const res = await send("PUT", target, await signedBody(body), contentType);
          if (!res.ok) throw failed("put", res, await res.text().catch(() => ""));
          // The body is never read on success, but it must be drained.
          await res.arrayBuffer().catch(() => undefined);
        },
        catch: (e) => (e instanceof StoreError ? e : new StoreError("s3 object put", e)),
      }),

    get: (key) =>
      Effect.tryPromise({
        try: async (): Promise<StoredObject | null> => {
          const res = await send("GET", url(key));
          if (res.status === 404) return null;
          if (!res.ok) throw failed("get", res, await res.text().catch(() => ""));
          const buffer = await res.arrayBuffer();
          return {
            body: new Uint8Array(buffer),
            contentType: res.headers.get("content-type") ?? "application/octet-stream",
          };
        },
        catch: (e) => (e instanceof StoreError ? e : new StoreError("s3 object get", e)),
      }),

    delete: (key) =>
      Effect.tryPromise({
        try: async () => {
          const res = await send("DELETE", url(key));
          // S3 answers 204 whether or not the key existed, so a delete is
          // idempotent by the protocol. 404 is folded in for stores that 404.
          if (!res.ok && res.status !== 404) {
            throw failed("delete", res, await res.text().catch(() => ""));
          }
          await res.arrayBuffer().catch(() => undefined);
        },
        catch: (e) => (e instanceof StoreError ? e : new StoreError("s3 object delete", e)),
      }),
  };
};
