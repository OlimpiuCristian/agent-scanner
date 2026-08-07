/**
 * Claude Code adapter.
 *   main session: <root>/<project>/<sessionId>.jsonl
 *   sub-agents:   <root>/<project>/<sessionId>/subagents/agent-<agentId>.jsonl
 * Each sub-agent transcript holds its own tool calls, so the
 * agent -> sub-agent -> tools hierarchy can be reconstructed in full.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GraphBuilder, classifyTool, clip, baseName } from '../common.js';
import { readJsonl, readJsonlHead } from '../jsonl.js';

export const id = 'claude';
export const label = 'Claude Code';
export const color = '#d97757';

export const defaultRoots = () => [path.join(os.homedir(), '.claude', 'projects')];

const TOOL_MAP = {
  Bash: 'shell', PowerShell: 'shell',
  WebSearch: 'web', WebFetch: 'web',
  Read: 'fs', Write: 'fs', Edit: 'fs', MultiEdit: 'fs', NotebookEdit: 'fs', Glob: 'fs', Grep: 'fs',
  Skill: 'skill',
  TodoWrite: 'control', ToolSearch: 'control', Monitor: 'control',
  TaskStop: 'control', TaskOutput: 'control', Artifact: 'control',
};

export async function sniff(file) {
  if (!file.endsWith('.jsonl')) return false;
  const head = await readJsonlHead(file, 6);
  return head.some((o) => o && (o.type === 'ai-title' || o.type === 'last-prompt' ||
    ((o.type === 'user' || o.type === 'assistant') && o.uuid && 'parentUuid' in o)));
}

const SYNTHETIC_RE = /^\s*<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)/;
const INJECTED_RE = /^\s*(Base directory for this skill|Caveat: The messages below|\[Request interrupted|API Error|\[SYSTEM NOTIFICATION)/;
const isSynthetic = (t) => !t || !t.trim() || SYNTHETIC_RE.test(t) || INJECTED_RE.test(t);

function resultToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function summarize(name, i = {}) {
  switch (name) {
    case 'Bash': case 'PowerShell': return i.description || clip(i.command, 90);
    case 'WebSearch': return 'search: ' + clip(i.query, 80);
    case 'WebFetch': return 'fetch: ' + clip(i.url, 80);
    case 'Read': case 'Write': return baseName(i.file_path || i.notebook_path);
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit ' + baseName(i.file_path || i.notebook_path);
    case 'Glob': return 'glob ' + clip(i.pattern, 60);
    case 'Grep': return 'grep ' + clip(i.pattern, 60);
    case 'Agent': case 'Task': return i.description || clip(i.prompt, 80);
    case 'SendMessage': return i.summary || clip(i.message, 80);
    case 'Skill': return 'skill: ' + (i.skill || '');
    case 'TodoWrite': return 'update plan';
    case 'AskUserQuestion': return clip(i.questions?.[0]?.question || 'question', 90);
    default: return name;
  }
}

function detail(name, i = {}) {
  if (name === 'Bash' || name === 'PowerShell') return clip(i.command, 3000);
  if (name === 'WebSearch') return clip(i.query, 1000);
  if (name === 'WebFetch') return clip((i.url || '') + '\n\n' + (i.prompt || ''), 1500);
  if (name === 'Agent' || name === 'Task') return clip(i.prompt, 3000);
  if (name === 'SendMessage') return clip((i.summary ? i.summary + '\n\n' : '') + (i.message || ''), 3000);
  if (name === 'Write') return clip((i.file_path || '') + '\n\n' + (i.content || ''), 2000);
  if (name === 'Edit') return clip((i.file_path || '') + '\n\n- ' + (i.old_string || '') + '\n+ ' + (i.new_string || ''), 2000);
  try { return clip(JSON.stringify(i, null, 2), 2500); } catch { return ''; }
}

const decodeProjectDir = (n) => n.replace(/^([a-zA-Z])--/, '$1:/').replace(/-/g, '/');
const subagentDir = (file) => path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');

export async function index(file) {
  let title = null, lastPrompt = null, first = null, last = null;
  let msgs = 0, tools = 0, cwd = null;
  const subs = new Set();

  await readJsonl(file, (o) => {
    if (o.type === 'ai-title' && o.aiTitle) title = o.aiTitle;
    else if (o.type === 'last-prompt' && o.lastPrompt) lastPrompt = o.lastPrompt;
    if (o.cwd) cwd = o.cwd;
    if (o.timestamp) { if (!first) first = o.timestamp; last = o.timestamp; }
    if (o.type === 'user' || o.type === 'assistant') msgs++;
    for (const b of o.message?.content || []) {
      if (b?.type === 'tool_use') {
        tools++;
        if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) subs.add(b.input.subagent_type);
      }
    }
  });

  if (!msgs) return null;
  return {
    sessionId: path.basename(file, '.jsonl'),
    title: title || (lastPrompt ? clip(lastPrompt, 70) : path.basename(file, '.jsonl').slice(0, 8)),
    project: cwd ? cwd.replace(/\\/g, '/') : decodeProjectDir(path.basename(path.dirname(file))),
    start: first, end: last, messages: msgs, tools,
    subagents: [...subs],
  };
}

/** Reads sub-agent transcripts: agentId -> {promptHead, records}. */
async function loadSubagents(file) {
  const dir = subagentDir(file);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(dir, f);
    const records = [];
    let agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    try {
      await readJsonl(full, (o) => {
        if (o.agentId) agentId = o.agentId;
        records.push(o);
      });
    } catch { continue; }
    if (!records.length) continue;
    const firstUser = records.find((o) => o.type === 'user');
    const head = normalize(typeof firstUser?.message?.content === 'string'
      ? firstUser.message.content
      : resultToText(firstUser?.message?.content));
    out.push({ agentId, file: full, head, records, name: null });
  }
  return out;
}

