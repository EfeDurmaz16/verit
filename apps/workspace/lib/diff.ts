export interface DiffLine {
  kind: "ctx" | "add" | "del";
  no: number | null; // new-file line number (null for deletions)
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/* Parse a unified `gh pr diff` patch into per-file hunks, numbered against the
   new file so evidence line references resolve. */
export function parseDiff(patch: string): Map<string, DiffHunk[]> {
  const files = new Map<string, DiffHunk[]>();
  let path: string | null = null;
  let hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let newNo = 0;

  const flushFile = () => {
    if (path) files.set(path, hunks);
    path = null;
    hunks = [];
    hunk = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      path = p === "/dev/null" ? path : p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/\+(\d+)/);
      newNo = m ? Number(m[1]) : 1;
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", no: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", no: null, text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "ctx", no: newNo++, text: line.slice(1) });
    }
    // "\ No newline at end of file" etc. — skip
  }
  flushFile();
  return files;
}
