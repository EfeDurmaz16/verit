import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { takeLaneHostSecrets } from "./host-env";

const srcDir = dirname(fileURLToPath(import.meta.url));

const repoRoot = (): string => {
  let dir = srcDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
};

describe("takeLaneHostSecrets", () => {
  it("reads VERIT_TOKEN_DIR and unlinks the files", () => {
    const dir = mkdtempSync(join(tmpdir(), "verit-token-dir-"));
    writeFileSync(join(dir, "github"), "ghp_from_dir");
    writeFileSync(join(dir, "ingest"), "vit_from_dir");
    const env: NodeJS.ProcessEnv = { VERIT_TOKEN_DIR: dir };
    const secrets = takeLaneHostSecrets(env);
    expect(secrets.GITHUB_TOKEN).toBe("ghp_from_dir");
    expect(secrets.VERIT_INGEST_TOKEN).toBe("vit_from_dir");
    expect(existsSync(join(dir, "github"))).toBe(false);
    expect(existsSync(join(dir, "ingest"))).toBe(false);
    expect(env.VERIT_TOKEN_DIR).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

/*
 * The remaining P0-2 path: after laneChildEnv, bash has no tokens, but
 * /proc/$PPID/environ still listed them because the host was started with
 * GITHUB_TOKEN and VERIT_INGEST_TOKEN. This probe is that host. On main
 * (no re-exec) the tokens appear in the tool result. After the re-exec they
 * do not.
 */
describe.skipIf(process.platform === "win32")("lane host exec environ", () => {
  it("does not put host tokens in the bash tool result via /proc/ppid/environ", () => {
    const github = "ghp_p02_parent_environ_probe_7f3a";
    const ingest = "vit_p02_parent_environ_probe_7f3a";
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(srcDir, "host-env-probe.ts")],
      {
        cwd: repoRoot(),
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_TOKEN: github,
          VERIT_INGEST_TOKEN: ingest,
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(github);
    expect(r.stdout).not.toContain(ingest);
    const parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ isError: false });
  });
});
