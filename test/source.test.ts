import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSnapshot, parseDiff, readSource } from "../src/source.ts";

const diff = `diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -10,3 +10,4 @@ function run() {
 const input = read();
-return input;
+const result = validate(input);
+return result;
 }
`;

test("a walkthrough preserves exact additions, deletions and both line numbers", () => {
  const chunks = parseDiff(diff);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.path, "app.ts");
  assert.deepEqual(chunks[0]?.lines, [
    {
      kind: "context",
      text: "const input = read();",
      oldLine: 10,
      newLine: 10,
    },
    { kind: "remove", text: "return input;", oldLine: 11 },
    { kind: "add", text: "const result = validate(input);", newLine: 11 },
    { kind: "add", text: "return result;", newLine: 12 },
    { kind: "context", text: "}", oldLine: 12, newLine: 13 },
  ]);
});

test("local snapshots use the merge base and stay pinned after the working tree changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "walkthrough-test-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd, encoding: "utf8" },
    ).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
    git("add", ".");
    git("commit", "-qm", "Initial");
    git("checkout", "-qb", "feature");
    await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
    git("commit", "-qam", "Change value");
    git("checkout", "-q", "main");
    await writeFile(join(cwd, "unrelated.ts"), "Only on main\n");
    git("add", ".");
    git("commit", "-qm", "Main moved forward");
    git("checkout", "-q", "feature");
    const snapshot = await loadSnapshot(
      "main",
      cwd,
      new AbortController().signal,
    );
    await writeFile(join(cwd, "app.ts"), "not committed\n");
    const contents = await readSource(
      snapshot,
      "app.ts",
      "after",
      1,
      20,
      new AbortController().signal,
    );
    assert.match(contents, /1: export const value = 2;/);
    assert.equal(snapshot.chunks[0]?.lines[0]?.text, "export const value = 1;");
    assert.deepEqual(
      [...new Set(snapshot.chunks.map((chunk) => chunk.path))],
      ["app.ts"],
    );
    assert.ok(snapshot.warning?.includes("working tree"));
    await assert.rejects(
      readSource(
        snapshot,
        "../outside",
        "after",
        1,
        10,
        new AbortController().signal,
      ),
      /path/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("binary, rename and mode-only changes cannot disappear from the walkthrough", () => {
  const chunks = parseDiff(`diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
diff --git a/run b/run
old mode 100644
new mode 100755
`);
  assert.deepEqual(
    chunks.map((chunk) => chunk.path),
    ["logo.png", "new name.ts", "run"],
  );
  assert.equal(chunks[1]?.oldPath, "old name.ts");
});

test("large hunks are bite-sized without losing any changed lines", () => {
  const body = Array.from({ length: 100 }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  const chunks = parseDiff(
    `diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1,100 @@\n${body}\n`,
  );
  assert.ok(chunks.every((chunk) => chunk.lines.length <= 24));
  assert.equal(chunks.flatMap((chunk) => chunk.lines).length, 100);
  assert.equal(chunks.at(-1)?.lines.at(-1)?.newLine, 100);
});

test("truncated diff bodies fail visibly instead of hiding changes", () => {
  assert.throws(
    () => parseDiff(diff.replace("+return result;\n", "")),
    /Incomplete diff/,
  );
});

test("trailing context is not presented as a separate change", () => {
  const body = Array.from({ length: 24 }, (_, i) => `+line ${i + 1}`).join(
    "\n",
  );
  const chunks = parseDiff(
    `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,26 @@\n${body}\n closing\n bracket\n`,
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.lines.length, 26);
});
