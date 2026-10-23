import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type DiffLine = {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type Chunk = {
  id: string;
  path: string;
  oldPath: string;
  header: string;
  lines: DiffLine[];
};

function decodePath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      const char = String.fromCodePoint(inner.codePointAt(i)!);
      bytes.push(...Buffer.from(char));
      i += char.length - 1;
      continue;
    }
    const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      i += octal.length;
    } else {
      const escaped = inner[++i] ?? "";
      const escapes: Record<string, string> = {
        t: "\t",
        n: "\n",
        r: "\r",
        "\\": "\\",
        '"': '"',
      };
      bytes.push(...Buffer.from(escapes[escaped] ?? escaped));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parseDiff(diff: string): Chunk[] {
  const chunks: Chunk[] = [];
  const sections = diff
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "));
  for (const section of sections) {
    const rows = section.replace(/\n$/, "").split("\n");
    const first = rows.shift()!;
    const paths = first
      .slice(11)
      .match(/(?:"(?:\\.|[^"\\])*"|.+?)(?= (?:"?b\/)|$)/g);
    let oldPath = decodePath(paths?.[0] ?? "a/unknown").replace(/^a\//, "");
    let path = decodePath(paths?.[1]?.trim() ?? "b/unknown").replace(
      /^b\//,
      "",
    );
    const metadata: DiffLine[] = [];
    const hunks: {
      header: string;
      lines: DiffLine[];
      oldCount: number;
      newCount: number;
    }[] = [];
    let current: (typeof hunks)[number] | undefined;
    let oldLine = 0;
    let newLine = 0;
    for (const row of rows) {
      const hunk = row.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
      );
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        current = {
          header: row,
          lines: [],
          oldCount: Number(hunk[2] ?? 1),
          newCount: Number(hunk[4] ?? 1),
        };
        hunks.push(current);
      } else if (current && row.startsWith("+")) {
        current.lines.push({
          kind: "add",
          text: row.slice(1),
          newLine: newLine++,
        });
      } else if (current && row.startsWith("-")) {
        current.lines.push({
          kind: "remove",
          text: row.slice(1),
          oldLine: oldLine++,
        });
      } else if (current && row.startsWith(" ")) {
        current.lines.push({
          kind: "context",
          text: row.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
      } else if (current && row.startsWith("\\")) {
        current.lines.push({ kind: "meta", text: row });
      } else if (row.startsWith("--- ")) {
        const name = decodePath(row.slice(4));
        if (name !== "/dev/null") oldPath = name.replace(/^a\//, "");
      } else if (row.startsWith("+++ ")) {
        const name = decodePath(row.slice(4));
        if (name !== "/dev/null") path = name.replace(/^b\//, "");
      } else if (row.startsWith("rename from ")) {
        oldPath = decodePath(row.slice(12));
        metadata.push({ kind: "meta", text: row });
      } else if (row.startsWith("rename to ")) {
        path = decodePath(row.slice(10));
        metadata.push({ kind: "meta", text: row });
      } else if (row && !row.startsWith("index ")) {
        metadata.push({ kind: "meta", text: row });
      }
    }
    for (const hunk of hunks) {
      const oldCount = hunk.lines.filter(
        (line) => line.oldLine !== undefined,
      ).length;
      const newCount = hunk.lines.filter(
        (line) => line.newLine !== undefined,
      ).length;
      if (oldCount !== hunk.oldCount || newCount !== hunk.newCount)
        throw new Error(
          `Incomplete diff for ${path}. Reload the source before continuing.`,
        );
    }
    if (hunks.length === 0) {
      chunks.push({
        id: `c${chunks.length + 1}`,
        path,
        oldPath,
        header: "File change",
        lines: metadata.length ? metadata : [{ kind: "meta", text: first }],
      });
    } else {
      hunks[0]!.lines.unshift(...metadata);
    }
    for (const hunk of hunks) {
      let remaining = hunk.lines;
      while (remaining.length) {
        let size = Math.min(24, remaining.length);
        if (remaining.length > 24) {
          const boundary = remaining
            .slice(8, 24)
            .findLastIndex((line) => line.text.trim() === "");
          if (boundary >= 0) size = boundary + 9;
        }
        if (
          remaining
            .slice(size)
            .every((line) => line.kind === "context" || line.kind === "meta")
        )
          size = remaining.length;
        const lines = remaining.slice(0, size);
        remaining = remaining.slice(size);
        chunks.push({
          id: `c${chunks.length + 1}`,
          path,
          oldPath,
          header: hunk.header,
          lines,
        });
      }
    }
  }
  return chunks;
}

export type Snapshot = {
  id: string;
  input: string;
  cwd: string;
  title: string;
  description: string;
  base: string;
  head: string;
  chunks: Chunk[];
  repository?: string;
  warning?: string;
};

async function run(
  program: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await execute(program, args, {
    cwd,
    signal,
    timeout: 45_000,
    maxBuffer: 2_000_000,
    encoding: "utf8",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    },
  });
  return stdout;
}

