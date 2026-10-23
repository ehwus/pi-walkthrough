import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { WalkthroughWindow } from "../src/window.ts";
import { createWalkthrough, currentStep } from "../src/walkthrough.ts";
import { parseDiff, type Snapshot } from "../src/source.ts";
import type { Tutor } from "../src/tutor.ts";

initTheme("dark", false);

function setup(
  tutor?: Tutor,
  options: Partial<ConstructorParameters<typeof WalkthroughWindow>[2]> = {},
) {
  const calls = { saves: 0, closes: 0 };
  const snapshot: Snapshot = {
    id: "snapshot",
    input: "main",
    cwd: "/tmp",
    title: "Update a name",
    description: "",
    base: "a".repeat(40),
    head: "b".repeat(40),
    chunks: parseDiff(
      `diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old();\n+新しい();\n@@ -20 +20 @@\n-other();\n+newOther();\n`,
    ),
  };
  const state = createWalkthrough(snapshot, {
    summary: "Change two names.",
    concerns: [
      {
        title: "Naming",
        steps: [
          { title: "First name", chunkIds: ["c1"] },
          { title: "Second name", chunkIds: ["c2"] },
        ],
      },
    ],
  });
  currentStep(state).explanation =
    "This changes the first name.\n\nThe explanation stays visible.";
  const window = new WalkthroughWindow(
    state,
    tutor ?? {
      explain: async () => "This changes the second name.",
      answer: async () => "The value comes from the caller.",
    },
    {
      theme: {
        fg: (_token, text) => `\x1b[32m${text}\x1b[39m`,
        bg: (_token, text) => text,
        bold: (text) => text,
      },
      rows: () => 38,
      requestRender: () => {},
      save: () => {
        calls.saves++;
      },
      close: () => {
        calls.closes++;
      },
      ...options,
    },
  );
  window.focused = true;
  return { window, state, calls };
}

const screen = (window: WalkthroughWindow, width = 120) =>
  window.render(width).map(stripTerminalSequences).join("\n");

