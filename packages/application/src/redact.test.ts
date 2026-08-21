import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact";

/**
 * Ten secret shapes planted into a realistic prove log tail, each on its own
 * line, wrapped in ordinary log lines that must survive untouched.
 */
const SECRETS: Record<string, string> = {
  githubClassic: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",
  githubFineGrained:
    "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ",
  veritIngest: "vrt_aB3xYz09-_KpQrStUvWxYz012345678",
  awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  awsSecretAssign: "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  bearerHeader: "Authorization: Bearer sk_live_51HabcdEFGhijklMNOpqrstuvwx",
  dsnPassword: "postgres://verit:sup3r-s3cret-pw@db.example.com:5432/verit",
  openaiKey: "sk-proj-abcdef0123456789ABCDEFghijklmnop",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  privateKey:
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabc123def456\n-----END RSA PRIVATE KEY-----",
};

const REAL_LINES = [
  "$ pnpm test",
  "cwd:   /work/acme/widgets (acme/widgets)",
  "head:  9f2a1c3, tree clean",
  "PASS src/sender.test.ts (12 tests) 1.2s",
  "exit:  0 after 3.4s",
  "connecting to db.example.com:5432 ok",
];

/** Interleave real lines and secret lines into one log tail. */
const logTail = (): string => {
  const lines: string[] = [];
  const secrets = Object.values(SECRETS);
  for (let i = 0; i < REAL_LINES.length; i++) {
    lines.push(REAL_LINES[i] as string);
    if (secrets[i]) lines.push(secrets[i] as string);
  }
  for (const s of secrets.slice(REAL_LINES.length)) lines.push(s);
  return lines.join("\n");
};

describe("redactSecrets", () => {
  it("masks all ten planted secret shapes", () => {
    const out = redactSecrets(logTail());
    for (const [name, secret] of Object.entries(SECRETS)) {
      // The DSN keeps its scheme, host and username; only the password goes.
      const bare = name === "dsnPassword" ? "sup3r-s3cret-pw" : secret.split("\n")[0] ?? secret;
      if (name === "githubFineGrained" || name === "veritIngest") {
        expect(out, name).not.toContain(secret);
      } else {
        expect(out, name).not.toContain(bare);
      }
    }
    // No PEM material survives.
    expect(out).not.toContain("MIIEowIBAAKCAQEAxyz");
    expect(out).not.toContain("bPxRfiCYEXAMPLEKEY");
  });

  it("leaves the surrounding real log lines intact", () => {
    const out = redactSecrets(logTail());
    for (const line of REAL_LINES) expect(out).toContain(line);
  });

  it("is a no-op on a log with no secrets", () => {
    const clean = REAL_LINES.join("\n");
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("keeps the DSN scheme, host and user, dropping only the password", () => {
    const out = redactSecrets(SECRETS.dsnPassword as string);
    expect(out).toBe("postgres://verit:[REDACTED]@db.example.com:5432/verit");
  });
});