const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

export async function parse(file) {
  const g = new GraphBuilder();
  let sessionId = path.basename(file, '.jsonl');
  let title = null, lastPrompt = null, cwd = null, gitBranch = null;

  const subs = await loadSubagents(file);
  const byId = new Map(subs.map((s) => [s.agentId, s]));

  /* Step 1: the main session. Sub-agent names come from the Agent calls, and
     matching them to a transcript is done on the prompt text. */
  const mainRecords = [];
  await readJsonl(file, (o) => mainRecords.push(o));

  let lastTs = null;
  for (const o of mainRecords) {
    const ts = o.timestamp || lastTs;
    if (o.timestamp) lastTs = o.timestamp;

    if (o.type === 'ai-title' && o.aiTitle) { title = o.aiTitle; continue; }
    if (o.type === 'last-prompt' && o.lastPrompt) { lastPrompt = o.lastPrompt; continue; }
    if (o.sessionId) sessionId = o.sessionId;
    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (o.isSidechain) continue; // handled separately, below

    if (o.type === 'user') {
      const c = o.message?.content;
      for (const b of Array.isArray(c) ? c : [{ type: 'text', text: c }]) {
        if (!b) continue;
        if (b.type === 'tool_result') {
          const txt = resultToText(b.content);
          g.result({ ts, actor: 'orchestrator', callId: b.tool_use_id, text: txt, isError: b.is_error === true || /^Error:/.test(txt) });
        } else if (b.type === 'text' && !isSynthetic(b.text)) {
          g.prompt({ ts, text: b.text });
        }
      }
      continue;
    }

    if (o.type === 'assistant') {
      if (o.message?.model) g.models.add(o.message.model);
      for (const b of o.message?.content || []) {
        if (!b) continue;
        if (b.type === 'thinking' && b.thinking) { g.think({ ts, text: b.thinking }); continue; }
        if (b.type === 'text' && b.text?.trim()) { g.reply({ ts, text: b.text }); continue; }
        if (b.type !== 'tool_use') continue;

        // real delegation to a sub-agent
        if (b.name === 'Agent' || b.name === 'Task') {
          const name = b.input?.subagent_type || 'general-purpose';
          const match = subs.find((s) => !s.name && s.head && normalize(b.input?.prompt).slice(0, 120) === s.head.slice(0, 120))
            || subs.find((s) => !s.name && s.head && s.head.startsWith(normalize(b.input?.prompt).slice(0, 60)));
          if (match) match.name = name;
          const target = g.subagent(name, { key: match ? match.agentId : name });
          if (match) match.nodeId = target;
          g.delegate({ ts, target, callId: b.id, label: summarize(b.name, b.input), detail: detail(b.name, b.input) });
          continue;
        }

        // message to another agent: `to` is the recipient's agentId
        if (b.name === 'SendMessage' && b.input?.to) {
          const s = byId.get(b.input.to);
          const target = s?.nodeId || g.subagent(s?.name || 'agent ' + String(b.input.to).slice(0, 6), { key: b.input.to });
          if (s) s.nodeId = target;
          g.message({ ts, actor: 'orchestrator', target, callId: b.id, label: summarize(b.name, b.input), detail: detail(b.name, b.input) });
          continue;
        }

        g.call({
          ts, actor: 'orchestrator',
          capability: classifyTool(b.name, TOOL_MAP),
          kind: b.name === 'AskUserQuestion' ? 'ask' : 'call',
          tool: b.name, callId: b.id,
          label: summarize(b.name, b.input), detail: detail(b.name, b.input),
        });
      }
    }
  }

  /* Step 2: each sub-agent's transcript, attributed to its own node. */
  for (const s of subs) {
    const actor = s.nodeId || g.subagent(s.name || 'agent ' + s.agentId.slice(0, 6), { key: s.agentId });
    s.nodeId = actor;
    let ts2 = null;
    for (const o of s.records) {
      const ts = o.timestamp || ts2;
      if (o.timestamp) ts2 = o.timestamp;

      if (o.type === 'user') {
        const c = o.message?.content;
        for (const b of Array.isArray(c) ? c : [{ type: 'text', text: c }]) {
          if (!b) continue;
          if (b.type === 'tool_result') {
            const txt = resultToText(b.content);
            g.result({ ts, actor, callId: b.tool_use_id, text: txt, isError: b.is_error === true || /^Error:/.test(txt) });
          }
          // the received instructions are already represented by the delegation edge
        }
        continue;
      }

      if (o.type === 'assistant') {
        for (const b of o.message?.content || []) {
          if (!b) continue;
          if (b.type === 'thinking' && b.thinking) g.think({ ts, text: b.thinking, actor });
          else if (b.type === 'text' && b.text?.trim()) g.reply({ ts, text: b.text, actor, to: 'orchestrator' });
          else if (b.type === 'tool_use') {
            if (b.name === 'Agent' || b.name === 'Task') {
              const nested = g.subagent(b.input?.subagent_type || 'sub-agent', { parent: actor });
              g.delegate({ ts, actor, target: nested, callId: b.id, label: summarize(b.name, b.input), detail: detail(b.name, b.input) });
            } else {
              g.call({
                ts, actor, capability: classifyTool(b.name, TOOL_MAP),
                kind: b.name === 'AskUserQuestion' ? 'ask' : 'call',
                tool: b.name, callId: b.id,
                label: summarize(b.name, b.input), detail: detail(b.name, b.input),
              });
            }
          }
        }
      }
    }
  }

  return g.finish({
    sessionId, source: id, file,
    title: title || (lastPrompt ? clip(lastPrompt, 70) : sessionId.slice(0, 8)),
    cwd, gitBranch,
    project: cwd ? cwd.replace(/\\/g, '/') : decodeProjectDir(path.basename(path.dirname(file))),
  });
}
