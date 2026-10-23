import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadSnapshot } from "./source.ts";
import { createTutor } from "./tutor.ts";
import {
  allSteps,
  loadProgress,
  restoreWalkthrough,
  saveProgress,
  type Walkthrough,
} from "./walkthrough.ts";
import { WalkthroughWindow } from "./window.ts";

const entryType = "pi-walkthrough/v1";

async function loading<T>(
  ctx: ExtensionCommandContext,
  label: string,
  lifetime: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const result = await ctx.ui.custom<
    { value: T } | { error: unknown } | undefined
  >((tui, theme, _keys, done) => {
    const loader = new BorderedLoader(tui, theme, label);
    let settled = false;
    const finish = (result: { value: T } | { error: unknown } | undefined) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    const signal = AbortSignal.any([loader.signal, lifetime]);
    const abort = () => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });
    loader.onAbort = abort;
    void work(signal)
      .then(
        (value) => finish({ value }),
        (error: unknown) => finish(signal.aborted ? undefined : { error }),
      )
      .finally(() => signal.removeEventListener("abort", abort));
    return loader;
  });
  if (result && "error" in result) throw result.error;
  return result?.value;
}

export default function walkthroughExtension(pi: ExtensionAPI): void {
  let lifetime: AbortController | undefined;
  let window: WalkthroughWindow | undefined;

  pi.on("session_shutdown", () => {
    lifetime?.abort();
    window?.dispose();
  });

  pi.registerCommand("walkthrough", {
    description:
      "Understand a branch diff or PR, one concern at a time. /walkthrough <PR URL | base [head] | resume>",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "Walkthrough requires pi's interactive terminal UI.",
          "error",
        );
        return;
      }
      if (lifetime) {
        ctx.ui.notify("A walkthrough is already open.", "warning");
        return;
      }
      if (args.trim() === "help") {
        ctx.ui.notify(
          "/walkthrough <GitHub PR URL>\n/walkthrough <base> [head] — committed changes since the merge base\n/walkthrough resume — reopen this session's walkthrough\nGitHub reads use your gh login. No checkout, edits, or GitHub posting.",
        );
        return;
      }
      lifetime = new AbortController();
      const signal = lifetime.signal;
      let state: Walkthrough | undefined;
      let planningCost = 0;
      try {
        await ctx.waitForIdle();
        signal.throwIfAborted();
        const tutor = createTutor(ctx, (cost) => {
          if (state) state.cost += cost;
          else planningCost += cost;
        });
        const entry = ctx.sessionManager
          .getBranch()
          .findLast(
            (entry) =>
              entry.type === "custom" && entry.customType === entryType,
          );
        const hasSessionState = ctx.sessionManager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" && entry.customType === entryType,
          );
        const saved =
          entry?.type === "custom"
            ? restoreWalkthrough(structuredClone(entry.data))
            : hasSessionState
              ? undefined
              : loadProgress(ctx.sessionManager.getSessionDir(), ctx.cwd);
        let input = args.trim();
        const resume = !input || input === "resume";
        if (resume && saved) {
          state = saved;
          let changed = false;
          try {
            const latest = await loading(
              ctx,
              "Checking whether the source has changed…",
              signal,
              (signal) =>
                loadSnapshot(saved.snapshot.input, saved.snapshot.cwd, signal),
            );
            if (!latest) return;
            changed = latest.id !== saved.snapshot.id;
          } catch (error) {
            ctx.ui.notify(
              `Could not check for new changes. Opening the saved snapshot. ${String(error)}`,
              "warning",
            );
          }
          if (changed) {
            const choice = await ctx.ui.select(
              "The source changed. Understanding belongs to the saved snapshot.",
              ["Keep the saved snapshot", "Start a new walkthrough"],
            );
            if (!choice) return;
            if (choice === "Start a new walkthrough") {
              state = undefined;
              input = saved.snapshot.input;
            } else {
              state.warning =
                "Source has changed. You are viewing the saved snapshot; old progress does not cover new changes.";
            }
          }
        } else if (input === "resume") {
          ctx.ui.notify(
            "No walkthrough is saved on this session branch.",
            "info",
          );
          return;
        }
        if (!state) {
          if (!input)
            input =
              (
                await ctx.ui.input(
                  "What would you like to understand?",
                  "GitHub PR URL, main, or <base> <head>",
                )
              )?.trim() ?? "";
          if (!input) return;
          const snapshot = await loading(
            ctx,
            "Reading a fixed, read-only diff snapshot…",
            signal,
            (signal) =>
              loadSnapshot(
                input,
                resume && saved ? saved.snapshot.cwd : ctx.cwd,
                signal,
              ),
          );
          if (!snapshot) return;
          if (saved?.snapshot.id === snapshot.id) {
            state = saved;
          } else {
            state = await loading(
              ctx,
              `Grouping ${snapshot.chunks.length} code chunks into concerns…`,
              signal,
              (signal) => tutor.plan(snapshot, signal),
            );
            if (!state) return;
            state.cost = planningCost;
          }
        }
        signal.throwIfAborted();
        const activeState = state;
        let saveFailed = false;
        const save = () => {
          pi.appendEntry(entryType, structuredClone(activeState));
          try {
            saveProgress(ctx.sessionManager.getSessionDir(), activeState);
            saveFailed = false;
          } catch (error) {
            if (!saveFailed)
              ctx.ui.notify(
                `Could not save walkthrough progress to disk: ${String(error)}`,
                "error",
              );
            saveFailed = true;
          }
          const understood = allSteps(activeState).filter(
            (step) => step.status === "understood",
          ).length;
          ctx.ui.setStatus(
            "walkthrough",
            `Walkthrough ${understood}/${allSteps(activeState).length} understood`,
          );
        };
        save();
        const warnings = [state.warning, state.snapshot.warning].filter(
          Boolean,
        );
        if (warnings.length) ctx.ui.notify(warnings.join("\n"), "warning");
        await ctx.ui.custom<void>(
          (tui, theme, keys, done) => {
            window = new WalkthroughWindow(activeState, tutor, {
              theme,
              keybindings: keys,
              rows: () => tui.terminal.rows,
              requestRender: () => tui.requestRender(),
              save,
              close: () => done(),
            });
            queueMicrotask(() => window?.start());
            return window;
          },
          {
            overlay: true,
            overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
          },
        );
      } catch (error) {
        if (!signal.aborted)
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
      } finally {
        window?.dispose();
        window = undefined;
        lifetime.abort();
        lifetime = undefined;
      }
    },
  });
}
