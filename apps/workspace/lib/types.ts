export type Risk = 0 | 1 | 2 | 3; // none | low | medium | high

export interface FileChange {
  path: string;
  lang: "ts" | "rs" | "py" | "md" | "yml" | "json" | "rb" | "lua" | "swift" | "kt" | "go" ;
  additions: number;
  deletions: number;
  risk: Risk;
  summary: string;
  group: string;
  comments: number;
  tests: string[];
  security?: boolean;
  protocol?: boolean;
  hunk?: { header: string; lines: HunkLine[] };
}

export interface HunkLine {
  kind: "ctx" | "add" | "del";
  no: number | null;
  text: string;
}

export interface CICheck {
  id: string;
  name: string;
  status: "pass" | "fail" | "running" | "skipped";
  duration: string;
  detail?: string;
  logTail?: string[];
}

export interface EvidenceRef {
  id: string;
  file: string;
  lines: string;
  excerpt: string;
  note: string;
}

export interface Insight {
  id: string;
  kind: "security" | "compat" | "correctness" | "perf" | "design";
  title: string;
  body: string;
  confidence: number; // 0..1
  reasoning: string;
  evidence: EvidenceRef[];
  files: string[];
}

export interface Comment {
  id: string;
  author: string;
  role?: string;
  time: string;
  file?: string;
  line?: number;
  body: string;
  resolved: boolean;
  replies: number;
  topic: string;
}

export interface ArchNode {
  id: string;
  label: string;
  kind: "spec" | "core" | "sdk" | "infra";
  changed: boolean;
  detail: string;
  files: string[];
  x: number;
  y: number;
}

export interface ArchEdge {
  from: string;
  to: string;
  changed?: boolean;
}

export interface TimelineEvent {
  time: string;
  actor: string;
  text: string;
  kind: "commit" | "review" | "ci" | "system";
}

export interface ReviewStep {
  id: string;
  title: string;
  why: string;
  files: string[];
  minutes: number;
  risk: Risk;
}

export interface RiskCluster {
  id: string;
  title: string;
  level: Risk;
  summary: string;
  files: string[];
  insightId?: string;
}

export interface CompatCell {
  status: "done" | "partial" | "missing" | "na";
  note?: string;
}

export interface CompatRow {
  capability: string;
  cells: Record<string, CompatCell>; // keyed by sdk
}

export type Selection =
  | { kind: "file"; id: string }
  | { kind: "insight"; id: string }
  | { kind: "risk"; id: string }
  | { kind: "node"; id: string }
  | { kind: "check"; id: string }
  | { kind: "step"; id: string }
  | null;

export type Mode = "overview" | "protocol" | "security" | "risk";
