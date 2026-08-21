import { decodeRunUpload, type RunUpload } from "@verit/domain";
import { Either } from "effect";
import { constantTimeEqualHex, hashToken } from "./crypto";
import type { RepoRow } from "./runs";

/** A digest of the right shape that matches nothing, for the unknown-repo path. */
const DECOY_HASH = hashToken("verit.ingest.decoy");

export const bearerToken = (header: string | null): string | null => {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
};

/**
 * Authenticates one upload. The token is hashed and compared against the
 * stored digest in constant time. An unknown repo still runs the comparison
 * against a decoy digest, so "no such repo" and "wrong token" cost the same
 * and answer the same: 401, with nothing said about which it was.
 *
 * A revoked repo is rejected even when its token still matches: the comparison
 * runs first so the timing is unchanged, then revocation vetoes the result.
 */
export const authorizeIngest = (repo: RepoRow | null, token: string | null): boolean => {
  const presented = hashToken(token ?? "");
  const stored = repo?.ingestTokenHash ?? DECOY_HASH;
  const ok = constantTimeEqualHex(presented, stored);
  return ok && repo !== null && token !== null && repo.revokedAt == null;
};

export type ParseResult =
  | { readonly ok: true; readonly upload: RunUpload }
  | { readonly ok: false; readonly error: string };

/**
 * Validates the body against the @verit/domain schema. Everything past this
 * point is a decoded RunUpload, never raw JSON, so no page renders a field
 * that was never checked.
 */
export const parseUpload = (body: unknown, repoFromHeader: string): ParseResult => {
  const decoded = decodeRunUpload(body);
  if (Either.isLeft(decoded)) {
    return { ok: false, error: `payload does not match the run schema: ${decoded.left.message}` };
  }
  const upload = decoded.right;
  if (upload.repo !== repoFromHeader) {
    return { ok: false, error: "payload repo does not match the authenticated repo" };
  }
  return { ok: true, upload };
};
