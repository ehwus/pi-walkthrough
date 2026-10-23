# pi-walkthrough

Understand a branch diff or GitHub pull request one concern at a time, inside [pi](https://pi.dev).

`/walkthrough` groups changes by behavior rather than file order. It shows the diff alongside an explanation, lets you ask questions about the current step, and keeps track of what you understand or want to revisit.

This is a pi extension, not a Markdown skill. It is a reading aid, not an automated code review: **understood does not mean approved**.

## Install

```bash
pi install git:github.com/ehwus/pi-walkthrough
```

Start a new pi session after installing.

### Requirements

- Node.js 22.19 or newer.
- Pi in its interactive terminal UI, with a model configured and selected. The project currently targets pi 1.2.0.
- Git for local branch comparisons.
- [GitHub CLI](https://cli.github.com), authenticated with `gh auth login`, for pull requests. Your account must have access to the repository.
- A terminal at least 36 columns wide and 22 rows tall. At 96 columns or wider, the diff and explanation appear side by side; narrower terminals stack them.

## Usage

Run pi from the repository you want to explore, then enter one of these commands:

| Command | What it opens |
| --- | --- |
| `/walkthrough main` | Committed changes from the merge base of `main` and `HEAD` to `HEAD` |
| `/walkthrough main feature-branch` | Committed changes from the merge base of the two refs to `feature-branch` |
| `/walkthrough https://github.com/OWNER/REPO/pull/123` | A GitHub pull request, without checking out its branch |
| `/walkthrough resume` | The saved walkthrough |
| `/walkthrough` | The saved walkthrough, or a prompt to choose a comparison |
| `/walkthrough help` | A short command reference |

Local comparisons exclude uncommitted working-tree changes. Pull request URLs must be on `github.com`.

Each walkthrough uses a fixed snapshot. The model groups its diff chunks into concerns and small steps, keeping tests near the behavior they cover. Questions and answers stay attached to their step, and marking a step understood never advances it automatically.

Progress, explanations, discussions, and question drafts are saved locally in pi's session storage. When you resume, the extension checks whether the source changed. If it did, you can keep the saved snapshot or start a new walkthrough; previous understanding does not carry over to new changes.

## Controls

The walkthrough starts in normal mode. Press `i` or `Enter` to type a question; action keys become ordinary text while typing.

| Key | Action |
| --- | --- |
| `Space` or `?` | Open the action menu |
| `u` | Mark the current step understood |
| `r` | Mark the current step for revisit |
| `n` / `p`, `l` / `h`, or right / left arrow | Next / previous step |
| `c` | Choose a concern or step |
| `Tab` / `Shift+Tab` | Focus the next / previous pane |
| `j` / `k` | Scroll the focused pane down / up |
| `d` / `b` or `Ctrl+d` / `Ctrl+u` | Scroll down / up half a page |
| `PageDown` / `PageUp` | Scroll down / up a page |
| `gg` / `G` | Scroll to the beginning / end |
| `x` | Toggle surrounding source |
| `z` | Expand / shrink the discussion pane |
| `e` | Regenerate the explanation |
| `i` or `Enter` | Start typing a question |
| `q` | Close and save progress |

In question input, `Enter` sends and `Esc` returns to normal mode. In menus, use `j` / `k` and `Enter`, or press an action's key directly in the action menu. `Esc` dismisses a menu, stops an active request, or closes the walkthrough when idle in normal mode.

## Privacy and limits

- The extension reads your repository and GitHub data without editing files, checking out branches, or posting comments, reviews, or approvals. It does write local walkthrough progress to pi's session storage.
- Diff content, pull request descriptions, relevant source excerpts, and your questions are sent to the selected model provider. Use it only with code you are allowed to share with that provider.
- Planning, explanations, and answers make model requests and may incur provider costs. The walkthrough displays accumulated model-reported cost.
- Explanations can be wrong. Check the cited source rather than treating them as a correctness guarantee.
- Diffs are limited to 180,000 characters and must fit the selected model's context budget. Large source files and binary source content cannot be opened as surrounding text.
- The custom interface requires interactive pi; it does not work in print, JSON, or RPC mode.

## Development

```bash
git clone https://github.com/ehwus/pi-walkthrough.git
cd pi-walkthrough
npm ci
npm test
npm run check
```

To try your local checkout without adding it to pi's settings, launch pi from a repository you want to explore:

```bash
pi -e /path/to/pi-walkthrough
```
