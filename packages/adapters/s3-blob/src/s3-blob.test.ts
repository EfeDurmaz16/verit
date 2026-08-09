import { createHash, createHmac } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeS3ObjectStore, s3ConfigFromEnv, type S3ObjectStoreConfig } from "./index";

const SECRET = "s3cr3t-do-not-log-me";

const config: S3ObjectStoreConfig = {
  endpoint: "https://acc123.r2.cloudflarestorage.com",
  bucket: "cyclops-proofs",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: SECRET,
  region: "auto",
};

const fullEnv = {
  CYCLOPS_S3_ENDPOINT: "https://acc123.r2.cloudflarestorage.com",
  CYCLOPS_S3_BUCKET: "cyclops-proofs",
  CYCLOPS_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
  CYCLOPS_S3_SECRET_ACCESS_KEY: SECRET,
};

interface Sent {
  readonly input: unknown;
  readonly init: RequestInit;
  readonly headers: Headers;
}

/** Captures the signed call instead of sending it. */
const capture = (respond: () => Response): Sent[] => {
  const seen: Sent[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
    seen.push({ input, init, headers: new Headers(init.headers) });
    return respond();
  });
  return seen;
};

afterEach(() => vi.unstubAllGlobals());

describe("s3ConfigFromEnv", () => {
  it("returns null when nothing is configured, so the caller keeps the fs store", () => {
    expect(s3ConfigFromEnv({ DATABASE_URL: "postgres://x" })).toBeNull();
  });

  it("reads a complete configuration and defaults the region to auto for R2", () => {
    expect(s3ConfigFromEnv(fullEnv)).toEqual(config);
  });

  it("honours an explicit region", () => {
    expect(s3ConfigFromEnv({ ...fullEnv, CYCLOPS_S3_REGION: "us-east-1" })?.region).toBe(
      "us-east-1",
    );
  });

  it("strips a trailing slash so the key is not double separated", () => {
    expect(
      s3ConfigFromEnv({ ...fullEnv, CYCLOPS_S3_ENDPOINT: "https://acc123.r2.cloudflarestorage.com/" })
        ?.endpoint,
    ).toBe("https://acc123.r2.cloudflarestorage.com");
  });

  it("refuses a half configuration and names only the missing variables", () => {
    const partial = { ...fullEnv, CYCLOPS_S3_SECRET_ACCESS_KEY: "" };
    expect(() => s3ConfigFromEnv(partial)).toThrow(/CYCLOPS_S3_SECRET_ACCESS_KEY/);
  });

  it("never puts a credential value in the error it throws", () => {
    try {
      s3ConfigFromEnv({ ...fullEnv, CYCLOPS_S3_BUCKET: "" });
      expect.unreachable("expected a half configuration to throw");
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
      expect(String(e)).not.toContain("AKIDEXAMPLE");
    }
  });

  it("rejects an endpoint that is not a URL and a bucket that is not a bucket name", () => {
    expect(() => s3ConfigFromEnv({ ...fullEnv, CYCLOPS_S3_ENDPOINT: "acc123" })).toThrow(
      /not a URL/,
    );
    expect(() => s3ConfigFromEnv({ ...fullEnv, CYCLOPS_S3_BUCKET: "Bad/Bucket" })).toThrow(
      /bucket name/,
    );
  });
});

describe("s3 request signing", () => {
  it("signs a put with SigV4 over the exact body it sends", async () => {
    const seen = capture(() => new Response(null, { status: 200 }));
    const store = makeS3ObjectStore(config);
    await Effect.runPromise(store.put("runs/run_1/prove.log", "hello\n", "text/plain"));

    const sent = seen[0];
    expect(sent).toBeDefined();
    if (!sent) return;
    expect(sent.init.method).toBe("PUT");
    expect(sent.input).toBe(
      "https://acc123.r2.cloudflarestorage.com/cyclops-proofs/runs/run_1/prove.log",
    );

    const auth = sent.headers.get("authorization") ?? "";
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );

    // R2 and MinIO both verify this against the body they receive.
    expect(sent.headers.get("x-amz-content-sha256")).toBe(
      createHash("sha256").update("hello\n").digest("hex"),
    );
    expect(sent.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(sent.headers.get("content-type")).toBe("text/plain");
  });

  it("sends a buffer body through an init, never a Request", async () => {
    // The regression this guards: Next.js patches the global fetch and rebuilds
    // a Request input from its body stream, which drops Content-Length, and S3
    // answers 411 MissingContentLength. An init with a buffer body keeps it.
    const seen = capture(() => new Response(null, { status: 200 }));
    await Effect.runPromise(makeS3ObjectStore(config).put("runs/run_1/a.log", "hello\n", "text/plain"));
    const sent = seen[0];
    expect(sent).toBeDefined();
    expect(typeof sent?.input).toBe("string");
    expect(sent?.init.body).toBeInstanceOf(ArrayBuffer);
    expect((sent?.init.body as ArrayBuffer).byteLength).toBe(6);
  });

  it("derives the signing key from secret, date, region and service", async () => {
    const datetime = "20260809T120000Z";
    const signer = new AwsV4Signer({
      method: "PUT",
      url: `${config.endpoint}/${config.bucket}/runs/run_1/prove.log`,
      body: "hello\n",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region,
      datetime,
    });

    // The same chain, computed independently: a wrong scope or a wrong ordering
    // in the key derivation changes this and nothing else would catch it.
    const hmac = (key: Buffer | string, data: string): Buffer =>
      createHmac("sha256", key).update(data).digest();
    const date = hmac(`AWS4${config.secretAccessKey}`, datetime.slice(0, 8));
    const region = hmac(date, config.region);
    const service = hmac(region, "s3");
    const signing = hmac(service, "aws4_request");
    const expected = createHmac("sha256", signing)
      .update(await signer.stringToSign())
      .digest("hex");

    expect(await signer.signature()).toBe(expected);
  });

  it("keeps the secret out of every header it puts on the wire", async () => {
    const seen = capture(() => new Response(null, { status: 200 }));
    await Effect.runPromise(makeS3ObjectStore(config).put("runs/run_1/a.log", "x", "text/plain"));
    const sent = seen[0];
    expect(sent).toBeDefined();
    expect([...(sent?.headers ?? new Headers())].length).toBeGreaterThan(0);
    for (const [, value] of sent?.headers ?? new Headers()) expect(value).not.toContain(SECRET);
  });
});

