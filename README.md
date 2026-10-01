# Agent Communication — session viewer

A local web app that reads sessions off disk and shows, on a black background,
**who talks to whom** — animated along a timeline.

## Getting started

```bash
npm install
npm run dev
```

It opens itself at <http://127.0.0.1:5173/>. Nothing is installed into the system and nothing
leaves over the network: the API runs in the same process as the dev server and only reads the
local disk.

## Choosing a folder

Nothing is scanned automatically. From the top bar you press `📁 Choose folder…`, browse, and
confirm with `Scan this folder` (or `scan` on a row). Chosen folders are remembered. The browser
also offers three suggestions — they are only shortcuts to the paths below, still waiting for
your confirmation.

| Source | Where it lives |
|---|---|
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` + `<session>/subagents/agent-*.jsonl` |
| **Codex** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (titles from `session_index.jsonl`) |
| **Copilot** | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.json` and `*.jsonl` |

### Fast scanning

The walk only descends into folders that can hold agent data: the ones starting with `.` plus
the segments Copilot needs. **Copilot does not live in a dot-folder** — it sits under
`AppData/Roaming/Code/User/workspaceStorage` — so those names stay allowed; otherwise a whole
source would be lost silently. Once inside a `.folder` or `workspaceStorage`, the walk descends
freely (below that the names are hashes and dates).

Measured on the home folder: filtering the folders barely helps on its own (46s → 47s), because
the time goes into **reading Copilot's 640 MB**, not into walking. What mattered was searching
the `Buffer` directly instead of running a regex over a string: **46s → 17s** cold, and **~9s**
with the index cached on disk.

## The model: agents vs. capabilities

The distinction is deliberate and it shows in the drawing:

- **Agents** (circles, with names): you, the main agent, the delegated sub-agents. Real
  communication happens between them — delegation, messages, reports.
- **Capabilities** (small squares, no big name): `Shell`, `Filesystem`, `Web`, `Skills`,
  `MCP`, `Control`. They are not agents — they are things an agent *runs*.

Every agent has **its own** set of capabilities, attached next to it. The drawing is **radial**:
the main agent holds the middle, while you and the sub-agents ride a ring around it, each one's
capabilities fanned outwards.

```
                    · · feature-analyst · ·
                  ·                          ·
        You ─────────►   Main Agent    ─────────►  feature-qa
                  ·    (Shell · Filesystem ·        · Filesystem
                    · ·  Skills · Control)  · ·       · Shell
```

Nothing scrolls: the ring radius and the circle sizes are computed from the measured window, so
the whole graph fits on screen at 100%. With 4 sub-agents the circles are fat, with 40 they are
small — but all of them are still there.

Edges between agents are coloured and thicker; tool executions are grey and thin. `SendMessage`
between agents is dotted, as an agent→agent edge.

### What is visible and what is not

For Claude, every sub-agent's transcript exists on disk, so **the tools used by sub-agents** are
visible too, not just the delegation. For Codex and Copilot, what a sub-agent does inside is not
recorded — there, sub-agents stay leaf nodes.

## Controls

| Action | How |
|---|---|
| Play / Pause | `▶ Run` or **Space** |
| Step by step | `◀` `▶` or the **arrow keys** |
| Jump in time | click or drag on the event strip |
| Speed | `0.5×` … `16×` |
| Isolate an agent | hover over it (the rest fades) |
| Switch session | the tree on the left (search by title, project or agent) |
| Find an event | the **Events** panel: search messages, tool names or agents |
| Review conversation / errors | **Conversation** or **Errors** in the Events panel |
| Jump to a result | click an event, or use the panel's previous / next buttons |

The current message is pinned at the top, with the sending agent's name above it, 5 lines and
scrolling.

The **Events** panel searches the loaded session's event content (as retained by the parser),
including tool results. Matches show a highlighted excerpt; selecting one updates the graph,
message and timeline together and pauses playback and **Follow latest** so live updates do not
pull you away. **Live** keeps refreshing the data. Re-enable **Follow latest** to resume following
incoming events. Results are paginated in groups of 60 for long sessions. Use the **Events**
button in the header to hide or reopen the panel.
On compact windows, the panel uses the graph's space; close it to return to the graph.

UI regression checks use synthetic sessions and never scan personal folders:

```bash
npx playwright install chromium
npm test
```

To use an installed browser instead, set `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`)
before running the tests.

## Live

The **Live** checkbox watches the selected folders and streams filesystem changes to the browser,
so transcript updates and new sessions normally appear immediately. A cheap 4-second *pulse*
remains active as a fallback on filesystems without recursive watching or while the live stream
reconnects. A stable full scan also runs once a minute as a final discovery fallback.

Changed sessions get a `new` tag in the tree; if the open session grows, the graph reloads. With
**Follow latest** ticked, every incoming update moves the cursor to the last event. **Live** owns
data refresh; **Follow latest** only controls the open session's cursor.

The index is incremental (a file is re-read only when its `mtime`/size changes) and it is saved
to disk, so later starts are fast.

## Deep-link

- `#<sessionId>` — opens a session
- `#<sessionId>@<index>` — opens it at a given moment

## Structure

```
src/
  parser/
    common.js        agents, capabilities, the graph builder
    jsonl.js         streaming reads (lines, head, tail)
    registry.js      discovery, source detection, incremental index
    api.js           /api/roots, /api/browse, /api/sessions, /api/session
    sources/
      claude.js      session + the sub-agent transcripts
      codex.js       rollouts
      copilot.js     .json snapshot and .jsonl journal
  components/
    SessionTree.jsx  tree: source -> project -> session
    RootPicker.jsx   top bar, folder browser
    GraphView.jsx    the radial graph (ring of agents) + the animation
    MessagePanel.jsx the current message, pinned at the top
    EventExplorer.jsx searchable events, conversation/error filters and direct navigation
    Timeline.jsx     playback, event strip, scrubbing
```

### Known limits

Copilot sessions above **260 MB** do not load (`MAX_BYTES` in `sources/copilot.js`) — a
`JSON.parse` at that scale would block the server. The largest one here is 112 MB and works.

The ring holds without anything touching up to about **45 sub-agents** on a normal window
(≥ 900×480) and **~25** on a small one. Past that the circles start to overlap — but they all
stay on screen, none is dropped.
