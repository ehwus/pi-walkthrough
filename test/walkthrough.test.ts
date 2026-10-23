import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWalkthrough,
  loadProgress,
  restoreWalkthrough,
  saveProgress,
} from "../src/walkthrough.ts";
import { parseDiff, type Snapshot } from "../src/source.ts";

export const snapshot: Snapshot = {
  id: "snapshot-one",
  input: "main",
  cwd: "/tmp",
  title: "Feature vs main",
  description: "A sample change",
  base: "a".repeat(40),
  head: "b".repeat(40),
  chunks: parseDiff(`diff --git a/app.ts b/app.ts
--- a/app.ts
+++ b/app.ts
@@ -1 +1 @@
-const name = "old";
+const name = "新しい";
diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-oldTest();
+newTest();
`),
};

export const plan = {
  summary: "Change the name and its test.",
  concerns: [
    {
      title: "Choose the name",
      steps: [
        { title: "Change the value", chunkIds: ["c1"] },
        { title: "Check the value", chunkIds: ["c2"] },
      ],
    },
  ],
};

test("every part of a diff remains visible even when the model omits a chunk", () => {
  const state = createWalkthrough(snapshot, {
    ...plan,
    concerns: [
      { title: "Name", steps: [{ title: "Value", chunkIds: ["c1"] }] },
    ],
  });
  assert.deepEqual(
    state.concerns.flatMap((concern) =>
      concern.steps.flatMap((step) => step.chunkIds),
    ),
    ["c1", "c2"],
  );
  assert.equal(state.concerns[1]?.title, "Ungrouped changes");
  assert.match(state.warning ?? "", /not grouped/);
});

test("invented and duplicated chunk references are rejected", () => {
  for (const chunkIds of [["made-up"], ["c1", "c1"]]) {
    assert.throws(
      () =>
        createWalkthrough(snapshot, {
          ...plan,
          concerns: [{ title: "Name", steps: [{ title: "Value", chunkIds }] }],
        }),
      /chunk/,
    );
  }
});

test("resuming preserves separate discussions and explicit understanding, never inferring approval", () => {
  const state = createWalkthrough(snapshot, plan);
  const first = state.concerns[0]!.steps[0]!;
  first.status = "understood";
  first.discussion.push(
    { role: "user", text: "Why this name?" },
    { role: "assistant", text: "It is a local label." },
  );
  const resumed = restoreWalkthrough(JSON.parse(JSON.stringify(state)));
  assert.equal(resumed?.concerns[0]?.steps[0]?.status, "understood");
  assert.equal(resumed?.concerns[0]?.steps[1]?.status, "unvisited");
  assert.deepEqual(resumed?.concerns[0]?.steps[1]?.discussion, []);
  assert.equal(resumed?.concerns[0]?.steps[0]?.discussion.length, 2);
  assert.equal(restoreWalkthrough({ version: 999 }), undefined);
});

test("progress survives a restart even before pi has persisted a conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "walkthrough-progress-"));
  try {
    const state = createWalkthrough(snapshot, plan);
    state.current = "s2";
    state.concerns[0]!.steps[0]!.status = "understood";
    saveProgress(directory, state);
    const resumed = loadProgress(directory, snapshot.cwd);
    assert.equal(resumed?.current, "s2");
    assert.equal(resumed?.concerns[0]?.steps[0]?.status, "understood");
    assert.equal(loadProgress(directory, "/different-project"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
