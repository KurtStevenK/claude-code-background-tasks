# Claude Background Tasks

Shows the background tasks of your current Claude Code session in VSCodium / VS Code: background shell commands, agents, monitors and workflows, with their status (running, finished, failed, stopped) and how long they took. It works like the Background tasks panel in the Claude desktop app.

The list appears as a **Background Tasks** section in the Claude Code sessions sidebar (the one with Account & Usage and Session Manager). Drag its header to move it above or below them.

- Follows the newest session of the open workspace, or pin one with **Choose Session…**
- Click a task to open its output file. Hover for the command or prompt, and the result summary.
- **Clear Finished** hides finished tasks.

It reads the transcripts Claude Code writes to `~/.claude/projects/` and changes nothing.

## Install

```
codium --install-extension claude-background-tasks.vsix
```

## Stopping tasks

Running tasks get a ■ stop button. Stopping goes through Claude Code's own TaskStop, so it works for shell commands, agents, monitors and workflows alike. For that, install the small companion plugin once:

```
claude plugin marketplace add KurtStevenK/claude-code-background-tasks
claude plugin install background-tasks-stop@claude-code-background-tasks
```

The sidebar writes a stop request to `~/.claude/background-tasks/<session>/stop.json`; the plugin running in that session picks it up within a second, stops the task and writes the result to `done.json`. Sessions started before the plugin was installed cannot be stopped from the sidebar.
