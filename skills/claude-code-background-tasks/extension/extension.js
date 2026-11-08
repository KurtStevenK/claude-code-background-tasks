'use strict';
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionState, formatDuration } = require('./parser');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** Claude Code names a project folder after the workspace path, every non-alphanumeric char → '-'. */
function projectDirs() {
  let all = [];
  try { all = fs.readdirSync(PROJECTS); } catch { return []; }
  const folders = vscode.workspace.workspaceFolders || [];
  const wanted = new Set(folders.map((f) => f.uri.fsPath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()));
  return all.filter((d) => wanted.has(d.toLowerCase())).map((d) => path.join(PROJECTS, d));
}

function sessionFiles() {
  const out = [];
  for (const dir of projectDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      try { out.push({ file: f, mtime: fs.statSync(f).mtimeMs }); } catch { /* gone */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function quickTitle(file) {
  // ai-title lines are small and repeat; scan the tail first, then the whole file.
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const all = [...buf.toString('utf8').matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)];
    if (all.length) return JSON.parse('"' + all[all.length - 1][1] + '"');
  } catch { /* ignore */ }
  return path.basename(file, '.jsonl').slice(0, 8);
}

const STATUS = {
  running: { icon: 'loading~spin', color: undefined, text: 'Running' },
  completed: { icon: 'pass', color: 'testing.iconPassed', text: 'Finished' },
  failed: { icon: 'error', color: 'testing.iconFailed', text: 'Failed' },
  killed: { icon: 'debug-stop', color: 'disabledForeground', text: 'Stopped' },
  stale: { icon: 'question', color: 'disabledForeground', text: 'No result' },
  stopping: { icon: 'loading~spin', color: 'disabledForeground', text: 'Stopping…' },
};
const BRIDGE = path.join(os.homedir(), '.claude', 'background-tasks');
const INSTALL_CMDS = 'claude plugin marketplace add KurtStevenK/claude-code-background-tasks\nclaude plugin install background-tasks-stop@claude-code-background-tasks';
const PLUGIN_HINT = 'Stopping needs the Claude Code companion plugin "background-tasks-stop" in that session. Install it once (Copy install commands), then start a new Claude Code session.';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const KIND = { shell: 'Shell command', agent: 'Agent', monitor: 'Monitor', workflow: 'Workflow', other: 'Task' };

class Provider {
  constructor(ctx) {
    this.ctx = ctx;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this.state = undefined;
    this.pinned = ctx.workspaceState.get('pinnedSession'); // undefined = follow latest
    this.hidden = new Set(ctx.workspaceState.get('hiddenTasks', []));
    this.views = [];
    this.stopping = new Map(); // tool_use_id -> { reqId, at, sid, label }
  }

  async stop(t) {
    if (!t || !t.taskId || !this.state) return;
    const sid = path.basename(this.state.file, '.jsonl');
    const dir = path.join(BRIDGE, sid);
    const file = path.join(dir, 'stop.json');
    const now = Date.now();
    const reqId = now.toString(36) + Math.random().toString(36).slice(2, 8);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const cur = readJson(file, { requests: [] });
      const requests = (cur.requests || []).filter((r) => now - r.at < 5 * 60000);
      requests.push({ id: reqId, taskId: t.taskId, at: now });
      fs.writeFileSync(file, JSON.stringify({ requests }, null, 1));
    } catch (e) {
      vscode.window.showErrorMessage('Could not request the stop: ' + e.message);
      return;
    }
    this.stopping.set(t.id, { reqId, at: now, sid, label: t.label });
    this.tick(true);
  }

  checkStops() {
    for (const [id, s] of this.stopping) {
      const t = this.state && this.state.tasks.get(id);
      if (t && t.status !== 'running') { this.stopping.delete(id); continue; } // notification arrived
      const done = readJson(path.join(BRIDGE, s.sid, 'done.json'), { results: {} });
      const r = done.results && done.results[s.reqId];
      if (r && !r.ok) {
        this.stopping.delete(id);
        vscode.window.showWarningMessage(`Could not stop "${s.label}": ${r.text || 'unknown error'}`);
      } else if (!r && Date.now() - s.at > 8000) {
        this.stopping.delete(id);
        vscode.window.showWarningMessage(`"${s.label}" was not stopped. ${PLUGIN_HINT}`, { modal: false }, 'Copy install commands').then((pick) => {
          if (pick) vscode.env.clipboard.writeText(INSTALL_CMDS);
        });
      } else if (r && r.ok && Date.now() - s.at > 30000) {
        this.stopping.delete(id); // stopped, but no notification showed up; let the row speak for itself
      }
    }
  }

  currentFile() {
    if (this.pinned && fs.existsSync(this.pinned)) return this.pinned;
    const files = sessionFiles();
    return files.length ? files[0].file : undefined;
  }

  tick(force) {
    const file = this.currentFile();
    let changed = !!force;
    if (!file) {
      if (this.state) { this.state = undefined; changed = true; }
    } else if (!this.state || this.state.file !== file) {
      this.state = new SessionState(file);
      this.state.update();
      changed = true;
    } else if (this.state.update()) {
      changed = true;
    }
    if (this.stopping.size) { this.checkStops(); changed = true; }
    const tasks = this.tasks();
    const running = tasks.filter((t) => t.view === 'running' || t.view === 'stopping').length;
    if (changed || running) this._onDidChange.fire(); // running rows show a live timer
    this.updateViews(tasks, running);
  }

  tasks() {
    if (!this.state) return [];
    const stale = vscode.workspace.getConfiguration('claudeBackgroundTasks').get('staleMinutes', 180) * 60000;
    const quietSince = this.state.mtime || Date.now();
    return this.state.list()
      .filter((t) => !this.hidden.has(t.id))
      .map((t) => {
        let view = t.status in STATUS ? t.status : 'completed';
        if (view === 'running' && this.stopping.has(t.id)) view = 'stopping';
        else if (view === 'running' && Date.now() - quietSince > stale) view = 'stale';
        return Object.assign({}, t, { view });
      });
  }

  updateViews(tasks, running) {
    const title = this.state ? this.state.title || quickTitle(this.state.file) : undefined;
    for (const v of this.views) {
      v.description = title ? (this.pinned ? '📌 ' : '') + title : undefined;
      v.badge = running ? { value: running, tooltip: running + ' running' } : undefined;
      v.message = !this.state ? 'No Claude Code session found for this workspace.' : tasks.length ? undefined : 'No background tasks in this session yet.';
    }
  }

  getChildren(el) {
    const tasks = this.tasks();
    if (!el) {
      const isLive = (t) => t.view === 'running' || t.view === 'stopping';
      const running = tasks.filter(isLive);
      const done = tasks.filter((t) => !isLive(t));
      const groups = [];
      if (running.length) groups.push({ group: 'Running', items: running });
      if (done.length) groups.push({ group: 'Finished', items: done });
      return groups;
    }
    return el.items || [];
  }

  getTreeItem(el) {
    if (el.group) {
      const it = new vscode.TreeItem(el.group, vscode.TreeItemCollapsibleState.Expanded);
      it.id = 'group-' + el.group;
      it.description = String(el.items.length);
      it.contextValue = 'group';
      return it;
    }
    const t = el;
    const s = STATUS[t.view];
    const it = new vscode.TreeItem(t.label, vscode.TreeItemCollapsibleState.None);
    it.id = 'task-' + t.id;
    const dur = formatDuration((t.endedAt || Date.now()) - (t.startedAt || Date.now()));
    it.description = t.view === 'completed' || t.view === 'running' ? dur : s.text;
    it.iconPath = new vscode.ThemeIcon(s.icon, s.color ? new vscode.ThemeColor(s.color) : undefined);
    const hasOut = t.outputFile && fs.existsSync(t.outputFile);
    it.contextValue = 'task' + (hasOut ? ' task-out' : '') + ((t.view === 'running' || t.view === 'stale') && t.taskId ? ' task-running' : '');
    if (hasOut) it.command = { command: 'claudeBackgroundTasks.openOutput', title: 'Open Output', arguments: [t] };

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(${s.icon.replace('~spin', '')}) **${s.text}** · ${KIND[t.kind] || 'Task'}${dur ? ' · ' + dur : ''}\n\n`);
    md.appendMarkdown(`**${escapeMd(t.label)}**\n\n`);
    if (t.summary) md.appendMarkdown(escapeMd(t.summary) + '\n\n');
    if (t.detail) md.appendCodeblock(String(t.detail).slice(0, 600) + (String(t.detail).length > 600 ? '\n…' : ''), t.kind === 'shell' ? 'shellscript' : 'text');
    if (t.startedAt) md.appendMarkdown(`\nStarted ${new Date(t.startedAt).toLocaleString()}`);
    if (t.taskId) md.appendMarkdown(` · ID \`${t.taskId}\``);
    if (hasOut) md.appendMarkdown('\n\n_Click to open the output._');
    it.tooltip = md;
    return it;
  }

  async chooseSession() {
    const files = sessionFiles().slice(0, 40);
    const items = [
      { label: '$(sync) Follow latest session', description: this.pinned ? '' : 'current', file: undefined },
      ...files.map((f) => ({
        label: quickTitle(f.file),
        description: new Date(f.mtime).toLocaleString(),
        detail: path.basename(f.file, '.jsonl'),
        file: f.file,
        picked: f.file === this.pinned,
      })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Show background tasks of…', matchOnDescription: true, matchOnDetail: true });
    if (!pick) return;
    this.pinned = pick.file;
    await this.ctx.workspaceState.update('pinnedSession', this.pinned);
    this.state = undefined;
    this.tick(true);
  }

  async clearFinished() {
    for (const t of this.tasks()) if (t.view !== 'running') this.hidden.add(t.id);
    await this.ctx.workspaceState.update('hiddenTasks', [...this.hidden].slice(-2000));
    this.tick(true);
  }
}

function escapeMd(s) { return String(s).replace(/([\\`*_{}[\]<>|])/g, '\\$1'); }

function activate(ctx) {
  const provider = new Provider(ctx);
  for (const id of ['claudeBackgroundTasks', 'claudeBackgroundTasksStandalone']) {
    const v = vscode.window.createTreeView(id, { treeDataProvider: provider });
    provider.views.push(v);
    ctx.subscriptions.push(v);
  }
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeBackgroundTasks.refresh', () => { provider.state = undefined; provider.tick(true); }),
    vscode.commands.registerCommand('claudeBackgroundTasks.chooseSession', () => provider.chooseSession()),
    vscode.commands.registerCommand('claudeBackgroundTasks.clearFinished', () => provider.clearFinished()),
    vscode.commands.registerCommand('claudeBackgroundTasks.openOutput', async (t) => {
      if (!t || !t.outputFile) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(t.outputFile));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('claudeBackgroundTasks.stop', (t) => provider.stop(t)),
    vscode.commands.registerCommand('claudeBackgroundTasks.copyId', (t) => t && vscode.env.clipboard.writeText(t.taskId || t.id)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.tick(true)),
  );

  let timer;
  const schedule = () => {
    clearInterval(timer);
    const ms = vscode.workspace.getConfiguration('claudeBackgroundTasks').get('pollIntervalMs', 1500);
    timer = setInterval(() => { try { provider.tick(false); } catch (e) { console.error(e); } }, Math.max(500, ms));
  };
  schedule();
  ctx.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeBackgroundTasks') && (schedule(), provider.tick(true))),
  );
  provider.tick(true);
}

function deactivate() {}

module.exports = { activate, deactivate };