test("code, explanation and chat stay visible together at wide and narrow sizes", () => {
  const { window } = setup();
  for (const width of [120, 80, 42, 20]) {
    const rows = window.render(width);
    assert.ok(rows.every((line) => visibleWidth(line) <= width));
    assert.ok(rows.length <= 38);
  }
  const rendered = screen(window);
  assert.match(rendered, /新しい/);
  assert.match(rendered, /explanation stays visible/);
  assert.match(rendered, /Ask about this code/);
  assert.match(window.render(120).join(""), /\x1b\[/);
});

test("understood works without Option or terminal-specific modifiers on macOS", () => {
  const { window, state } = setup();
  window.handleInput("u");
  assert.equal(currentStep(state).status, "understood");
  assert.equal(state.current, "s1");
  assert.equal(currentStep(state).draft, "");
});

test("marking works with legacy, Kitty and xterm key reporting", () => {
  for (const key of ["u", "\x1b[117u", "\x1b[27;1;117~"]) {
    const { window, state, calls } = setup();
    window.handleInput(key);
    assert.equal(currentStep(state).status, "understood");
    assert.equal(calls.saves, 1);
    window.handleInput("r");
    assert.equal(currentStep(state).status, "revisit");
    assert.equal(state.current, "s1");
  }
});

test("Space shows actions and runs understood without a modifier or Enter", () => {
  for (const space of [" ", "\x1b[32u"]) {
    const { window, state } = setup();
    window.handleInput(space);
    assert.match(screen(window, 42), /u.*understood/);
    window.handleInput("u");
    assert.equal(currentStep(state).status, "understood");
    assert.doesNotMatch(screen(window), /Walkthrough actions/);
    assert.equal(currentStep(state).draft, "");
  }
});

test("Space actions and concerns support j/k and Enter", () => {
  const { window, state } = setup();
  window.handleInput(" ");
  window.handleInput("j");
  window.handleInput("\r");
  assert.equal(currentStep(state).status, "revisit");
  window.handleInput(" ");
  window.handleInput("c");
  window.handleInput("j");
  window.handleInput("k");
  window.handleInput("j");
  window.handleInput("\r");
  assert.equal(state.current, "s2");
});

test("Esc dismisses menus without closing the walkthrough", () => {
  const { window, calls } = setup();
  for (const open of [" ", "?", "c"]) {
    window.handleInput(open);
    window.handleInput("\x1b");
    assert.equal(calls.closes, 0);
    assert.match(screen(window), /新しい/);
  }
  window.handleInput("q");
  assert.equal(calls.closes, 1);
});

test("chat is explicit and keeps action keys, spaces and Option characters as text", () => {
  const { window, state, calls } = setup();
  assert.match(screen(window), /NORMAL/);
  window.handleInput("i");
  assert.match(screen(window), /INSERT/);
  for (const key of [
    "u",
    "r",
    "h",
    "l",
    "j",
    "k",
    "q",
    " ",
    "¨",
    "é",
    "新しい",
  ]) {
    window.handleInput(key);
  }
  assert.equal(currentStep(state).draft, "urhljkq ¨é新しい");
  assert.equal(currentStep(state).status, "unvisited");
  assert.equal(state.current, "s1");
  assert.equal(calls.closes, 0);
  window.handleInput("\x1b");
  assert.equal(calls.closes, 0);
  assert.match(screen(window), /NORMAL/);
  assert.match(screen(window), /● Diff/);
  window.handleInput("u");
  assert.equal(currentStep(state).status, "understood");
  assert.equal(currentStep(state).draft, "urhljkq ¨é新しい");
  window.handleInput("i");
  window.handleInput("!");
  assert.equal(currentStep(state).draft, "urhljkq ¨é新しい!");
});

test("chat preserves native left/right and Ctrl+u editing instead of navigation", () => {
  const { window, state } = setup();
  window.handleInput("i");
  window.handleInput("ur");
  window.handleInput("\x1b[D");
  window.handleInput("!");
  assert.equal(currentStep(state).draft, "u!r");
  window.handleInput("\x1b[C");
  window.handleInput("\x15");
  assert.equal(currentStep(state).draft, "");
  assert.equal(currentStep(state).status, "unvisited");
  assert.equal(state.current, "s1");
});

test("Vim and arrow step movement preserves drafts and stops at the ends", () => {
  for (const [next, previous] of [
    ["l", "h"],
    ["\x1b[C", "\x1b[D"],
  ]) {
    const { window, state } = setup();
    window.handleInput(previous!);
    assert.equal(state.current, "s1");
    window.handleInput("i");
    window.handleInput("Draft question");
    window.handleInput("\x1b");
    window.handleInput(next!);
    assert.equal(state.current, "s2");
    assert.equal(currentStep(state).draft, "");
    window.handleInput(next!);
    assert.equal(state.current, "s2");
    window.handleInput(previous!);
    assert.equal(currentStep(state).draft, "Draft question");
    assert.equal(currentStep(state).status, "unvisited");
  }
});

test("j/k, half pages and gg/G scroll the focused pane", () => {
  const { window, state } = setup();
  currentStep(state).explanation = Array.from(
    { length: 80 },
    (_, i) => `Paragraph ${i}`,
  ).join("\n\n");
  screen(window);
  window.handleInput("\t");
  assert.match(screen(window), /● Explanation 1–/);
  window.handleInput("j");
  assert.match(screen(window), /● Explanation 2–/);
  window.handleInput("k");
  assert.match(screen(window), /● Explanation 1–/);
  for (const [down, up] of [
    ["d", "b"],
    ["\x04", "\x15"],
  ]) {
    window.handleInput(down!);
    assert.doesNotMatch(screen(window), /● Explanation 1–/);
    window.handleInput(up!);
    assert.match(screen(window), /● Explanation 1–/);
  }
  window.handleInput("G");
  assert.match(screen(window), /Paragraph 79/);
  window.handleInput("g");
  window.handleInput("g");
  assert.match(screen(window), /● Explanation 1–/);
  window.handleInput("g");
  window.handleInput("u");
  assert.equal(currentStep(state).status, "understood");
  window.handleInput("\x1b[103;2u");
  assert.match(screen(window), /Paragraph 79/);
});

test("Tab changes reading panes, and entering and leaving chat restores the pane", () => {
  const { window, calls } = setup();
  window.handleInput("\t");
  assert.match(screen(window), /● Explanation/);
  window.handleInput("\r");
  assert.match(screen(window), /INSERT/);
  window.handleInput("\x1b");
  assert.match(screen(window), /● Explanation/);
  window.handleInput("\t");
  assert.match(screen(window), /● Discussion/);
  assert.match(screen(window), /NORMAL/);
  window.handleInput("\x1b[Z");
  assert.match(screen(window), /● Explanation/);
  assert.equal(calls.closes, 0);
});

test("pasted commands and Kitty key releases cannot change progress or close", () => {
  const { window, state, calls } = setup();
  window.handleInput("\x1b[117;1:3u");
  window.handleInput("\x1b[200~");
  for (const text of ["u", "l", "q", " ", "\x1b"]) window.handleInput(text);
  window.handleInput("\x1b[201~");
  assert.equal(currentStep(state).status, "unvisited");
  assert.equal(state.current, "s1");
  assert.equal(calls.closes, 0);
  window.handleInput("i");
  window.handleInput("\x1b[200~");
  for (const text of ["u", " ", "r"]) window.handleInput(text);
  window.handleInput("\x1b[201~");
  assert.equal(currentStep(state).draft, "u r");
  assert.equal(currentStep(state).status, "unvisited");
});

test("chat focus and cursor appear only while inserting a question", () => {
  const { window } = setup();
  assert.ok(!window.render(120).join("").includes(CURSOR_MARKER));
  window.handleInput("i");
  assert.ok(window.render(120).join("").includes(CURSOR_MARKER));
  window.handleInput("\x1b");
  assert.ok(!window.render(120).join("").includes(CURSOR_MARKER));
});

test("configured selection keys work alongside Vim bindings in menus", () => {
  const { window, state, calls } = setup(undefined, {
    keybindings: {
      matches: (data, action) =>
        (action === "tui.select.down" && data === "v") ||
        (action === "tui.select.confirm" && data === "=") ||
        (action === "tui.select.cancel" && data === "!") ||
        getKeybindings().matches(data, action),
    },
  });
  window.handleInput(" ");
  window.handleInput("v");
  window.handleInput("=");
  assert.equal(currentStep(state).status, "revisit");
  window.handleInput("c");
  window.handleInput("!");
  assert.equal(calls.closes, 0);
  window.handleInput("!");
  assert.equal(calls.closes, 1);
});

test("the action menu remains usable with expanded chat on the smallest layout", () => {
  const { window, state } = setup(undefined, { rows: () => 22 });
  window.handleInput("z");
  window.handleInput(" ");
  assert.match(screen(window, 36), /u.*understood/);
  window.handleInput("j");
  assert.match(screen(window, 36), /r.*revisit/);
  window.handleInput("\r");
  assert.equal(currentStep(state).status, "revisit");
});

test("Esc stops a pending answer and leaves chat without closing or losing the draft", async () => {
  let signal: AbortSignal | undefined;
  const { window, state, calls } = setup({
    explain: async () => "Explanation",
    answer: (_state, _step, _question, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    },
  });
  window.handleInput("i");
  window.handleInput("Why?");
  window.handleInput("\r");
  window.handleInput("\x1b");
  assert.equal(signal?.aborted, true);
  assert.equal(calls.closes, 0);
  assert.equal(currentStep(state).draft, "Why?");
  assert.match(screen(window), /NORMAL/);
  window.handleInput("u");
  assert.equal(currentStep(state).status, "understood");
  window.handleInput("q");
  assert.equal(calls.closes, 1);
});

test("all menus fit short and narrow terminals and keep understood discoverable", () => {
  for (const rows of [22, 24, 38]) {
    for (const width of [36, 42, 80, 120]) {
      const { window } = setup(undefined, { rows: () => rows });
      assert.match(screen(window, width), /u understood/);
      assert.match(screen(window, width), /Space/);
      for (const key of [" ", "\x1b", "c"]) {
        window.handleInput(key);
        const rendered = window.render(width);
        assert.ok(rendered.every((line) => visibleWidth(line) <= width));
        assert.ok(rendered.length <= rows);
      }
    }
  }
});

test("untrusted titles and paths cannot inject terminal rows or control sequences", () => {
  const { window, state } = setup();
  state.snapshot.title = "Title\nsecond row\u001b]52;c;YQ==\u0007";
  state.snapshot.chunks[0]!.path = "file\nname.ts";
  const lines = window.render(120);
  assert.ok(lines.every((line) => !line.includes("\n")));
  assert.ok(lines.every((line) => !line.includes("\u001b]52")));
});

test("asking a question does not move the step or replace its explanation", async () => {
  const { window, state } = setup();
  window.handleInput("i");
  window.handleInput("Where does this value come from?");
  window.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.current, "s1");
  assert.equal(currentStep(state).status, "unvisited");
  assert.equal(
    currentStep(state).discussion[1]?.text,
    "The value comes from the caller.",
  );
  assert.match(screen(window), /explanation stays visible/);
  assert.match(screen(window), /The value comes from the caller/);
});

