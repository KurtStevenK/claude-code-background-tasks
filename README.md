# claude-code-background-tasks

Adds a **Background Tasks** section for Claude Code to VSCodium (or VS Code), like the Background tasks panel in the Claude desktop app. It lists the background tasks of your current Claude Code session (background shell commands, agents, monitors and workflows) with their status and how long they took, and has a ■ button to stop a running one.

The section appears in Claude Code's sessions sidebar, next to Account & Usage and Session Manager. Drag its header above or below them.

- **Running** tasks show a spinner and a live timer. **Finished** ones show their duration, or Failed / Stopped.
- Click a task to open its output. Hover to see the command or prompt and the result summary.
- **Choose Session…** pins another session (by default it follows the newest one in the workspace). The 🗑 button hides finished tasks.

## Tested with

| Component | Version |
|---|---|
| VSCodium | 1.143.17232 |
| Claude Code extension and CLI | 2.1.316 |
| OS | Windows 11 |

## Install

Install it with the [skills CLI](https://skills.sh/) (the same one `find-skills` uses):

```bash
npx skills add KurtStevenK/claude-code-background-tasks --skill claude-code-background-tasks
```

Then ask your agent to "install the Claude Code background tasks sidebar". The skill runs `install.ps1`, which installs the sidebar extension into VSCodium and the small Claude Code plugin the stop button needs. Reload the editor afterwards (`Developer: Reload Window`).

Without an agent, run the script yourself from the skill folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\skills\claude-code-background-tasks\install.ps1
```

Or do the two steps by hand:

```powershell
codium --install-extension .\skills\claude-code-background-tasks\claude-background-tasks.vsix
claude plugin marketplace add KurtStevenK/claude-code-background-tasks
claude plugin install background-tasks-stop@claude-code-background-tasks
```

The list works without the plugin; only the stop button needs it.

## How it works

The extension reads the session transcripts Claude Code already writes to `~/.claude/projects/<workspace>/<session>.jsonl`. It picks up each background task when it starts and its completion notice when it ends. It changes nothing.

Stopping is done by Claude Code itself. The sidebar writes a request to `~/.claude/background-tasks/<session>/stop.json`. The `background-tasks-stop` plugin, running inside that session, picks it up within a second, stops the task with Claude's own TaskStop tool (the same as the stop button in the desktop app) and writes the result to `done.json`. Because of that it can stop agents and workflows too, not only shell commands.

Sessions started before the plugin was installed cannot be stopped from the sidebar.

## Layout

```
skills/claude-code-background-tasks/
  SKILL.md                       what the agent does
  install.ps1                    installs extension + plugin
  claude-background-tasks.vsix   the built extension
  extension/                     extension source (plain JavaScript, no dependencies)
  plugin/                        Claude Code plugin source (hooks module)
.claude-plugin/marketplace.json  makes this repo a plugin marketplace
```

## License

MIT
