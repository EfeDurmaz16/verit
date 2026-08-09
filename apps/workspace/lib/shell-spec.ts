import type { PRMeta } from "./schema";

/* Instant workspace shell built from GitHub structural data — streamed to the
   client as SpecStream patches before the AI produces anything, and handed to
   the agent as the current spec it should evolve. */

type El = { type: string; props: Record<string, unknown>; children: string[] };

export function buildShellSpec(pr: PRMeta): {
  lines: string[];
  spec: { root: string; elements: Record<string, El> };
} {
  const elements: Record<string, El> = {};
  const el = (key: string, type: string, props: Record<string, unknown>, children: string[] = []) => {
    elements[key] = { type, props, children };
    return key;
  };

  // group files by top-level path segment(s)
  const groups = new Map<string, PRMeta["files"]>();
  for (const f of pr.files) {
    const parts = f.path.split("/");
    const g = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : "root";
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const fgKeys = [...groups.entries()].map(([title, files], i) =>
    el(`fg-${i}`, "FileGroup", {
      title,
      files: files.map((f) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        risk: 0,
        tags: [],
      })),
    }),
  );

  el("status-el", "Status", { text: "Reading the diff and review threads…" });
  el("sec-status", "Section", { id: "analysis", title: "Analysis" }, ["status-el"]);

  /* One slot per Understanding field, in the locked proof-page order:
     understanding → proof → risks → out of scope. Empty slots render as
     pending skeletons while the lane streams into them. */
  el("sec-understanding", "Section", { id: "understanding", title: "Understanding", hint: "what · why · how" }, []);
  el("sec-proof", "Section", { id: "proof", title: "Proof", hint: "how to verify the behaviour" }, []);
  el("sec-risks", "Section", { id: "risks", title: "Risks" }, []);
  el("sec-out-of-scope", "Section", { id: "out-of-scope", title: "Out of scope" }, []);

  el("sec-files", "Section", {
    id: "changed-files",
    title: "Changed files",
    hint: `${pr.changedFiles} files · grouped by path`,
  }, fgKeys);

  const sections = [
    "sec-status",
    "sec-understanding",
    "sec-proof",
    "sec-risks",
    "sec-files",
  ];

  if (pr.checks.length) {
    const failing = pr.checks.filter((c) => c.status === "fail").length;
    el("ci-el", "CIStatus", {
      checks: pr.checks.map((c) => ({ name: c.name, status: c.status, url: c.url })),
    });
    el("sec-ci", "Section", {
      id: "ci",
      title: "CI",
      hint: `${pr.checks.length - failing}/${pr.checks.length} passing`,
    }, ["ci-el"]);
    sections.push("sec-ci");
  }
  sections.push("sec-out-of-scope");

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const events = [
    ...pr.commits.map((c) => ({
      time: fmt(c.date),
      actor: c.author,
      text: `${c.message} (${c.sha})`,
      kind: "commit" as const,
      date: c.date,
    })),
    ...pr.reviews.map((r) => ({
      time: fmt(r.date),
      actor: r.author,
      text:
        r.state === "APPROVED"
          ? "approved"
          : r.state === "CHANGES_REQUESTED"
            ? "requested changes"
            : "reviewed",
      kind: "review" as const,
      date: r.date,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  if (events.length) {
    el("tl-el", "Timeline", {
      events: events.map(({ time, actor, text, kind }) => ({ time, actor, text, kind })),
    });
    el("sec-timeline", "Section", { id: "timeline", title: "Timeline" }, ["tl-el"]);
    sections.push("sec-timeline");
  }

  el("ws", "Workspace", {}, sections);

  // elements before any reference to them; root last
  const lines = [
    ...Object.entries(elements).map(([key, value]) =>
      JSON.stringify({ op: "add", path: `/elements/${key}`, value }),
    ),
    JSON.stringify({ op: "add", path: "/root", value: "ws" }),
  ];

  return { lines, spec: { root: "ws", elements } };
}
