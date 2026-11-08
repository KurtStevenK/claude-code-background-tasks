'use strict';
// Reads a Claude Code session transcript (~/.claude/projects/<slug>/<session>.jsonl)
// incrementally and keeps the list of background tasks it started.
// No VS Code dependency, so it can be tested with plain node.

const fs = require('fs');

const BG_TOOLS = new Set(['Bash', 'PowerShell', 'Agent', 'Task', 'Monitor', 'Workflow']);

function firstLine(s, max = 90) {
  const line = String(s || '').split(/\r?\n/).find((l) => l.trim()) || '';
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function kindOf(name) {
  if (name === 'Bash' || name === 'PowerShell') return 'shell';
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (name === 'Monitor') return 'monitor';
  if (name === 'Workflow') return 'workflow';
  return 'other';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

function tag(s, name) {
  const m = s.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1].trim() : undefined;
}

class SessionState {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
    this.title = undefined;
    this.pending = new Map(); // tool_use_id -> { name, input, ts }
    this.tasks = new Map(); // tool_use_id -> task
    this.lastTs = undefined;
  }

  /** Read whatever was appended since last time. Returns true if anything changed. */
  update() {
    let st;
    try { st = fs.statSync(this.file); } catch { return false; }
    this.mtime = st.mtimeMs;
    if (st.size < this.offset) { // file was rewritten: start over
      const f = this.file; Object.assign(this, new SessionState(f)); this.mtime = st.mtimeMs;
    }
    if (st.size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      this.feed(buf.toString('utf8'));
    } finally { fs.closeSync(fd); }
    return true;
  }

  feed(chunk) {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop();
    for (const line of lines) this.line(line);
  }

  line(line) {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.isSidechain) return;
    const ts = o.timestamp ? Date.parse(o.timestamp) : undefined;
    if (ts) this.lastTs = ts;

    if (o.type === 'ai-title' && o.aiTitle) { this.title = o.aiTitle; return; }
    if (o.type === 'queue-operation' && typeof o.content === 'string') { this.notification(o.content, ts); return; }
    if (o.type === 'attachment' && o.attachment && typeof o.attachment.prompt === 'string') {
      this.notification(o.attachment.prompt, ts || Date.parse(o.attachment.timestamp)); return;
    }
    const msg = o.message;
    if (!msg || (o.type !== 'user' && o.type !== 'assistant')) return;

    if (o.type === 'user' && typeof msg.content === 'string') { this.notification(msg.content, ts); return; }
    if (!Array.isArray(msg.content)) return;

    for (const b of msg.content) {
      if (!b) continue;
      if (b.type === 'tool_use' && BG_TOOLS.has(b.name)) {
        if (!this.pending.has(b.id)) this.pending.set(b.id, { name: b.name, input: b.input || {}, ts });
      } else if (b.type === 'tool_result' && this.pending.has(b.tool_use_id)) {
        this.result(b, o.toolUseResult, ts);
      } else if (b.type === 'text' && o.type === 'user') {
        this.notification(b.text, ts);
      }
    }
  }

  result(block, r, ts) {
    const id = block.tool_use_id;
    const p = this.pending.get(id);
    if (block.is_error || this.tasks.has(id)) return;
    const text = textOf(block.content);
    const rr = r && typeof r === 'object' ? r : {};
    const bgMatch = text.match(/running in background with ID: (\w+)/);
    const kind = kindOf(p.name);
    let taskId;
    if (kind === 'shell') {
      if (!p.input.run_in_background && !rr.backgroundTaskId && !bgMatch) return;
      taskId = rr.backgroundTaskId || (bgMatch && bgMatch[1]);
    } else if (kind === 'agent') {
      if (!(rr.status === 'async_launched' || rr.isAsync)) return; // ran in the foreground
      taskId = rr.agentId;
    } else {
      taskId = rr.taskId || rr.runId || rr.backgroundTaskId;
      if (!taskId && !/background|task/i.test(text)) return;
    }
    const out = text.match(/Output is being written to: (.+?\.output)/);
    const input = p.input;
    this.tasks.set(id, {
      id,
      taskId,
      kind,
      tool: p.name,
      label: firstLine(input.description) || firstLine(input.command) || firstLine(input.name) || p.name,
      detail: input.command || input.prompt || input.script || '',
      startedAt: p.ts || ts,
      endedAt: undefined,
      status: 'running',
      outputFile: out ? out[1] : undefined,
      summary: undefined,
    });
  }

  notification(s, ts) {
    if (typeof s !== 'string' || !s.includes('<task-notification>')) return;
    const body = s.slice(s.indexOf('<task-notification>'));
    const toolUseId = tag(body, 'tool-use-id');
    const status = tag(body, 'status');
    if (!toolUseId || !status) return; // stream events without a final status
    let t = this.tasks.get(toolUseId);
    const summary = tag(body, 'summary');
    if (!t) {
      // started before we could see it (or by something we do not track)
      const m = summary && summary.match(/"([^"]+)"/);
      const p = this.pending.get(toolUseId);
      t = {
        id: toolUseId,
        taskId: tag(body, 'task-id'),
        kind: p ? kindOf(p.name) : /^Agent/.test(summary || '') ? 'agent' : /^Monitor/.test(summary || '') ? 'monitor' : 'shell',
        tool: p ? p.name : undefined,
        label: (p && (firstLine(p.input.description) || firstLine(p.input.command))) || (m && m[1]) || firstLine(summary) || 'Background task',
        detail: p ? p.input.command || p.input.prompt || '' : '',
        startedAt: p ? p.ts : undefined,
        status: 'running',
      };
      this.tasks.set(toolUseId, t);
    }
    // completed | failed | killed | stopped (a task cut off when its session ended)
    t.status = status === 'stopped' || status === 'cancelled' ? 'killed' : status === 'error' ? 'failed' : status;
    t.endedAt = ts || t.endedAt;
    t.summary = summary || t.summary;
    t.outputFile = tag(body, 'output-file') || t.outputFile;
    t.taskId = t.taskId || tag(body, 'task-id');
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
}

function formatDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

module.exports = { SessionState, formatDuration };
