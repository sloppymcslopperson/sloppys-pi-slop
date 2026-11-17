# @sloppymcslopperson/pi-freshmaker

A Pi extension that watches the files loaded into context and takes per-session
checkpoints of their modification times and sizes. When a tracked file changes,
the next enabled agent run receives a hidden notice listing the stale files.

## Install

Install this checkout as a Pi package:

```bash
pi install /path/to/freshmaker
```

Or try it without installing:

```bash
pi -e ./extensions/freshmaker.ts
```

## Commands

Monitoring is on by default at the start of each session. Use
`/freshmaker off` to stop checks and checkpoint appends for the rest of the
session.

| Command | Behavior |
| --- | --- |
| `/freshmaker` | Toggle monitoring on or off. |
| `/freshmaker on` | Start monitoring. The first enable takes a silent baseline. |
| `/freshmaker off` | Stop checks and checkpoint appends. Reads are still tracked. |
| `/freshmaker status` | Show on/off state, tracked count, checkpoint number, and log path. |
| `/freshmaker list` | Live-stat tracked files and show changes since the latest checkpoint. Works while off and does not append a checkpoint. |
| `/freshmaker clear` | Replace the current session log, reset the watch list, and keep the on/off state. If enabled, a silent empty baseline is established. |
| `/freshmaker clean [duration]` | Remove old session logs under the temp root. Defaults to `PI_FRESHMAKER_MAX_AGE` or `1d`; supports `ms`, `s`, `m`, `h`, `d`, and `w`. |

Enabling after a disabled period reports changes against the last enabled
checkpoint, including changes made while monitoring was off. Files that are
read while off are still added to the watch list and baselined at read time.

## What gets tracked

- Files successfully opened with the `read` tool.
- Context files and loaded skill files reported by `before_agent_start`.
- Paths outside the working directory too. Paths are resolved and de-duplicated.
- FIT ticket files are included when they are actually read; the extension does
  not scan the board proactively.

New files are statted immediately when first tracked, so they are not reported
as changed merely because they entered the watch list.

## Change detection

A file is considered changed when its `mtimeMs` or `size` differs from the last
known state. Deleted files are reported as deleted. If a tracked file reappears
without being read again, it is reported as added.

A run checks for changes when it starts. The checkpoint is written only when
that run settles and the agent is waiting for user input. Files the agent read
and then wrote during the same run are baselined as the agent left them, so
they are not falsely reported on the next prompt. If files changed, the run
also receives a hidden (`display: false`) custom message:

```text
[FRESHMAKER] Files loaded into context have changed since the last checkpoint:
- modified: src/example.ts (1200 B, mtime ... -> 1400 B, mtime ...)

Some context may be stale. Re-read any changed file before relying on its contents.
```

## Logs

Logs are append-only JSONL files:

```text
<tmp>/pi-freshmaker/<session-id>/checkpoints.jsonl
```

Each line is a checkpoint record containing the session id, reason, timestamp,
checkpoint number, and a snapshot mapping absolute paths to
`{ mtimeMs, size }` (or `null` for a missing file). `/freshmaker clean` removes
other session directories whose logs are older than the threshold and never
removes the current session.

On `/resume`, `/fork`, or extension reload, tracked read paths are rebuilt from
the active session branch and a fresh silent baseline is written, so old
changes are not replayed.

## Development

```bash
cd freshmaker
npm test
```

The tests use Node's built-in test runner and cover duration parsing, command
parsing, change detection, formatting, checkpoint logs, and stale-log cleanup.
