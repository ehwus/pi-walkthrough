import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./source.ts";

export type DiscussionMessage = { role: "user" | "assistant"; text: string };
export type Step = {
  id: string;
  title: string;
  chunkIds: string[];
  status: "unvisited" | "understood" | "revisit";
  explanation?: string;
  discussion: DiscussionMessage[];
  draft: string;
};
export type Concern = { title: string; steps: Step[] };
export type Walkthrough = {
  version: 1;
  snapshot: Snapshot;
  summary: string;
  concerns: Concern[];
  current: string;
  cost: number;
  warning?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw new Error(`Invalid ${field}.`);
  return value.trim();
}

export function createWalkthrough(
  snapshot: Snapshot,
  rawPlan: unknown,
): Walkthrough {
  const plan = record(rawPlan);
  const summary = text(plan.summary, "summary");
  if (!Array.isArray(plan.concerns) || !plan.concerns.length)
    throw new Error("No concerns in the walkthrough.");
  const known = new Map(snapshot.chunks.map((chunk) => [chunk.id, chunk]));
  const used = new Set<string>();
  let nextId = 1;
  const makeStep = (title: string, chunkIds: string[]): Step => ({
    id: `s${nextId++}`,
    title,
    chunkIds,
    status: "unvisited",
    discussion: [],
    draft: "",
  });
  const concerns = plan.concerns.map((value): Concern => {
    const concern = record(value);
    if (!Array.isArray(concern.steps) || !concern.steps.length)
      throw new Error("A concern needs steps.");
    const steps = concern.steps.map((value) => {
      const step = record(value);
      if (
        !Array.isArray(step.chunkIds) ||
        !step.chunkIds.length ||
        step.chunkIds.length > 2
      )
        throw new Error("Each step needs one or two chunks.");
      const chunkIds = step.chunkIds.map((id) => {
        if (typeof id !== "string" || !known.has(id) || used.has(id))
          throw new Error(`Unknown or duplicate chunk: ${String(id)}`);
        used.add(id);
        return id;
      });
      return makeStep(text(step.title, "step title"), chunkIds);
    });
    return { title: text(concern.title, "concern title"), steps };
  });
  const missing = snapshot.chunks.filter((chunk) => !used.has(chunk.id));
  if (missing.length) {
    concerns.push({
      title: "Ungrouped changes",
      steps: missing.map((chunk) => makeStep(chunk.path, [chunk.id])),
    });
  }
  return {
    version: 1,
    snapshot,
    summary,
    concerns,
    current: concerns[0]!.steps[0]!.id,
    cost: 0,
    ...(missing.length
      ? {
          warning: `${missing.length} chunk(s) were not grouped by the model. They remain visible under Ungrouped changes.`,
        }
      : {}),
  };
}

function progressPath(directory: string, cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(directory, `walkthrough-${key}.json`);
}

export function saveProgress(directory: string, state: Walkthrough): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = progressPath(directory, state.snapshot.cwd);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function loadProgress(
  directory: string,
  cwd: string,
): Walkthrough | undefined {
  try {
    const state = restoreWalkthrough(
      JSON.parse(readFileSync(progressPath(directory, cwd), "utf8")),
    );
    return state?.snapshot.cwd === cwd ? state : undefined;
  } catch {
    return undefined;
  }
}

export function allSteps(state: Walkthrough): Step[] {
  return state.concerns.flatMap((concern) => concern.steps);
}

export function currentStep(state: Walkthrough): Step {
  const step = allSteps(state).find(
    (candidate) => candidate.id === state.current,
  );
  if (!step) throw new Error("The selected walkthrough step is missing.");
  return step;
}

export function restoreWalkthrough(value: unknown): Walkthrough | undefined {
  try {
    const raw = record(value);
    if (raw.version !== 1) return undefined;
    const snapshot = record(raw.snapshot);
    if (
      typeof snapshot.id !== "string" ||
      typeof snapshot.cwd !== "string" ||
      typeof snapshot.input !== "string" ||
      typeof snapshot.title !== "string" ||
      typeof snapshot.description !== "string" ||
      typeof snapshot.base !== "string" ||
      typeof snapshot.head !== "string" ||
      !Array.isArray(snapshot.chunks)
    )
      return undefined;
    for (const candidate of snapshot.chunks) {
      const chunk = record(candidate);
      if (
        typeof chunk.id !== "string" ||
        typeof chunk.path !== "string" ||
        typeof chunk.oldPath !== "string" ||
        typeof chunk.header !== "string" ||
        !Array.isArray(chunk.lines)
      )
        return undefined;
      if (
        !chunk.lines.every(
          (line) =>
            typeof line.text === "string" &&
            ["context", "add", "remove", "meta"].includes(line.kind),
        )
      )
        return undefined;
    }
    const validated = createWalkthrough(snapshot as Snapshot, raw);
    const state = raw as Walkthrough;
    if (
      typeof state.current !== "string" ||
      !Number.isFinite(state.cost) ||
      state.cost < 0
    )
      return undefined;
    const savedSteps = allSteps(state);
    if (
      savedSteps.length !== allSteps(validated).length ||
      new Set(savedSteps.map((step) => step.id)).size !== savedSteps.length
    )
      return undefined;
    for (const step of savedSteps) {
      if (
        typeof step.id !== "string" ||
        typeof step.draft !== "string" ||
        !["unvisited", "understood", "revisit"].includes(step.status) ||
        (step.explanation !== undefined &&
          typeof step.explanation !== "string") ||
        !Array.isArray(step.discussion) ||
        !step.discussion.every(
          (message) =>
            ["user", "assistant"].includes(message.role) &&
            typeof message.text === "string",
        )
      )
        return undefined;
    }
    currentStep(state);
    return state;
  } catch {
    return undefined;
  }
}
