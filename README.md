![MelodyWork](docs/images/melodywork-hero.png)

**English** | [简体中文](README.zh-CN.md)

# MelodyWork

> A local-first desktop workspace for building with [Melody Build](https://github.com/Lhy723/melody-build).

Talk through a task, inspect the result, review the diff, and ship directly from the project already on your machine. MelodyWork keeps the agent loop grounded in the repository, with visible tool activity and explicit permission boundaries.

[Development guide](docs/development.md) · [Release guide](docs/releasing.md) · [File preview handoff](docs/handoff-file-preview.md)

`Local-first` `Git-native` `macOS` `Windows`

## Built for the Whole Loop

| Plan & Research | Build & Review | Control & Ship |
| --- | --- | --- |
| Start and resume ACP agent sessions, collect research context, and keep source material beside the implementation. | Inspect files and per-file Git diffs, edit within workspace boundaries, and work through a deliberate terminal. | Stage and commit changes, manage branches and worktrees, and decide permissions once, per session, or per project. |

## How Melody Build Works

Melody Build is the execution engine underneath MelodyWork. It is a terminal-based AI coding agent that can run interactively as a full-screen TUI, headlessly for scripts and CI, or embedded in another application through the Agent Client Protocol (ACP). MelodyWork provides the desktop control surface around that engine.

```mermaid
flowchart TD
  user["Developer intent"] --> app["MelodyWork desktop"]

  subgraph transport["ACP stdio transport"]
    app <--> pager["melody-pager sidecar"]
  end

  pager --> runtime["Melody Build agent runtime"]
  runtime --> model["Configured model endpoint"]
  runtime --> tools["melody-tools\nterminal · files · search"]
  tools --> workspace["melody-workspace\nfilesystem · VCS · execution · checkpoints"]
  workspace --> repo["Local project and Git repository"]
  repo --> runtime
  runtime --> app
```

### One turn, end to end

1. You describe an outcome in MelodyWork and choose the project or worktree where it belongs.
2. MelodyWork starts or resumes `melody-pager` and opens an ACP stdio session with Melody Build.
3. The agent runtime reads the workspace, reasons about the task, and selects the tools it needs.
4. `melody-tools` performs terminal, file, search, and workspace operations. Permission-sensitive actions can pause for your decision.
5. Tool output and progress stream back through ACP, so the timeline stays inspectable while the agent works.
6. The resulting files remain in the local workspace. MelodyWork then gives you the Git diff, branch, worktree, and commit controls needed to review and deliver them.

This separation is intentional: Melody Build owns the agent loop and tool execution; MelodyWork owns the desktop experience, session navigation, project boundaries, review surfaces, and user decisions.

## Why This Shape

- **Local-first:** projects, session state, files, Git history, tool activity, and project rules stay on the machine where the work happens.
- **Protocol-driven:** ACP stdio gives the desktop client a clear boundary around messages, tool calls, progress, and permissions.
- **Inspectable by default:** the agent can move quickly, but changes remain visible through timelines, file previews, diffs, and Git actions.
- **Composable engine:** the same Melody Build runtime can power the terminal, CI, or another ACP client; MelodyWork focuses on making the desktop loop coherent.

The current beta has no account system or cloud sync.

## Start Developing

MelodyWork pins Melody Build as the `vendor/melody-build` Git submodule. On a fresh clone:

```bash
git submodule update --init --recursive
pnpm install
cargo install dotslash --locked
pnpm tauri dev
```

See the [development guide](docs/development.md) for prerequisites, validation commands, and sidecar behavior.

## Documentation

- [Development guide](docs/development.md): prerequisites, commands, and sidecar resolution
- [Release guide](docs/releasing.md): tags, updater signing, and platform release notes
- [File preview handoff](docs/handoff-file-preview.md): current file-preview implementation notes

## Status

MelodyWork is an active beta for macOS and Windows. The product surface and release workflow are evolving, while the local-first and Git-native foundation remains the point.
