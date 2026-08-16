import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * One secret, one primitive. VERIT_SESSION_SECRET derives an AES-256-GCM key,
 * and the session cookie is sealed with it rather than merely signed: GCM
 * authenticates the cookie the way a signature would, and also keeps the user's
 * GitHub token out of anything a browser extension or a log can read.
 */
const keyFor = (secret: string): Buffer => scryptSync(secret, "verit.session.v1", 32);

let cachedKey: { secret: string; key: Buffer } | null = null;

const sessionKey = (): Buffer => {
  const secret = process.env.VERIT_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("VERIT_SESSION_SECRET must be set to at least 32 characters");
  }
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: keyFor(secret) };
  return cachedKey.key;
};

/** iv (12) | tag (16) | ciphertext, base64url. */
export const seal = (plaintext: string, key: Buffer = sessionKey()): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
};

/** null for anything that was not sealed by this key, including a tampered cookie. */
export const open = (sealed: string, key: Buffer = sessionKey()): string | null => {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
};

/** A repo ingest token. Shown once at registration, never stored in the clear. */
export const newIngestToken = (): string => `cyc_${randomBytes(32).toString("base64url")}`;

export const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Compares two hex digests without leaking where they diverge. Both sides are
 * sha256 output, so a length mismatch means the stored value is not a digest at
 * all, which is a rejection and not a comparison.
 */
export const constantTimeEqualHex = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
};

export const randomState = (): string => randomBytes(24).toString("base64url");
