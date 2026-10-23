import {
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  ScrollView,
  SelectList,
  getKeybindings,
  isKeyRelease,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { readSource } from "./source.ts";
import type { Tutor } from "./tutor.ts";
import { allSteps, currentStep, type Walkthrough } from "./walkthrough.ts";

type Focus = "code" | "explanation" | "chat";
const commands = [
  { key: "u", label: "Mark understood" },
  { key: "r", label: "Mark for revisit" },
  { key: "n", label: "Next step" },
  { key: "p", label: "Previous step" },
  { key: "c", label: "Choose a concern / step" },
  { key: "x", label: "Toggle surrounding source" },
  { key: "g", label: "Expand / shrink discussion" },
  { key: "e", label: "Regenerate explanation" },
  { key: "i", label: "Ask a question" },
  { key: "q", label: "Close walkthrough" },
] as const;
type Command = (typeof commands)[number]["key"];
type WindowOptions = {
  theme: Pick<Theme, "fg" | "bg" | "bold">;
  keybindings?: Pick<KeybindingsManager, "matches">;
  rows: () => number;
  requestRender: () => void;
  save: () => void;
  close: () => void;
};

type Operation = {
  kind: "explain" | "answer" | "context";
  controller: AbortController;
  text: string;
  question?: string;
};

function clean(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(
    text.replace(/[\r\n]/g, " "),
    Math.max(0, width),
    "",
  );
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class Pane {
  readonly scroll: ScrollView;
  private height = 1;
  total = 0;

  constructor(
    private content: Component,
    private requestRender: () => void,
    follow = false,
  ) {
    this.scroll = new ScrollView(content, { follow: follow ? "end" : "none" });
  }

  render(width: number, height: number): string[] {
    const lines = this.content.render(Math.max(1, width));
    this.height = height;
    this.total = lines.length;
    this.scroll.updateLayout(lines.length, height, this.requestRender);
    return Array.from({ length: height }, (_, i) =>
      fit(lines[this.scroll.scrollTop + i] ?? "", width),
    );
  }

  location(): string {
    return this.total > this.height
      ? ` ${this.scroll.scrollTop + 1}–${Math.min(this.total, this.scroll.scrollTop + this.height)}/${this.total}`
      : "";
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

export class WalkthroughWindow implements Component, Focusable {
  private input: Input;
  private focus: Focus = "code";
  private mode: "normal" | "insert" = "normal";
  private pendingG = false;
  private pasting = false;
  private hasFocus = false;
  private explanation = new Markdown("", 0, 0, getMarkdownTheme());
  private discussion = new Markdown("", 0, 0, getMarkdownTheme());
  private codePane: Pane;
  private explanationPane: Pane;
  private chatPane: Pane;
  private operation?: Operation;
  private error = "";
  private closed = false;
  private chooser?: SelectList;
  private chooserKind: "steps" | "commands" = "steps";
  private chatExpanded = false;
  private pendingChatTop?: number;
  private chooserHeight = 0;
  private contextText?: string;
  private codeCache?: { width: number; lines: string[] };
  private lastExplanation = "";
  private lastDiscussion = "";
  private areas: {
    focus: Focus;
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];

  constructor(
    readonly state: Walkthrough,
    private tutor: Tutor,
    private options: WindowOptions,
  ) {
    this.input = new Input({
      prompt: "› ",
      placeholder: "Ask about this code…",
      placeholderStyle: (text) => options.theme.fg("muted", text),
    });
    this.input.setValue(currentStep(state).draft);
    this.input.onSubmit = (value) => {
      if (!value.trim()) return;
      if (this.operation) {
        this.error =
          "Still working. Your question is kept in the input. Press Enter when it finishes, or Esc to stop it first.";
        this.options.requestRender();
        return;
      }
      void this.run("answer", value.trim());
    };
    this.codePane = new Pane(
      {
        render: (width) => this.renderCode(width),
        invalidate: () => {
          this.codeCache = undefined;
        },
      },
      options.requestRender,
    );
    this.explanationPane = new Pane(this.explanation, options.requestRender);
    this.chatPane = new Pane(this.discussion, options.requestRender, true);
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.mode === "insert" && !this.chooser;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  private get activeFocus(): Focus {
    return this.mode === "insert" ? "chat" : this.focus;
  }

  private enterChat(): void {
    this.mode = "insert";
    this.pendingG = false;
    this.focused = this.hasFocus;
  }

  start(): void {
    if (!this.closed && !currentStep(this.state).explanation)
      void this.run("explain");
  }

  private save(): void {
    currentStep(this.state).draft = this.input.getValue();
    this.options.save();
  }

  private cancel(): void {
    this.operation?.controller.abort();
    this.operation = undefined;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    this.save();
  }

  private close(): void {
    this.dispose();
    this.options.close();
  }

  private async run(kind: Operation["kind"], question?: string): Promise<void> {
    if (this.closed) return;
    this.cancel();
    const step = currentStep(this.state);
    const job: Operation = {
      kind,
      question,
      controller: new AbortController(),
      text: "",
    };
    this.operation = job;
    if (kind === "answer")
      this.pendingChatTop = step.discussion.length
        ? this.chatPane.total + 1
        : 0;
    this.error = "";
    this.options.requestRender();
    const update = (text: string) => {
      if (this.operation !== job || this.closed) return;
      job.text = text;
      this.options.requestRender();
    };
    try {
      let result: string;
      if (kind === "context") {
        const chunks = this.state.snapshot.chunks.filter((chunk) =>
          step.chunkIds.includes(chunk.id),
        );
        const excerpts: string[] = [];
        for (const chunk of chunks) {
          const newLines = chunk.lines.flatMap((line) =>
            line.newLine === undefined ? [] : [line.newLine],
          );
          const oldLines = chunk.lines.flatMap((line) =>
            line.oldLine === undefined ? [] : [line.oldLine],
          );
          const version = newLines.length ? "after" : "before";
          const numbers = newLines.length ? newLines : oldLines;
          excerpts.push(
            await readSource(
              this.state.snapshot,
              version === "after" ? chunk.path : chunk.oldPath,
              version,
              Math.max(1, (numbers[0] ?? 1) - 12),
              70,
              job.controller.signal,
            ),
          );
        }
        result = excerpts.join("\n\n");
      } else if (kind === "answer") {
        result = await this.tutor.answer(
          this.state,
          step,
          question!,
          job.controller.signal,
          update,
        );
      } else {
        result = await this.tutor.explain(
          this.state,
          step,
          job.controller.signal,
          update,
        );
      }
      if (
        this.operation !== job ||
        this.closed ||
        job.controller.signal.aborted
      )
        return;
      this.error = "";
      if (kind === "explain") step.explanation = result;
      if (kind === "answer") {
        step.discussion.push(
          { role: "user", text: question! },
          { role: "assistant", text: result },
        );
        if (this.input.getValue().trim() === question) this.input.setValue("");
      }
      if (kind === "context") {
        this.contextText = result;
        this.codePane.invalidate();
        this.codePane.scroll.scrollToStart();
      }
      this.save();
    } catch (error) {
      if (
        this.operation === job &&
        !job.controller.signal.aborted &&
        !this.closed
      ) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.operation === job) this.operation = undefined;
      if (!this.closed) this.options.requestRender();
    }
  }

  private go(id: string): void {
    if (id === this.state.current) return;
    this.save();
    this.cancel();
    this.state.current = id;
    this.contextText = undefined;
    this.error = "";
    this.input.setValue(currentStep(this.state).draft);
    this.codePane.invalidate();
    this.codePane.scroll.scrollToStart();
    this.explanationPane.scroll.scrollToStart();
    this.chatPane.scroll.scrollToEnd();
    this.save();
    this.start();
  }

  private move(delta: number): void {
    const steps = allSteps(this.state);
    const index = steps.findIndex((step) => step.id === this.state.current);
    const next = steps[index + delta];
    if (next) this.go(next.id);
  }

  private showChoices(kind: "steps" | "commands", maxVisible = 6): void {
    const theme = this.options.theme;
    const items =
      kind === "steps"
        ? this.state.concerns.flatMap((concern) =>
            concern.steps.map((step) => ({
              value: step.id,
              label: clean(
                `${step.status === "understood" ? "✓" : step.status === "revisit" ? "↺" : "○"} ${concern.title} · ${step.title}`,
              ),
            })),
          )
        : commands.map((command) => ({
            value: command.key,
            label: `${command.key}  ${command.label}`,
          }));
    this.chooserKind = kind;
    this.pendingG = false;
    this.chooserHeight = maxVisible;
    this.chooser = new SelectList(items, maxVisible, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("muted", text),
    });
    if (kind === "steps")
      this.chooser.setSelectedIndex(
        items.findIndex((item) => item.value === this.state.current),
      );
    this.chooser.onCancel = () => {
      this.chooser = undefined;
      this.focused = this.hasFocus;
    };
    this.chooser.onSelect = (item) => {
      this.chooser = undefined;
      if (kind === "steps") this.go(item.value);
      else {
        const command = commands.find((command) => command.key === item.value);
        if (command) this.runCommand(command.key);
      }
      this.focused = this.hasFocus;
    };
    this.focused = this.hasFocus;
  }

  private runCommand(command: Command): void {
    if (command === "u" || command === "r") {
      currentStep(this.state).status =
        command === "u" ? "understood" : "revisit";
      this.save();
    } else if (command === "n" || command === "p") {
      this.move(command === "n" ? 1 : -1);
    } else if (command === "c") this.showChoices("steps");
    else if (command === "g") this.chatExpanded = !this.chatExpanded;
    else if (command === "e") void this.run("explain");
    else if (command === "i") this.enterChat();
    else if (command === "q") this.close();
    else if (command === "x") {
      if (this.contextText !== undefined) {
        this.contextText = undefined;
        this.codePane.invalidate();
        this.codePane.scroll.scrollToStart();
      } else if (!this.operation) void this.run("context");
    }
  }

  private handleChooserInput(data: string): void {
    const chooser = this.chooser!;
    const keys = this.options.keybindings ?? getKeybindings();
    if (
      matchesKey(data, Key.escape) ||
      keys.matches(data, "tui.select.cancel") ||
      (this.chooserKind === "steps" && matchesKey(data, "q"))
    ) {
      chooser.onCancel?.();
      return;
    }
    if (this.chooserKind === "commands") {
      const command = commands.find((command) => matchesKey(data, command.key));
      if (command) {
        chooser.onSelect?.({ value: command.key, label: command.label });
        return;
      }
    }
    const items =
      this.chooserKind === "steps"
        ? allSteps(this.state).map((step) => step.id)
        : commands.map((command) => command.key);
    const index = items.indexOf(chooser.getSelectedItem()?.value ?? "");
    if (matchesKey(data, "j") || keys.matches(data, "tui.select.down")) {
      chooser.setSelectedIndex((index + 1) % items.length);
    } else if (matchesKey(data, "k") || keys.matches(data, "tui.select.up")) {
      chooser.setSelectedIndex((index + items.length - 1) % items.length);
    } else if (keys.matches(data, "tui.select.pageDown")) {
      chooser.setSelectedIndex(index + this.chooserHeight);
    } else if (keys.matches(data, "tui.select.pageUp")) {
      chooser.setSelectedIndex(index - this.chooserHeight);
    } else if (
      matchesKey(data, Key.enter) ||
      keys.matches(data, "tui.select.confirm")
    ) {
      const item = chooser.getSelectedItem();
      if (item) chooser.onSelect?.(item);
    }
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    if (data.includes("\x1b[200~")) this.pasting = true;
    if (this.pasting) {
      this.pendingG = false;
      if (this.mode === "insert" && !this.chooser) {
        this.input.handleInput(data);
        currentStep(this.state).draft = this.input.getValue();
      }
      if (data.includes("\x1b[201~")) this.pasting = false;
      this.options.requestRender();
      return;
    }
    if (this.chooser) {
      this.handleChooserInput(data);
      this.options.requestRender();
      return;
    }
    const keys = this.options.keybindings ?? getKeybindings();
    const pendingG = this.pendingG;
    this.pendingG = false;
    if (
      matchesKey(data, Key.escape) ||
      keys.matches(data, "tui.select.cancel")
    ) {
      if (this.operation) {
        this.cancel();
        this.error =
          "Stopped. e retries the explanation; i then Enter retries your question.";
      } else if (this.mode === "normal") this.close();
      this.mode = "normal";
      this.focused = this.hasFocus;
    } else if (
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift(Key.tab))
    ) {
      const order: Focus[] = ["code", "explanation", "chat"];
      this.focus =
        order[
          (order.indexOf(this.activeFocus) +
            (matchesKey(data, Key.tab) ? 1 : 2)) %
            order.length
        ]!;
      this.mode = "normal";
      this.focused = this.hasFocus;
    } else if (this.mode === "insert") {
      this.input.handleInput(data);
      currentStep(this.state).draft = this.input.getValue();
    } else {
      const pane =
        this.focus === "code"
          ? this.codePane
          : this.focus === "explanation"
            ? this.explanationPane
            : this.chatPane;
      const command = commands.find(
        (command) =>
          command.key !== "g" &&
          (matchesKey(data, command.key) ||
            matchesKey(data, Key.alt(command.key))),
      );
      if (matchesKey(data, Key.space) || matchesKey(data, Key.question)) {
        this.showChoices("commands");
      } else if (matchesKey(data, "g")) {
        if (pendingG) pane.scroll.scrollToStart();
        else this.pendingG = true;
      } else if (
        matchesKey(data, Key.shift("g")) ||
        matchesKey(data, Key.end)
      ) {
        pane.scroll.scrollToEnd();
      } else if (matchesKey(data, Key.home)) pane.scroll.scrollToStart();
      else if (
        matchesKey(data, "h") ||
        matchesKey(data, Key.left) ||
        matchesKey(data, Key.alt(Key.left))
      )
        this.move(-1);
      else if (
        matchesKey(data, "l") ||
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.alt(Key.right))
      )
        this.move(1);
      else if (
        matchesKey(data, Key.enter) ||
        keys.matches(data, "tui.select.confirm")
      )
        this.enterChat();
      else if (matchesKey(data, "z") || matchesKey(data, Key.alt("g")))
        this.runCommand("g");
      else if (command) this.runCommand(command.key);
      else if (matchesKey(data, "j") || keys.matches(data, "tui.select.down"))
        pane.scroll.scrollBy(1);
      else if (matchesKey(data, "k") || keys.matches(data, "tui.select.up"))
        pane.scroll.scrollBy(-1);
      else if (matchesKey(data, "d") || matchesKey(data, Key.ctrl("d"))) {
        pane.scroll.scrollBy(
          Math.max(1, Math.floor(pane.scroll.viewportHeight / 2)),
        );
      } else if (matchesKey(data, "b") || matchesKey(data, Key.ctrl("u"))) {
        pane.scroll.scrollBy(
          -Math.max(1, Math.floor(pane.scroll.viewportHeight / 2)),
        );
      } else if (
        keys.matches(data, "tui.select.pageDown") ||
        matchesKey(data, Key.ctrl("f"))
      ) {
        pane.scroll.scrollBy(Math.max(1, pane.scroll.viewportHeight - 1));
      } else if (
        keys.matches(data, "tui.select.pageUp") ||
        matchesKey(data, Key.ctrl("b"))
      ) {
        pane.scroll.scrollBy(-Math.max(1, pane.scroll.viewportHeight - 1));
      }
    }
    this.options.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.chooser) return undefined;
    const area = this.areas.find(
      (candidate) =>
        event.x >= candidate.x &&
        event.x < candidate.x + candidate.width &&
        event.y >= candidate.y &&
        event.y < candidate.y + candidate.height,
    );
    if (!area) return undefined;
    if (event.type === "wheel") {
      const pane =
        area.focus === "code"
          ? this.codePane
          : area.focus === "explanation"
            ? this.explanationPane
            : this.chatPane;
      pane.scroll.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    if (event.type === "press" || event.type === "click") {
      if (area.focus === "chat" && event.y === area.y + area.height - 1)
        this.enterChat();
      else {
        this.focus = area.focus;
        this.mode = "normal";
        this.pendingG = false;
        this.focused = this.hasFocus;
      }
      return { focus: true, render: true };
    }
    return undefined;
  }

  private renderCode(width: number): string[] {
    if (this.codeCache?.width === width) return this.codeCache.lines;
    const theme = this.options.theme;
    const step = currentStep(this.state);
    const chunks = this.state.snapshot.chunks.filter((chunk) =>
      step.chunkIds.includes(chunk.id),
    );
    const lines: string[] = [];
    if (this.contextText !== undefined) {
      for (const row of clean(this.contextText).split("\n"))
        lines.push(...wrapTextWithAnsi(row, width));
    } else {
      for (const chunk of chunks) {
        lines.push(theme.fg("accent", fit(clean(chunk.path), width)));
        lines.push(theme.fg("dim", fit(clean(chunk.header), width)));
        const highlighted = highlightCode(
          chunk.lines.map((line) => clean(line.text)).join("\n"),
          getLanguageFromPath(chunk.path),
        );
        for (const [index, line] of chunk.lines.entries()) {
          const token =
            line.kind === "add"
              ? "toolDiffAdded"
              : line.kind === "remove"
                ? "toolDiffRemoved"
                : "dim";
          const sign =
            line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
          const gutter = `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} ${sign} `;
          const body =
            line.kind === "context" || line.kind === "meta"
              ? theme.fg("muted", clean(line.text))
              : (highlighted[index] ?? clean(line.text));
          const available = Math.max(1, width - gutter.length);
          const wrapped = wrapTextWithAnsi(body, available);
          for (const [part, text] of wrapped.entries()) {
            const prefix =
              part === 0 ? theme.fg(token, gutter) : " ".repeat(gutter.length);
            const row = fit(prefix + text, width);
            lines.push(
              line.kind === "add"
                ? theme.bg("toolSuccessBg", row)
                : line.kind === "remove"
                  ? theme.bg("toolErrorBg", row)
                  : row,
            );
          }
        }
        lines.push("");
      }
    }
    this.codeCache = { width, lines };
    return lines;
  }

  private updateText(): void {
    const step = currentStep(this.state);
    const explanation =
      this.operation?.kind === "explain"
        ? this.operation.text || "Preparing explanation…"
        : step.explanation ||
          "No explanation yet. Press e or Space e to generate it.";
    if (explanation !== this.lastExplanation) {
      this.explanation.setText(clean(explanation));
      this.lastExplanation = explanation;
    }
    const messages = step.discussion.map(
      (message) =>
        `**${message.role === "user" ? "You" : "Pi"}:** ${message.text}`,
    );
    if (this.operation?.kind === "answer")
      messages.push(
        `**You:** ${this.operation.question}`,
        `**Pi:** ${this.operation.text || "Thinking…"}`,
      );
    if (this.error) messages.push(`**Notice:** ${this.error}`);
    const discussion =
      messages.join("\n\n") ||
      "Ask about a line, trace a value, or request a concrete example. Your questions stay attached to this step.";
    if (discussion !== this.lastDiscussion) {
      this.discussion.setText(clean(discussion));
      this.lastDiscussion = discussion;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.options.rows());
    const theme = this.options.theme;
    if (width < 36 || height < 22) {
      return [
        "Walkthrough",
        "Resize to at least 36 columns × 22 rows.",
        "Esc closes; your progress is saved.",
      ]
        .slice(0, height)
        .map((line) => fit(line, width));
    }
    this.updateText();
    const inner = width - 2;
    const step = currentStep(this.state);
    const steps = allSteps(this.state);
    const concern = this.state.concerns.find((item) =>
      item.steps.includes(step),
    )!;
    const understood = steps.filter(
      (item) => item.status === "understood",
    ).length;
    const chatHeight = Math.max(
      3,
      Math.floor((height - 11) * (this.chatExpanded ? 0.65 : 0.25)),
    );
    const topHeight = height - 11 - chatHeight;
    const row = (text: string) =>
      theme.fg("border", "│") + fit(text, inner) + theme.fg("border", "│");
    const divider = theme.fg("border", `├${"─".repeat(inner)}┤`);
    const heading = (
      focus: Focus,
      title: string,
      pane: Pane,
      columns: number,
    ) =>
      fit(
        theme.fg(
          this.activeFocus === focus ? "accent" : "muted",
          `${this.activeFocus === focus ? "●" : "○"} ${title}${pane.location()}`,
        ),
        columns,
      );
    const result = [
      theme.fg("border", `╭${"─".repeat(inner)}╮`),
      row(
        fit(theme.bold(clean(` ${this.state.snapshot.title}`)), inner - 25) +
          fit(
            theme.fg(
              "muted",
              ` ${steps.indexOf(step) + 1}/${steps.length} · ${step.status === "unvisited" ? "not marked" : step.status}`,
            ),
            25,
          ),
      ),
      row(theme.fg("accent", clean(` ${concern.title} · ${step.title}`))),
      divider,
    ];
    this.areas = [];
    if (this.chooser) {
      const selected = this.chooser.getSelectedItem()?.value;
      const intro = (
        this.chooserKind === "commands"
          ? [
              theme.fg("accent", "Walkthrough actions — type a key"),
              "Tab pane · gg/G ends · z chat",
              "d/b or Ctrl+d/u half-page",
              "PgUp/PgDn or Ctrl+b/f full-page",
            ]
          : [
              theme.fg("accent", "Concerns — Enter opens; Esc returns"),
              ...wrapTextWithAnsi(clean(this.state.summary), inner).slice(0, 2),
            ]
      ).slice(0, Math.max(0, topHeight - 2));
      const warning = [this.state.warning, this.state.snapshot.warning]
        .filter(Boolean)
        .join(" ");
      if (
        warning &&
        this.chooserKind === "steps" &&
        intro.length < topHeight - 2
      )
        intro.push(theme.fg("warning", truncateToWidth(clean(warning), inner)));
      const maxVisible = Math.max(1, topHeight - intro.length - 1);
      if (maxVisible !== this.chooserHeight) {
        const items =
          this.chooserKind === "steps"
            ? steps.map((step) => step.id)
            : commands.map((command) => command.key);
        this.showChoices(this.chooserKind, maxVisible);
        this.chooser!.setSelectedIndex(
          Math.max(0, items.indexOf(selected ?? "")),
        );
      }
      const choices = [...intro, ...this.chooser!.render(inner)];
      result.push(
        ...Array.from({ length: topHeight }, (_, i) => row(choices[i] ?? "")),
      );
    } else if (width >= 96) {
      const leftWidth = Math.floor((inner - 1) * 0.52);
      const rightWidth = inner - 1 - leftWidth;
      const code = this.codePane.render(leftWidth, topHeight - 1);
      const explanation = this.explanationPane.render(
        rightWidth,
        topHeight - 1,
      );
      result.push(
        row(
          heading(
            "code",
            this.contextText === undefined
              ? "Diff · old / new"
              : "Surrounding source",
            this.codePane,
            leftWidth,
          ) +
            theme.fg("border", "│") +
            heading(
              "explanation",
              "Explanation",
              this.explanationPane,
              rightWidth,
            ),
        ),
      );
      for (let i = 0; i < topHeight - 1; i++)
        result.push(row(code[i]! + theme.fg("border", "│") + explanation[i]!));
      this.areas.push(
        { focus: "code", x: 1, y: 4, width: leftWidth, height: topHeight },
        {
          focus: "explanation",
          x: leftWidth + 2,
          y: 4,
          width: rightWidth,
          height: topHeight,
        },
      );
    } else {
      const codeHeight = Math.floor(topHeight / 2);
      const explanationHeight = topHeight - codeHeight;
      const code = this.codePane.render(inner, codeHeight - 1);
      const explanation = this.explanationPane.render(
        inner,
        explanationHeight - 1,
      );
      result.push(
        row(heading("code", "Diff · old / new", this.codePane, inner)),
        ...code.map(row),
      );
      result.push(
        row(heading("explanation", "Explanation", this.explanationPane, inner)),
        ...explanation.map(row),
      );
      this.areas.push(
        { focus: "code", x: 1, y: 4, width: inner, height: codeHeight },
        {
          focus: "explanation",
          x: 1,
          y: 4 + codeHeight,
          width: inner,
          height: explanationHeight,
        },
      );
    }
    let chat = this.chatPane.render(inner, chatHeight);
    if (this.pendingChatTop !== undefined) {
      this.chatPane.scroll.scrollTo(this.pendingChatTop, {
        disableFollow: true,
      });
      this.pendingChatTop = undefined;
      chat = this.chatPane.render(inner, chatHeight);
    }
    this.areas.push({
      focus: "chat",
      x: 1,
      y: result.length + 1,
      width: inner,
      height: chatHeight + 2,
    });
    const status = this.operation
      ? ` · ${this.operation.kind === "answer" ? "Answering" : this.operation.kind === "context" ? "Reading source" : "Explaining"}… Esc stops`
      : "";
    result.push(
      divider,
      row(heading("chat", `Discussion${status}`, this.chatPane, inner)),
      ...chat.map(row),
      row(
        this.mode === "insert"
          ? (this.input.render(inner)[0] ?? "")
          : theme.fg(
              "muted",
              this.input.getValue()
                ? `i / Enter — Draft: ${clean(this.input.getValue())}`
                : "i / Enter — Ask about this code…",
            ),
      ),
      divider,
    );
    result.push(
      row(
        theme.fg(
          "muted",
          this.chooser
            ? "j/k select · Enter run · Esc back"
            : this.mode === "insert"
              ? "INSERT · Enter send · Esc normal"
              : inner < 70
                ? "NORMAL · u understood · Space keys"
                : "NORMAL · u understood · r revisit · h/l step · j/k scroll · i ask",
        ),
      ),
    );
    result.push(
      row(
        theme.fg(
          "muted",
          this.chooser
            ? `${understood}/${steps.length} understood · $${this.state.cost.toFixed(3)}`
            : this.mode === "insert"
              ? "Text keys edit your question"
              : inner < 70
                ? "j/k scroll · h/l step · i ask"
                : `Space/? keys · Tab pane · q close · ${understood}/${steps.length} understood · $${this.state.cost.toFixed(3)}`,
        ),
      ),
    );
    result.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return result;
  }

  invalidate(): void {
    this.codePane.invalidate();
    this.explanationPane.invalidate();
    this.chatPane.invalidate();
    this.input.invalidate();
  }
}
