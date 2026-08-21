/**
 * Masks common secret shapes in a block of log text before it leaves the
 * runner. A repo's own verification command should never print a token, but a
 * misbehaving script can, and the prove log tail is stored and shown on the
 * proof page. This runs on the tail and the whole log body before upload, so a
 * leaked secret never reaches Neon or R2.
 *
 * Each pattern replaces only the secret value, never the line around it, so a
 * real failure stays readable. This is a best-effort denylist, not a proof: it
 * catches the shapes that leak in practice, and a novel secret format can still
 * slip through.
 *
 * ponytail: denylist heuristic, extend the pattern list as new shapes appear.
 */
const REDACTED = "[REDACTED]";

/** A PEM private key block, from the BEGIN line through the END line. */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** `scheme://user:password@host`: mask only the password, keep the rest. */
const DSN_PASSWORD = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/g;

/** `Bearer <token>` in an Authorization header line. */
const BEARER = /\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * Provider tokens that carry their own prefix: GitHub (`ghp_`, `github_pat_`),
 * verit ingest (`vrt_`), OpenAI/Stripe-style (`sk-`, `sk_live_`), Slack
 * (`xoxb-`), and AWS access key ids (`AKIA`, `ASIA`).
 */
const PREFIXED =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|vrt_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{10,}|xox[abposr]-[A-Za-z0-9-]{10,}|A[KS]IA[0-9A-Z]{16})\b/g;

/** A three-segment JWT. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

/**
 * A `key = value` or `key: value` where the key names a secret. Catches AWS
 * secret access keys and any `*_password`, `*_token`, `*api_key`, `*secret*`
 * assignment. The value is masked; a quote pair around it is preserved.
 */
const SECRET_ASSIGN =
  /([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*\s*[=:]\s*)(["']?)([^\s"']+)\2/gi;

export const redactSecrets = (text: string): string =>
  text
    .replace(PEM, REDACTED)
    .replace(DSN_PASSWORD, `$1${REDACTED}@`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(JWT, REDACTED)
    .replace(SECRET_ASSIGN, `$1$2${REDACTED}$2`);
