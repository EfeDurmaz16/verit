/* Legacy coding-CLI lane selection.

   This is the fallback path, reached only when no VERIT_LANE_PROVIDER is set.
   The default is the harness-independent HTTP lane in @verit/lane (see
   sessions.ts). Here the lane is one headless coding CLI behind a single
   contract: build argv, stream JSONL on stdout, reduce each line to a session
   id or a line of activity. Codex is the default CLI. Claude Code and the
   Cursor CLI agent are drop-in alternatives, picked with VERIT_LANE_HARNESS.

   Everything here is pure. The spawning, streaming and SSE plumbing lives in
   lane.ts, so arg building and event parsing stay testable without a process. */

export type LaneHarnessName = "codex" | "claude" | "cursor";

/** One stdout line, reduced to what the workspace needs from it. */
export interface LaneLine {
  readonly sessionId?: string;
  readonly activity?: string;
  readonly error?: string;
}

export interface SpawnOpts {
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly model?: string;
}

export interface LaneSpawn {
  readonly bin: string;
  readonly args: readonly string[];
  /** true when the prompt goes to stdin, so argv can never read it as a flag */
  readonly promptOnStdin: boolean;
}

export interface LaneAdapter {
  readonly name: LaneHarnessName;
  /** false when a follow up cannot reattach to the analysis session by id */
  readonly supportsResume: boolean;
  readonly spawn: (opts: SpawnOpts) => LaneSpawn;
  readonly parse: (line: string) => readonly LaneLine[];
}

const MAX_ACTIVITY = 160;

/* One scannable line. Drops the lane's own SpecStream appends: those already
   arrive as patches, so echoing them would narrate every block twice. */
const activity = (text: string | undefined): readonly LaneLine[] => {
  if (!text) return [];
  const one = text.replace(/\s+/g, " ").trim().slice(0, MAX_ACTIVITY);
  if (!one || /blocks[\w-]*\.ndjson/.test(one)) return [];
  return [{ activity: one }];
};

const json = (line: string): Record<string, unknown> | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const firstLine = (text: string | undefined): string | undefined => text?.split("\n")[0];

/* Claude Code and the Cursor agent both emit Anthropic shaped assistant
   messages, so one reader covers the text and thinking blocks of each. */
const assistantBlocks = (ev: Record<string, unknown>): readonly LaneLine[] => {
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => {
    const b = raw as {
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: { command?: string };
    };
    if (b.type === "tool_use") return activity(b.name === "Bash" ? b.input?.command : b.name);
    if (b.type === "thinking") return activity(firstLine(b.thinking));
    if (b.type === "text") return activity(firstLine(b.text));
    return [];
  });
};

const failure = (name: LaneHarnessName, ev: Record<string, unknown>): readonly LaneLine[] => {
  if (ev.is_error !== true) return [];
  const detail = typeof ev.result === "string" ? ev.result : String(ev.subtype ?? "unknown");
  return [{ error: `${name} lane reported failure: ${detail.slice(0, 300)}` }];
};

const CODEX_FLAGS = [
  "--json",
  "-s",
  "workspace-write",
  "-c",
  "sandbox_workspace_write.network_access=true",
  "--skip-git-repo-check",
] as const;

const codex: LaneAdapter = {
  name: "codex",
  /* `codex exec resume` rebuilds the sandbox from the stored thread, which is
     not what the command bar wants, and commandPrompt already restates the
     protocol and points at the PR files still on disk. Left stateless. */
  supportsResume: false,
  spawn: ({ prompt, resumeSessionId, model }) => {
    const flags = [...CODEX_FLAGS, ...(model ? ["-m", model] : [])];
    return {
      bin: "codex",
      args: resumeSessionId
        ? ["exec", ...flags, "resume", resumeSessionId, prompt]
        : ["exec", ...flags, prompt],
      promptOnStdin: false,
    };
  },
  parse: (line) => {
    const ev = json(line);
    if (!ev) return [];
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      return [{ sessionId: ev.thread_id }];
    }
    if (ev.type !== "item.completed") return [];
    const item = ev.item as { type?: string; command?: string; text?: string } | undefined;
    if (item?.type === "command_execution") return activity(item.command);
    if (item?.type === "reasoning") return activity(firstLine(item.text));
    return [];
  },
};