test("navigation keeps discussions attached and understanding is an explicit action", async () => {
  const { window, state } = setup();
  window.handleInput("i");
  window.handleInput("Why?");
  window.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  window.handleInput("\x1b");
  window.handleInput("u");
  window.handleInput("l");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.current, "s2");
  assert.deepEqual(currentStep(state).discussion, []);
  window.handleInput("h");
  assert.equal(currentStep(state).status, "understood");
  assert.equal(currentStep(state).discussion.length, 2);
});

test("a long answer opens at its beginning, not its final paragraph", async () => {
  const { window } = setup({
    explain: async () => "Explanation",
    answer: async () =>
      "This is the direct answer.\n\n" +
      Array.from({ length: 40 }, (_, i) => `Detail ${i}`).join("\n\n"),
  });
  window.render(120);
  window.handleInput("i");
  window.handleInput("Explain this");
  window.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen(window), /This is the direct answer/);
  assert.doesNotMatch(screen(window), /Detail 39/);
});

test("late answers after cancellation cannot attach to another step", async () => {
  let finish: (answer: string) => void = () => {};
  const { window, state } = setup({
    explain: async () => "Second explanation.",
    answer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  window.handleInput("i");
  window.handleInput("Explain this");
  window.handleInput("\r");
  window.handleInput("\x1b");
  window.handleInput("l");
  finish("Late answer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.current, "s2");
  assert.equal(state.concerns[0]?.steps[0]?.discussion.length, 0);
  assert.equal(state.concerns[0]?.steps[1]?.discussion.length, 0);
  assert.doesNotMatch(screen(window), /Late answer/);
});