describe("s3 object store", () => {
  it("reads a body and its content type back", async () => {
    capture(
      () => new Response("hello\n", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const got = await Effect.runPromise(makeS3ObjectStore(config).get("runs/run_1/prove.log"));
    expect(new TextDecoder().decode(got?.body)).toBe("hello\n");
    expect(got?.contentType).toBe("text/plain");
  });

  it("returns null on 404 rather than failing", async () => {
    capture(() => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
    expect(await Effect.runPromise(makeS3ObjectStore(config).get("runs/run_1/gone.log"))).toBeNull();
  });

  it("fails with the status and the S3 code, and quotes nothing else of the body", async () => {
    capture(
      () =>
        new Response(
          `<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>AKIDEXAMPLE</AWSAccessKeyId></Error>`,
          { status: 403 },
        ),
    );
    const error = await Effect.runPromise(
      Effect.flip(makeS3ObjectStore(config).get("runs/run_1/a.log")),
    );
    expect(error.message).toContain("403");
    expect(error.message).toContain("SignatureDoesNotMatch");
    expect(error.message).not.toContain("AKIDEXAMPLE");
  });

  it("refuses a key that would escape the bucket prefix, before any request", async () => {
    const seen = capture(() => new Response(null, { status: 200 }));
    const store = makeS3ObjectStore(config);
    for (const key of ["../escape", "runs/../../escape", "/etc/passwd", "runs//x", "runs/a?b"]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(store.put(key, "x", "text/plain")))).toBe(
        true,
      );
      expect(Exit.isFailure(await Effect.runPromiseExit(store.get(key)))).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
});

/**
 * The real server. `docker compose up -d minio` then:
 *
 *   CYCLOPS_S3_TEST_ENDPOINT=http://localhost:9000 \
 *   CYCLOPS_S3_TEST_BUCKET=cyclops-proofs \
 *   CYCLOPS_S3_TEST_ACCESS_KEY_ID=cyclops \
 *   CYCLOPS_S3_TEST_SECRET_ACCESS_KEY=cyclops-dev-secret \
 *   pnpm --filter @cyclops/adapter-s3-blob test
 *
 * Unset, this suite is skipped, so CI without a bucket stays green.
 */
const live = process.env.CYCLOPS_S3_TEST_ENDPOINT
  ? {
      endpoint: process.env.CYCLOPS_S3_TEST_ENDPOINT,
      bucket: process.env.CYCLOPS_S3_TEST_BUCKET ?? "cyclops-proofs",
      accessKeyId: process.env.CYCLOPS_S3_TEST_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.CYCLOPS_S3_TEST_SECRET_ACCESS_KEY ?? "",
      region: process.env.CYCLOPS_S3_TEST_REGION ?? "us-east-1",
    }
  : null;

describe.skipIf(live === null)("s3 object store against a live server", () => {
  it("round-trips bytes unchanged", async () => {
    if (!live) return;
    const store = makeS3ObjectStore(live);
    const key = `runs/it_${Date.now()}/prove.log`;
    const body = new Uint8Array([0, 1, 2, 250, 251, 255, 10]);

    await Effect.runPromise(store.put(key, body, "application/octet-stream"));
    const got = await Effect.runPromise(store.get(key));
    expect(got?.body).toEqual(body);
    expect(got?.contentType).toBe("application/octet-stream");
  });

  it("answers null for a key the bucket never held", async () => {
    if (!live) return;
    const store = makeS3ObjectStore(live);
    expect(await Effect.runPromise(store.get(`runs/it_${Date.now()}/missing.log`))).toBeNull();
  });
});
