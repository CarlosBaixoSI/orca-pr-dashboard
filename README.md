# Pull Requests Dashboard for Orca

Orca plugin that lists your open GitHub pull requests with:

- Status: draft, checks, review decision, conflicts, unreplied review threads.
- Who owns the next move: you, reviewers or checks, with the reason.
- Linked sessions: Orca worktrees on the pull request branch, plus Claude Code sessions that created the pull request or worked on its branch.
- Stack view: pull requests based on another open pull request's branch are nested under it.
- Session cost: estimated from the token usage in the linked Claude Code transcripts (see `src/pricing.mjs`).
- Mute: muted pull requests are hidden, never counted and never notified.

A status bar item shows how many pull requests need your attention and opens the sidebar panel when clicked. A desktop notification also fires when a pull request starts needing your attention.

## How it works

The plugin's background worker polls `gh` every 3 minutes and serves the page on `127.0.0.1:47213`. The "Open Pull Requests" command opens it in an Orca browser tab. API calls require a per-install token and a local `Host` header.

The "Pull Requests" right sidebar panel shows the same page. In the panel the page talks to the worker through `orca.plugin.request`, since panel frames cannot reach the local server, and it updates on every refresh. Clicking a pull request opens it in the system browser. Right clicking one shows:

- Open in browser / Open in Orca.
- Discuss: a clean workspace in the pull request's Orca project, named after the pull request, with Claude.
- Fix: a workspace in the pull request's Orca project, started from the pull request head and named after the pull request, with Claude and a prompt asking it to check the pull request state and propose fixes without pushing until approved.

This relies on the worker being allowed to run `gh`, `orca` and a local server, which Orca does not guarantee.

## Install

Orca, Settings, Plugins, install from a local folder, pick this folder and accept the requested capabilities. Reinstall after changing the code, since Orca installs a hashed copy.

## Requirements

- `gh` signed in.
- Claude Code transcripts in `~/.claude/projects` for session links and cost. Codex and OpenCode sessions are not counted.
