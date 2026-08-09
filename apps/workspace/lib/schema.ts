/* ---- events sent to the client over SSE ---- */

export interface StreamEvent {
  kind: "patch" | "answer" | "activity" | "session" | "done" | "error";
  /** raw SpecStream JSONL line (kind: patch) */
  line?: string;
  text?: string;
  threadId?: string;
  workdir?: string;
}

/* ---- structural PR data fetched via gh (no AI) ---- */

export interface PRFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface PRCheck {
  name: string;
  workflow: string;
  status: "pass" | "fail" | "running" | "skipped";
  url?: string;
}

export interface PRMeta {
  repo: string;
  number: number;
  headSha: string;
  title: string;
  author: string;
  branch: string;
  base: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { sha: string; message: string; author: string; date: string }[];
  reviews: { author: string; state: string; body: string; date: string }[];
  comments: { author: string; body: string; date: string }[];
  checks: PRCheck[];
  files: PRFile[];
  url: string;
}
