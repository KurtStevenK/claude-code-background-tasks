---
name: claude-code-background-tasks
description: Install, update or fix the "Background Tasks" section for Claude Code in VSCodium (or VS Code). It lists the background tasks of the current Claude Code session (background shell commands, agents, monitors, workflows) with status and duration, like the desktop app's Background tasks panel, and has a stop button. Use when the user wants to see or stop Claude's background tasks inside VSCodium, asks for the background tasks panel/sidebar, or the section is missing, empty or the stop button does not work.
---

# claude-code-background-tasks

Two parts, both in this skill folder (`%USERPROFILE%\.claude\skills\claude-code-background-tasks\`):

- **The sidebar extension** `claude-background-tasks.vsix` (source in `extension/`). It adds a **Background Tasks** section to Claude Code's sessions sidebar (the one with Account & Usage and Session Manager). It reads the session transcripts in `~/.claude/projects/<workspace>/<session>.jsonl` and changes nothing. Running tasks show a spinner and a live timer; finished ones show their duration, or Failed / Stopped. Click a task to open its output, hover for the command or prompt.
- **The companion plugin** `background-tasks-stop` (source in `plugin/`). It runs inside every Claude Code session and makes the ■ stop button work: the sidebar writes `~/.claude/background-tasks/<session>/stop.json`, the plugin stops the task with Claude's own TaskStop tool within a second and reports in `done.json`. This stops shell commands, agents, monitors and workflows alike.

## Tested with

- VSCodium **1.143.17232**, Claude Code extension and CLI **2.1.316**, Windows 11

## What to do

1. **Install.** Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\claude-code-background-tasks\install.ps1"
   ```
   It installs the `.vsix` with the VSCodium CLI (falls back to VS Code) and then the plugin with
   `claude plugin marketplace add KurtStevenK/claude-code-background-tasks` and
   `claude plugin install background-tasks-stop@claude-code-background-tasks`.
   Installing the plugin adds code that loads in every future Claude Code session, so a permission check may block you from running that part. Then run the script with `-SkipPlugin` and give the user the two `claude plugin` commands to run themselves. `-SkipExtension` installs only the plugin.
2. **Ask the user to reload the editor** (`Developer: Reload Window`). That also restarts the Claude chat, so do not do it for them mid-task. Sessions started before the plugin was installed cannot be stopped from the sidebar.
3. **Placement.** The section appears below Claude Code's own panel. Account & Usage and Session Manager are drawn inside Claude Code's single webview, so no extension can sit *between* them; the user can drag the Background Tasks header above or below that block and VSCodium remembers it.
4. **Verify.** Start a background command (for example `sleep 120` with `run_in_background`). It should appear under Running with a spinner, and the ■ button should stop it within a few seconds and move it to Finished as Stopped.

## Troubleshooting

- **Section missing:** check `kurtstevenk.claude-background-tasks-*` exists in `%USERPROFILE%\.vscode-oss\extensions`, then reload. Without Claude Code's sessions sidebar the section shows in its own activity bar container instead.
- **"No Claude Code session found":** the workspace folder has no transcript folder under `~/.claude/projects` yet (folder name = workspace path with every non-alphanumeric character replaced by `-`). Send one message in Claude Code first.
- **Wrong session shown:** it follows the newest transcript of the workspace. With two chats in one folder, use **Choose Session…** in the section's title bar to pin one.
- **Stop does nothing / warning after 8 s:** the plugin is not loaded in that session. Check `claude plugin list` shows `background-tasks-stop`, and start a new session. If the user's permission mode asks before tools, the stop shows up as a permission question in the chat.
- **Rebuild after editing `extension/`:** `npx -y @vscode/vsce@3 package --no-dependencies -o ..\claude-background-tasks.vsix` inside `extension/`, bump `version` in `extension/package.json` first, then rerun `install.ps1 -SkipPlugin`.

## Undo

Uninstall **Claude Background Tasks** from the editor's Extensions view, and run `claude plugin uninstall background-tasks-stop`. Delete `~/.claude/background-tasks` if you like.
