/*
 * The environment a probe runs in.
 *
 * A probe is untrusted twice over. It may be a test the pull request author
 * wrote, and on the generated path it is code a model wrote. Either way it
 * executes, so the only safe assumption is that whatever it can read, it reads.
 *
 * This is deliberately not `proveChildEnv`. That one hands the full environment
 * through on GitHub Actions, on the reasoning that the runner is the isolation
 * boundary and workflows rely on job-level env. That reasoning does not survive
 * contact with a probe: the job holds the model key, the GitHub token, the
 * ingest token and the signing key, and a probe has no business seeing any of
 * them on any platform. So there is no CI branch here. The allowlist is the
 * allowlist everywhere, and `secretsIn` exists to fail the build if something
 * secret-shaped ever survives it.
 */

/** What a test suite legitimately needs. Nothing here identifies or authorizes. */
const RUNNER_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "USER",
  "LOGNAME",
  "CI",
  "NODE_ENV",
  "TERM",
  // language toolchains
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "JAVA_HOME",
  "GEM_HOME",
  "BUNDLE_PATH",
]);

const ALLOWED_PREFIXES = ["npm_config_"];

/**
 * Names that must never reach a probe, whatever an allowlist says.
 *
 * The pattern is broad on purpose. A key called `MY_COMPANY_DEPLOY_TOKEN` is
 * not on any list of ours, and it is exactly the sort of thing a repository's
 * CI has lying around.
 */
const SECRET_SHAPED = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^.*_API_KEY$|APIKEY|SESSION|COOKIE|PRIVATE)/i;

/** Named outright, because these are ours and their absence is the guarantee. */
export const VERIT_SECRET_KEYS: readonly string[] = [
  "VERIT_LANE_API_KEY",
  "VERIT_INGEST_TOKEN",
  "VERIT_JOB_SPEC_SECRET",
  "VERIT_JOB_SPEC_PRIVATE_KEY",
  "VERIT_ARTIFACT_CAPABILITY_SECRET",
  "VERIT_SESSION_SECRET",
  "VERIT_TOKEN_DIR",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "VERIT_S3_SECRET_ACCESS_KEY",
  "VERIT_NEO4J_PASSWORD",
  "DATABASE_URL",
  "STRIPE_SECRET_KEY",
];

/**
 * Every key in `env` that looks like it authorizes something.
 *
 * Used as an assertion rather than a filter: the filter already ran, and if
 * this returns anything the filter has a hole worth failing a test over.
 */
export const secretsIn = (env: NodeJS.ProcessEnv): readonly string[] =>
  Object.keys(env).filter(
    (k) => VERIT_SECRET_KEYS.includes(k) || SECRET_SHAPED.test(k),
  );

/**
 * The environment a probe gets. An allowlist, on every platform, with no
 * escape hatch for CI.
 *
 * `VERIT_PROBE_ENV` lets an operator name extra keys their suite genuinely
 * needs, the same lever prove has. A named key that is secret-shaped is still
 * refused: naming it does not make it safe, and the operator who needs a token
 * inside a probe has a design problem this cannot solve for them.
 */
export const runnerChildEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const declared = new Set(
    (base.VERIT_PROBE_ENV ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== "" && !SECRET_SHAPED.test(k) && !VERIT_SECRET_KEYS.includes(k)),
  );

  // Scrub by deletion from a copy, so the augmented ProcessEnv shape some apps
  // declare (Next requires NODE_ENV) stays satisfied without a cast.
  const child = { ...base };
  for (const key of Object.keys(child)) {
    const denied = VERIT_SECRET_KEYS.includes(key) || SECRET_SHAPED.test(key);
    const allowed =
      !denied &&
      (RUNNER_ALLOWLIST.has(key) ||
        declared.has(key) ||
        ALLOWED_PREFIXES.some((p) => key.startsWith(p)));
    if (!allowed) delete child[key];
  }
  return { ...child, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
};