export async function loadSnapshot(
  input: string,
  cwd: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const pr = input
    .trim()
    .match(
      /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:\/files)?\/?(?:[?#].*)?$/,
    );
  let diff: string;
  let snapshot: Omit<Snapshot, "id" | "chunks">;
  if (pr) {
    const repository = pr[1]!;
    const endpoint = `repos/${repository}/pulls/${pr[2]}`;
    const metadata = JSON.parse(
      await run("gh", ["api", endpoint], cwd, signal),
    );
    const base = String(metadata.base?.sha);
    const head = String(metadata.head?.sha);
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head))
      throw new Error("GitHub did not return valid commit IDs.");
    const comparison = `repos/${repository}/compare/${base}...${head}`;
    const mergeBase = (
      await run(
        "gh",
        ["api", comparison, "--jq", ".merge_base_commit.sha"],
        cwd,
        signal,
      )
    ).trim();
    if (!/^[a-f0-9]{40}$/.test(mergeBase))
      throw new Error("Could not resolve the PR merge base.");
    diff = await run(
      "gh",
      ["api", comparison, "-H", "Accept: application/vnd.github.diff"],
      cwd,
      signal,
    );
    const actualFiles = (diff.match(/^diff --git /gm) ?? []).length;
    if (actualFiles !== metadata.changed_files)
      throw new Error(
        "GitHub returned an incomplete or changing diff. Retry once the PR is stable.",
      );
    snapshot = {
      input: input.trim(),
      cwd,
      repository,
      base: mergeBase,
      head,
      title: `PR #${pr[2]} · ${String(metadata.title)}`,
      description: String(metadata.body ?? ""),
    };
  } else {
    const refs = input.trim().split(/\s+/);
    if (
      refs.length > 2 ||
      refs.some((ref) => !ref || ref.startsWith("-") || ref.includes("\0")) ||
      input.includes("://")
    ) {
      throw new Error(
        "Use a GitHub PR URL, a base ref, or two refs: <base> <head>.",
      );
    }
    const git = (...args: string[]) =>
      run("git", ["-c", "core.quotePath=false", ...args], cwd, signal);
    const baseTip = (
      await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${refs[0]}^{commit}`,
      )
    ).trim();
    const head = (
      await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${refs[1] ?? "HEAD"}^{commit}`,
      )
    ).trim();
    const base = (await git("merge-base", baseTip, head)).trim();
    diff = await git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=4",
      base,
      head,
      "--",
    );
    snapshot = {
      input: input.trim(),
      cwd,
      base,
      head,
      title: `${refs[1] ?? "HEAD"} vs ${refs[0]}`,
      description: "Committed changes since the merge base.",
      warning: "Committed branch only; working tree changes are not included.",
    };
  }
  const chunks = parseDiff(diff);
  if (!chunks.length) throw new Error("No changes in this comparison.");
  if (diff.length > 180_000)
    throw new Error(
      "This diff is too large for a focused walkthrough (180,000 character limit). Choose a smaller commit range.",
    );
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.repository ?? cwd,
        snapshot.base,
        snapshot.head,
        diff,
      ]),
    )
    .digest("hex");
  return { ...snapshot, id, chunks };
}

export async function readSource(
  snapshot: Snapshot,
  path: string,
  version: "before" | "after",
  startLine: number,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    /[\x00-\x1f]/.test(path)
  ) {
    throw new Error("Invalid repository-relative path.");
  }
  const revision = version === "before" ? snapshot.base : snapshot.head;
  let text: string;
  if (snapshot.repository) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const result = JSON.parse(
      await run(
        "gh",
        [
          "api",
          `repos/${snapshot.repository}/contents/${encodedPath}?ref=${revision}`,
        ],
        snapshot.cwd,
        signal,
      ),
    );
    if (
      result.type !== "file" ||
      result.encoding !== "base64" ||
      result.size > 250_000
    )
      throw new Error("Source is not a small text file.");
    text = Buffer.from(result.content, "base64").toString("utf8");
  } else {
    text = await run(
      "git",
      ["show", `${revision}:${path}`],
      snapshot.cwd,
      signal,
    );
  }
  if (text.includes("\0") || text.length > 250_000)
    throw new Error("Source is binary or exceeds the 250,000 character limit.");
  const start = Math.max(1, Math.floor(startLine));
  const count = Math.max(1, Math.min(160, Math.floor(limit)));
  const rows = text.split("\n");
  return `${path} (${version}, ${revision.slice(0, 8)}; ${rows.length} lines)\n${rows
    .slice(start - 1, start - 1 + count)
    .map((row, i) => `${start + i}: ${row}`)
    .join("\n")}`;
}
