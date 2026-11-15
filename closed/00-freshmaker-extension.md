---
grilled: true
completed: "2026-11-15T23:28:46.676Z"
---

Freshmaker is a Pi extension at ./freshmaker that tracks files loaded into context, detects mtime/size changes between checkpoints, and appends per-session checkpoint records. Each enabled agent run can inject a hidden change notice, and /freshmaker commands expose status, list, clear, and cleanup.

### Decisions from grilling
- Activation: loaded as an always-installed Pi package, but monitoring is toggled with `/freshmaker`; default is off for each session. `/freshmaker [on|off|toggle|status|list|clear|clean]`.
- Tracked files: files read successfully with the `read` tool, plus `before_agent_start` context files and loaded skill files. De-duplicate by resolved absolute path. Track all paths, including those outside cwd. FIT ticket files are tracked when actually read (no proactive board scanning).
- New tracked files are statted and baselined immediately at read/track time.
- While monitoring is off, reads are still tracked and baselined, but no stat checks, hidden injections, or checkpoint appends happen.
- Change detection: modification time plus size (`mtimeMs` + `size`).
- Checkpoints: append-only JSONL per session at `/tmp/pi-freshmaker/<session-id>/checkpoints.jsonl`, created at session start. Every agent run while enabled appends one checkpoint record with the full tracked-path snapshot.
- Re-enabling reports changes against the last enabled checkpoint (including changes made while off). Before any checkpoint exists, enabling takes a silent baseline.
- Triggers: every `before_agent_start` run (both user and custom), not just human prompts.
- Injection: a hidden custom message (`display: false`) listing changed/added/deleted files, only when a change exists.
- `/freshmaker list`: works whether on or off; performs a live stat against the latest checkpoint and shows changed/added/deleted files with old and new mtime/size, plus the log path. It does not append a checkpoint.
- `/freshmaker clear`: replaces the current session log with a fresh one, clears tracked files and checkpoints, keeps the current on/off state, and takes a silent baseline if enabled.
- `/freshmaker clean [duration]`: deletes old session directories under `/tmp/pi-freshmaker`, default `1d`, overridable with `PI_FRESHMAKER_MAX_AGE`; accepts `m`, `h`, and `d` suffixes. Never deletes the current session. `clear` remains separate.
- UI: footer status indicator while monitoring is enabled.
- Resume/fork/reload: rebuild tracked paths from session history (read tool inputs), then take a fresh silent baseline without reporting old changes.
- Deliverables: Pi package manifest, README, extension source, and automated tests.

### Assumptions
- Deleted tracked files are reported as `deleted`; files that reappear are compared against their last known stat.
- If a file is read multiple times, its baseline is refreshed at each read, so a read after a change does not later report that pre-read change.
- The current session is identified by `ctx.sessionManager.getSessionId()`; the log path is shown by `status` and `list`.
- Ephemeral/no-session-file operation still uses the session id for the temp directory.
- Tests use Node's built-in test runner with TypeScript, matching the vendored questionnaire package style; no network or real Pi session is required.

### Acceptance criteria
- Extension loads under Pi, registers `/freshmaker`, and survives `/reload`.
- Read and context files are tracked; mtime/size changes since the last enabled checkpoint produce a hidden injected message and a new JSONL record.
- Off mode tracks reads without checking or checkpointing; enabling reports disabled-period changes since the last enabled checkpoint.
- `/freshmaker list`, `status`, `clear`, and `clean` behave as described.
- Automated tests cover detection, checkpoint serialization, command parsing, change formatting, and stale-log cleanup.

### Implementation
- `freshmaker/package.json` declares the Pi package and points `pi.extensions` at `extensions/freshmaker.ts`.
- `freshmaker/extensions/core.ts` holds the pure, testable behavior: path resolution, stat snapshots, change diffing, checkpoint serialization, duration/command parsing, and stale-log cleanup.
- `freshmaker/extensions/freshmaker.ts` wires session start, read-tool tracking, context/skill tracking, enabled-run checkpoints, hidden injection, footer status, and the `/freshmaker` command.
- `freshmaker/README.md` documents install, command semantics, tracking rules, log format, and development.
- `freshmaker/test/core.test.ts` covers durations, commands, diffing, formatting, logs, and cleanup.
- `freshmaker/test/extension.test.ts` drives the extension with a fake Pi API and verifies toggle, read tracking, hidden injection, and footer state.

### Verification
- `node --test test/*.test.ts` from `freshmaker/`: 9 tests pass.
- TypeScript check with strict NodeNext settings against the installed Pi types: pass.

### Follow-up correction: checkpoint timing
This supersedes the earlier "every agent run" checkpoint trigger.
- `before_agent_start` still stats tracked files, compares them with the last settled checkpoint, and injects the hidden change notice.
- The checkpoint snapshot is now written at `agent_settled`, when the run has finished and the agent is waiting for user input.
- A file the agent read and then wrote during the same run is baselined as the agent left it, so it is not falsely reported on the next prompt.
- Changes made outside the agent run are still detected on the next prompt.
- README and the extension integration test were updated to cover the deferral and the read-then-write case.
- Verification: 9 tests pass; strict TypeScript check passes.