/* Claude Code headless. Flags checked against `claude --help` (2.1.219) and
   https://code.claude.com/docs/en/headless :
   - `-p` prints and exits; `--output-format stream-json` is refused without
     `--verbose` ("When using --print, --output-format=stream-json requires
     --verbose"), so the pair is not optional.
   - `--safe-mode` drops CLAUDE.md, skills, plugins, hooks and MCP servers.
     Session workdirs sit under the verit tree, so without it the lane would
     inherit this repo's and the operator's instructions while reading someone
     else's PR. Auth and permissions still work normally.
   - `--allowedTools` is the non-interactive grant. It is variadic, which is why
     the prompt goes on stdin: a trailing positional prompt would be eaten as
     another tool name.
   - `--resume <session_id>` works with `-p`, so the command bar reattaches to
     the analysis session instead of re-sending its context. */
const CLAUDE_TOOLS = "Read,Glob,Grep,Bash,Write,Edit";

const claude: LaneAdapter = {
  name: "claude",
  supportsResume: true,
  spawn: ({ resumeSessionId, model }) => ({
    bin: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--safe-mode",
      ...(model ? ["--model", model] : []),
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      "--allowedTools",
      CLAUDE_TOOLS,
    ],
    promptOnStdin: true,
  }),
  parse: (line) => {
    const ev = json(line);
    if (!ev) return [];
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      return [{ sessionId: ev.session_id }];
    }
    if (ev.type === "assistant") return assistantBlocks(ev);
    if (ev.type === "result") return failure("claude", ev);
    return [];
  },
};

/* Cursor CLI agent. Flags from https://cursor.com/docs/cli/reference/parameters
   and `cursor-agent --help` (2026.08.04). The docs name the command `agent`;
   the binary the installer puts on PATH is `cursor-agent`, which is what runs
   here. `--force` is the non-interactive tool grant. Thinking arrives as
   per-token deltas, which is too noisy for the activity line, so only tool
   calls and finished assistant messages are reported. */
const cursor: LaneAdapter = {
  name: "cursor",
  supportsResume: true,
  spawn: ({ prompt, resumeSessionId, model }) => ({
    bin: "cursor-agent",
    args: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--force",
      ...(model ? ["--model", model] : []),
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    ],
    promptOnStdin: false,
  }),
  parse: (line) => {
    const ev = json(line);
    if (!ev) return [];
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      return [{ sessionId: ev.session_id }];
    }
    if (ev.type === "tool_call" && ev.subtype === "started") {
      const call = ev.tool_call as
        | {
            shellToolCall?: { args?: { command?: string } };
            readToolCall?: { args?: { path?: string } };
          }
        | undefined;
      const read = call?.readToolCall?.args?.path;
      return activity(call?.shellToolCall?.args?.command ?? (read ? `read ${read}` : undefined));
    }
    if (ev.type === "assistant") return assistantBlocks(ev);
    if (ev.type === "result") return failure("cursor", ev);
    return [];
  },
};

const ADAPTERS: Record<LaneHarnessName, LaneAdapter> = { codex, claude, cursor };

/**
 * Resolve the lane harness. An unrecognised value throws instead of falling
 * back: a typo would otherwise review every PR with the wrong tool and look
 * completely normal while doing it.
 */
export function laneAdapter(value = process.env.VERIT_LANE_HARNESS): LaneAdapter {
  if (!value) return ADAPTERS.codex;
  const adapter = ADAPTERS[value as LaneHarnessName];
  if (!adapter) {
    throw new Error(`VERIT_LANE_HARNESS must be codex, claude or cursor, got "${value}"`);
  }
  return adapter;
}
