# pi-fit

FIT tickets for Pi — small, predictable, and hard for an agent to break.

[FIT](https://github.com/HeadEmptyNoNotes/FIT) keeps tasks as plain Markdown
files in status folders. There is no database and no background service: the
board is just files you can read, diff, and commit.

`pi-fit` adds three things on top:

- **Agent tools** that work with exact ticket ids and refuse to overwrite or
  silently corrupt the board.
- A **human `/fit` command** with fuzzy lookup, a picker for ambiguous matches,
  and shortcuts for the everyday ticket workflow.
- A **`pi-fit` CLI** for the same non-AI board operations from a terminal or
  script, without loading Pi.

The full FIT specification is
[FIT_SPEC.md](https://github.com/HeadEmptyNoNotes/FIT/blob/main/FIT_SPEC.md).

## What a board looks like

```text
fit/
  open/
    03-fix-typo-in-readme.md
  in_progress/
    05-add-search-command.md
  backlog/
    12-try-a-new-layout.md
  closed/
    01-initial-setup.md
  FIT_SPEC.md
```

The directory is the status. The leading two-digit number is the priority and
sort key (`00` first), not the ticket's identity. The short name after the
prefix is the identity and must be unique across the board. Tickets are
Markdown files with optional YAML frontmatter.

A board without a `STRICT` marker is Basic (permissive). Add `STRICT` with the
quoted spec version, for example `"0.5"`, for Strict naming, priority,
uniqueness, body, archive, and lifecycle rules. Tools never infer status,
priority, or identity from frontmatter.

## Quick start

Install the addon, then start Pi:

```bash
pi install ./FIT_pi
pi
```

Create a board and your first ticket:

```text
/fit init
/fit new open 3 Fix the typo in the README.
```

Start working on it:

```text
/fit start Fix the typo in the README.
```

`/fit start` creates a priority-0 ticket, moves it to `in_progress`, and sends
the agent a prompt with the ticket contents.

To browse the board at any time:

```text
/fit
/fit show
/fit help
```

## Why it is safe to hand to an agent

The agent-facing tools are deliberately strict:

- **Exact ids.** A ticket id is its board-relative path, such as
  `open/03-fix-typo-in-readme.md`. A bare filename or unique short name (`fix-typo-in-readme`)
  works only when it identifies exactly one ticket. The path addresses the file;
  the short name is the identity used for uniqueness and display. Ambiguity is
  an error with candidates, never a guess.
- **No silent overwrites or suffixes.** Short names are unique across the whole
  board, and a collision fails with `NAME_TAKEN` and a suggested free name; a
  repeated identical create stays idempotent. Existing tickets are never
  replaced.
- **Atomic writes.** Writes use a same-directory temporary file and rename, so a
  crash cannot leave a half-written ticket.
- **Revision checks.** `fit_show` returns a revision. Passing it as
  `expectedRevision` makes a later update or move fail if the ticket changed
  underneath the agent.
- **No delete tool.** Closing moves a ticket to `closed/`; nothing is removed.
- **Path confinement.** Ticket paths must stay inside the board. Traversal,
  root-level Markdown, and symlink escapes are rejected.
- **Frontmatter preservation.** Updating one field leaves comments, nested YAML,
  and untouched formatting alone.
- **Idempotent retries.** Repeating an identical create is a no-op, as is moving
  a ticket to its current status or saving identical content.
- **Direct-edit guard.** Built-in `write`/`edit` calls targeting the board are
  blocked by default, along with obvious shell mutations that mention it. This
  is a guardrail, not a sandbox; disable it with `--fit-guard=false` or
  `FIT_GUARD=0` if you need to.

Fuzzy matching belongs to humans only. `/fit show typo` can suggest tickets and
ask you to pick one; the agent tools never do that.

## Installation

During local development:

```bash
pi install ./FIT_pi
```

Try it for one run without installing:

```bash
pi -e /path/to/FIT_pi/src/index.ts
```

From a published Git source:

```bash
pi install git:github.com/<you>/FIT_pi
```

This is a normal Pi package: `package.json` declares
`pi.extensions: ["./src/index.ts"]`.

## Command-line interface

The package also provides a `pi-fit` executable for the non-AI parts of the
board: ticket CRUD, checks, maintenance, init, and Git recording. It imports the
core board logic directly and does not load Pi or any AI tooling.

```bash
# After installing the package or linking this checkout
pi-fit --board docs/fit list
pi-fit show add-ui-element-showing
pi-fit new open 3 Fix the typo in the README.
pi-fit move fix-the-typo-in-the-readme in_progress
pi-fit check --json

# From this repository
node src/cli.ts list --board fit
```

The board defaults to `./fit`, then `FIT_BOARD`; `--board`/`-b` overrides both
and may appear before or after the command. Ticket lookup accepts an exact
board-relative id, a bare filename, or a unique short name. Unlike the human
`/fit` command, the CLI never fuzzy-matches or prompts: ambiguity fails with
candidates, and every operation is non-interactive.

| Command | What it does |
| --- | --- |
| `list [--status] [--prefix] [--limit] [--all]` | Show tickets and counts |
| `show [id]` | Show a ticket; no id uses the current `in_progress` ticket |
| `new`/`add [status] [priority] <text>` | Create a ticket with optional `--slug`, `--title`, `--project`, `--body`, `--body-file`, and `--set` |
| `update <id>` | Replace/append the body, set/unset frontmatter, rename, or check a revision |
| `move`/`mv <id> <status>` | Move a ticket, optionally renaming it or checking a revision |
| `close [id]` | Move to `closed`; no id uses the current `in_progress` ticket |
| `priority <id> <0-99>` | Change the filename priority |
| `archive <id>` / `restore <record>` | Archive a closed ticket or restore an archive record |
| `check` / `check cleanup` / `check migrate` / `check normalize` | Validate, rename long names, report migrations, or normalize bodies |
| `init [--strict] [--refresh] [--git]` | Create or update the board scaffold |
| `git` | Record parent commits on closed tickets and commit the board |
| `mode` / `next` / `path <id>` / `name ...` | Read board mode, next ticket, absolute path, or the free filename `new` would use |

Every command supports `--json`. Successful output uses a stable envelope such
as `{ "ok": true, "command": "list", "board": "...", ... }`; errors use
`{ "ok": false, "command": "...", "board": "...", "error": "...", "code": "..." }`
and go to stderr. Exit codes are `0` for success, `1` for FIT/operational
errors, and `2` for CLI usage errors.

`--body-file` and `--append-file` accept `-` for stdin. `--set key=value` parses
JSON scalars and arrays as typed frontmatter values; other values stay strings.
Strict `check` failures that contain errors exit `1` even though the check
itself completed.

## Configuration

The board defaults to `./fit`. Override it, in order of precedence, with:

1. the `board` argument on a tool call
2. the `--fit-dir` extension flag
3. the `FIT_BOARD` environment variable

```bash
pi --fit-dir docs/fit -e ./src/index.ts
```

### Guard settings

The direct-edit guard is on by default. Turn it off for one session with either:

```bash
pi --fit-guard=false -e ./src/index.ts
FIT_GUARD=0 pi -e ./src/index.ts
```

The shell guard is heuristic. It blocks commands that both mention the board and
look like mutations; it does not sandbox arbitrary shell code.

### Planner mode

Planner mode makes the agent read-only everywhere except the FIT board. Use it
when the session should focus on planning FIT tickets without touching
application code:

```bash
pi --fit-plan -e ./src/index.ts
FIT_PLAN=1 pi -e ./src/index.ts
```

Toggle it during a session with `/fit planner` (`/fit planner on`,
`/fit planner off`, or `/fit planner status`), or press `Ctrl+Shift+A`.
`/fit plan` is an alias for `/fit planner`. In planner mode:

- The footer shows `planner: FIT-only mode`, uses a warning-colored footer, and
  `/fit` / `/fit list` add a `Planner mode: on (FIT-only)` header line.
- Startup shows a one-time notice, and each agent run gets a visible reminder
  that the board is the only writable area.
- `write` and `edit` are blocked everywhere, including board files; board
  changes must use the `fit_*` tools.
- Shell commands must be read-only. Chaining, redirection, command
  substitution, unknown commands, and mutating commands are blocked.
- The read-only `ketch` CLI is allowlisted for `search`, `scrape`, `docs`,
  `code`, `crawl`, `tag`, `help`, and `version`, plus `ketch --help` and
  `ketch --version`. `ketch mcp`, unknown subcommands, `npx ketch-cli`, and the
  `--force-browser` / `--no-sandbox` flags stay blocked. The shell parser is not
  quote-aware, so queries or URLs containing `|`, `&`, `;`, redirects, or
  command substitution are rejected even inside quotes; URL-encode or simplify
  such arguments.
- PowerShell is blocked.
- `fit_init` is blocked because it writes `AGENTS.md`, `AGENT_SPEC.md`, and
  possibly `.gitignore` outside the board. Run `/fit init` manually first.
- `/fit work` and `/fit start` become plan-first: the agent finishes grilling,
  records the answers and `grilled: true` in the ticket, presents a short
  human-readable plan in chat, and stops. It does not create tickets for the
  plan or start implementing until you turn planner mode off and confirm.
- `/fit planner leg` is the deliberate split path: it turns planner mode on,
  plans a short sequence of open tickets, and stops. See [Planning a leg](#planning-a-leg).
- Turning planner mode on mid-session (with `/fit planner on`, `/fit planner`, or
  `Ctrl+Shift+A`) sends the agent a generic reminder to plan before acting and
  wait for confirmation, even if the work command already ran.

The shell allowlist is deliberately conservative. It is a guardrail, not an OS
sandbox, so run untrusted agents in a real sandbox.

### In-progress footer indicator

On a Strict board, the footer shows the current `in_progress` ticket, for
example:

```text
fit: in_progress 00-add-ui-element-showing
```

The indicator uses the filename stem without `.md` and omits any subdirectory.
It uses the footer's dim secondary-text color. It is hidden on Basic boards and
when no ticket is in progress. If a Strict board has more than one
`in_progress` ticket, the footer reports the rule violation with all ticket
names instead of picking one:

```text
fit: ERROR in_progress has 2 tickets: 00-first, 01-second
```

The indicator refreshes after session start, each tool execution, each turn,
and every `/fit` command. It does not run a background filesystem watcher, so a
move made entirely outside Pi appears on the next refresh event.

### Review mode by default

`/fit work` and `/fit start` can default to review mode:

```bash
pi --fit-review -e ./src/index.ts
FIT_REVIEW=1 pi -e ./src/index.ts
```

An explicit `review` or `false` argument on the command still wins. Without the
flag or environment variable, review mode is off.

## Agent tools

| Tool | What it does | Mutates |
| --- | --- | --- |
| `fit_init` | Create status folders, `FIT_SPEC.md`, `AGENT_SPEC.md`, and the managed `AGENTS.md` section | yes |
| `fit_list` | List tickets with exact ids, counts, and deterministic order | no |
| `fit_show` | Read one ticket, its frontmatter, body, and revision | no |
| `fit_new` | Create a ticket in `open` or `backlog` | yes |
| `fit_new_batch` | Create multiple tickets from a JSON list of ticket-like objects | yes |
| `fit_update` | Update the body and/or top-level frontmatter; optionally rename | yes |
| `fit_move` | Move a ticket between status folders | yes |
| `fit_cleanup` | Truncate excessively long ticket filenames; supports `maxLength` and `dryRun` | yes |
| `fit_archive` | Append a closed ticket to `closed/archive.txt` and remove the ticket file | yes |
| `fit_restore` | Restore an archive record as a new ticket and remove the record | yes |
| `fit_check` | Validate board structure and conventions | no |

`fit_init` accepts `git: true` to also add the board to the parent `.gitignore`
and check it out as a linked worktree on the parent repo's `fit` branch. If the
branch already exists, local tickets are merged into it; a ticket with the same
path on both sides prompts for the branch or local version. Plain initialization
leaves the board in the parent working tree (inline), and a board in its own
repository is used as-is. See [Git modes](#git-modes) for how closing behaves in
each layout.

### Typical agent flow

```text
fit_list                         -> find open/03-fix-typo-in-readme.md
fit_show { id: "open/03-..." }   -> revision 1948177315ab3814
fit_move { id, status: "in_progress", expectedRevision: "1948..." }
fit_update { id, body: "...", expectedRevision: "<new revision>" }
fit_move { id, status: "closed", expectedRevision: "<newest revision>" }
```

### Creating tickets

```json
{
  "content": "Fix typo in README.",
  "priority": 3,
  "status": "open",
  "frontmatter": { "owner": "alice", "tags": ["docs"] }
}
```

This creates `open/03-fix-typo-in-readme.md`. If you do not pass a `slug` or
`title`, the name is derived from the first 7 words of the first sentence of
`content`; the full first sentence remains the ticket title. If the same file
already exists with identical content, the call returns it with `created: false`.
If it exists with different content, the call fails with `NAME_TAKEN` and a
suggested free name instead of silently suffixing a new ticket.

New tickets must start in `open` or `backlog`.

Use `fit_new_batch` to record a planned course of action in one call. Each item
has the same shape as `fit_new`:

```json
{
  "tickets": [
    { "content": "Add the board parser.", "priority": 1 },
    { "content": "Write parser tests.", "priority": 2, "frontmatter": { "owner": "alice" } }
  ]
}
```

Items default to `open`. Every item is validated before anything is written, so
an invalid item cannot leave a partial batch behind. Creation is otherwise
identical to `fit_new`, including `NAME_TAKEN` failures and idempotent retries.

### Cleaning up long filenames

`fit_cleanup` truncates ticket filename stems longer than 30 characters
(excluding `.md`). Pass `maxLength` to override that default, or `dryRun: true`
to preview the renames. Only the filename changes: status, subdirectory,
priority, frontmatter, and body stay put. Existing names are never overwritten;
collisions get `-2`, `-3`, and so on. The human equivalent is
`/fit check cleanup [max] [dry-run]`.

### Updating tickets

- `body` with `bodyMode: "replace"` or `"append"`
- `set` / `unset` for top-level frontmatter keys
- `priority` / `slug` to rename in place
- `expectedRevision` to reject stale writes

Unknown frontmatter lines, comments, and nested YAML are preserved.

### Moving tickets

Moving to a top-level status preserves a project subfolder:

```text
open/project-x/05-task.md  +  status "closed"
  -> closed/project-x/05-task.md
```

An explicit subtree target wins:

```text
status "closed/archive"
  -> closed/archive/05-task.md
```

`in-progress` is accepted as an alias for `in_progress`.

### Checking a board

`fit_check` reports Basic rules always, then Strict rules when the board has a
`STRICT` marker:

- missing status folders
- tickets outside a canonical status folder
- filename format (`NN-lowercase-name.md`), two-digit priority, URL-illegal or
  OS-reserved names
- short names at 30 characters or longer (warning) and duplicate short names
  (error in Strict)
- body shape (1-3 sentence summary, then level-3 headers) and empty bodies
- unclosed, invalid, or structurally conflicting frontmatter (delimiter lines
  must be exactly `---`; `completed`, `commit`, and `project` values are
  validated)
- more than one `in_progress` ticket in Strict mode
- malformed `closed/archive.txt` records
- stray root-level Markdown

`/fit check cleanup [max] [dry-run]` renames overlength filenames.
`/fit check migrate` prints a dry-run migration report, and
`/fit check normalize [dry-run]` previews or applies the Strict body shape.
Checks report problems and never fix them automatically.

## The human `/fit` command

Fuzzy matching lives here only. If several tickets match and a TUI is available,
`/fit` shows a picker. Without a UI it prints the candidates instead of choosing
one.

| Command | What it does |
| --- | --- |
| `/fit` or `/fit list [prefix]` | Show board counts and the first 100 tickets |
| `/fit planner [on\|off\|status]` | Toggle planner mode: read-only outside the board, read-only shell commands; alias `/fit plan` |
| `/fit show [query]` | Show a matching ticket, or the current `in_progress` ticket when no query is given |
| `/fit edit [local] [query]` | Open a ticket in your default editor or VS Code; `local` uses Pi's multiline editor |
| `/fit archive [query]` | Archive a closed ticket after confirmation |
| `/fit close [query]` | Close the current `in_progress` ticket, or fuzzy-match any ticket |
| `/fit move <query> <status>` | Move a ticket; alias `/fit mv` |
| `/fit priority <query> <0-99>` | Change a ticket's filename priority; alias `/fit pri` |
| `/fit work [N] [review] [nogrill] [autocommit]` | Ask the agent to work on the current ticket, or run a fixed queue of N tickets autonomously; asks before filling an empty queue from `backlog` |
| `/fit new\|add [status] [priority] <text>` | Create a ticket |
| `/fit start [review] [nogrill] <text>` | Create a priority-0 ticket, start it, and prompt the agent; plan-first in planner mode |
| `/fit planner leg [nogrill] [query\|text]` | Turn on planner mode and split a ticket into 2-7 open implementation tickets plus a final architecture review ticket; stops without implementing |
| `/fit init [strict] [refresh] [git]` | Create the board, specs, and `AGENTS.md` section; `git` uses a `fit` branch worktree, plain init is inline |
| `/fit check [cleanup [max] [dry-run]] [migrate] [normalize [dry-run]]` | Validate the board; cleanup long names, report migrations, or normalize bodies |
| `/fit git` | Stamp closed tickets with the parent commit and commit the board |
| `/fit help` | Show the full command reference |

### Starting and continuing work

`/fit work` finds the current `in_progress` ticket and sends the agent its id,
revision, and contents. If there is none, it promotes the first `open` ticket.
When only a `backlog` ticket is available, it asks before pulling that ticket
into `in_progress`, then sends the same prompt. Use it to continue existing work
or to start the next ticket.

### Batch runs

`/fit work <N>` runs a fixed queue of N tickets. The queue is taken when the
command runs: all `in_progress` tickets first, then `open` tickets. If the queue
would be empty, the command asks before filling it from `backlog`. If fewer than
N tickets exist, it works what is available and reports the shortfall.

The agent batch-grills every un-grilled ticket in the queue immediately, before
implementation starts and before any later ticket is promoted to `in_progress`.
It records the answers and `grilled: true` on each ticket, then works the queue
in order. Already-grilled tickets only get questions about genuine new gaps. If
the user cancels any setup or grilling question, the agent stops until the user
provides more context.

Between tickets the agent posts a one-line progress note and continues without
asking for confirmation. If a ticket hits a significant issue that would expand
scope beyond the grilled answers, the agent halts and asks, offering to grill,
create follow-up tickets, or stop entirely. New tickets are never added to the
current fixed queue.

`review` is rejected when N is greater than 1, because each ticket must close
before the next can start. Planner mode is plan-only, so `/fit work <N>` and any
autocommit run are rejected there too. `/fit start` does not support batch runs.

```text
/fit work 3
/fit work 3 nogrill
```

### Autocommit

`autocommit` makes the agent commit after each ticket in the run. Before closing
a ticket it stages only files changed for that ticket plus parent-repository
work files, never unrelated dirty files, and commits with `FIT: close
<short-name>`. If there are no parent changes, it skips the commit and does not
record a hash. On a commit failure or a bad repository state it halts the batch
and leaves the current ticket in `in_progress` with a short explanation and
suggested next steps.

After a real commit and close, the agent records the parent commit hash as
frontmatter `commit` with `fit_update`, then commits the board worktree so the
board stays clean. On an inline board it uses the parent repository for that
cleanup commit.

```text
/fit work autocommit
/fit work 2 autocommit
```

Without autocommit, work commits are left to you, as before.

The prompt tells the agent to grill the user with exhaustive clarifying
questions when any detail is unclear, and to offer splitting the work into
follow-up tickets when it turns out larger than expected.

With planner mode on, both commands switch to planning first. The agent records
any grilling answers in the ticket, then presents a concise plan with numbered
steps, files or areas, verification/tests, and risks or open questions. It stops
there and waits for planner mode to be turned off and for you to confirm before
executing the plan. The plan stays in chat; it is not written to the ticket or
split into new tickets unless the scope grows and you approve it.

If you turn planner mode on after the command already ran, Pi sends a generic
reminder to plan, display the plan, and wait for that same confirmation.

`/fit start` is the one-shot version of "create a ticket, start it, and tell the
agent to work." It always creates in `open`, then moves the ticket to
`in_progress`, with priority `0`.

### Planning a leg

`/fit planner leg [nogrill] [query|text]` is intentionally explicit: it turns
planner mode on, then asks the agent to split one leg of work into small tickets.
It is not an alias for planner mode or `/fit work`.

- With no text it uses the current `in_progress` ticket. With text it
  fuzzy-matches existing non-closed tickets; when a match is found, the command
  asks whether to use it or create a new umbrella ticket. With no match it
  creates a new `open` umbrella ticket from the text.
- The agent grills first unless `nogrill` is used, settles the split with you,
  then creates 2-7 implementation tickets with `fit_new_batch` under
  `open/<same project as the umbrella>`. Priorities start at `00`, names are
  prefixed with the umbrella short name, and each ticket records
  `parent: <umbrella-id>`.
- It always adds one final review ticket after the implementation tickets
  (outside the 2-7 cap), with the next priority and a `-review` suffix. That
  ticket looks for shallow modules and weak test seams in the files this leg
  changed, makes only small safe improvements, then offers a broader scan. It
  does not create an HTML plan or report unless you ask for one.
- Leg tickets stay short: a summary, `### Goal`, and `### Done when`. Each one
  gets its own grilling session later, so the planner avoids speculative detail.
- The agent appends the ordered ticket ids to the umbrella body, closes the
  umbrella, presents the leg, and stops. It does not implement anything or move
  a leg ticket to `in_progress`. Run `/fit work N` after turning planner mode off
  to execute the leg.
- If the work fits in a single ticket, the agent says so and leaves the umbrella
  unchanged instead of splitting it.

### Review mode

Commands that accept `review` treat it as an instruction to stop for a human
before closing:

```text
/fit work review
/fit start review Fix the typo in the README.
```

Review tokens are `review`, `true`, `--review`, `-r`, `yes`, `hold`, and `wait`.
Use `false`, `0`, `no`, `normal`, `none`, or `--no-review` to force normal
auto-close mode. With no token, `--fit-review` / `FIT_REVIEW` selects the
default.

For `/fit work`, a numeric token is always the batch count. Use the word
`review` rather than `1` to request review for a single-ticket run.

### Clarifying questions and scope

`/fit work` and `/fit start` tell the agent to grill the user like the popular
"grill me" workflow: it lists every unclear detail (goal, scope, acceptance
criteria, files, expected behavior, edge cases, tests, and constraints) and asks
focused questions in rounds until nothing is unresolved before starting. It
must not guess while details are unclear, and it offers splitting the work into
follow-up tickets when the task turns out larger than expected.

For a batch run, the grilling covers the whole fixed queue before any
implementation starts. If the user cancels a question, the agent stops until
more context is provided.

When the grilling is complete, the agent records it by setting
`grilled: true` in the ticket frontmatter with `fit_update`. On later runs the
prompt sees that flag and asks the agent to review the recorded answers: accept
them and start if everything needed is clear, or grill only about new gaps.
Truthy values `true`, `yes`, `done`, and `1` count as grilled.

Pass `nogrill` to omit that guidance for a prompt:

```text
/fit work nogrill
/fit start nogrill Fix the typo in the README.
```

`review` and `nogrill` may be combined in either order. To omit the guidance by
default, use `--fit-nogrill` or `FIT_NOGRILL=1`; an explicit command token still
wins.

### Opening, editing, and closing

`/fit edit [query]` opens the ticket in your system's default text editor. When
Pi runs inside a VS Code terminal, it opens the ticket in VS Code instead. With
no query it opens the current `in_progress` ticket (or shows a picker if several).
`/fit open` remains an alias.

`/fit edit local [query]` keeps the work local to Pi: it opens the body in the
multiline editor, leaves frontmatter untouched, and revision-checks the save.
`--local` and `-l` are accepted as flag spellings. The flag comes before the
query.

`/fit close` without a query only considers `in_progress` tickets. With one in
progress it closes it directly; with several it shows a picker. `/fit close
<query>` can target any ticket, matching the FIT CLI's `close <name>` behavior.

`/fit archive [query]` only considers closed tickets. It shows a picker for
several matches and asks for confirmation before appending the ticket to
`closed/archive.txt` and removing the file.

### Editor selection

Outside VS Code, `/fit edit` uses the operating system's file association:
`start` on Windows, `open` on macOS, and `xdg-open` on Linux. Inside a VS Code
terminal (`TERM_PROGRAM=vscode`, `VSCODE_PID`, or `VSCODE_IPC_HOOK_CLI`), it uses
the `code` command with `--reuse-window`. Install the VS Code shell command first
if needed:

```text
Shell Command: Install 'code' command in PATH
```

### Board initialization

`/fit init` creates the status folders, `FIT_SPEC.md`, `AGENT_SPEC.md`, and a
managed section in `AGENTS.md`. The managed section links to `AGENT_SPEC.md`,
so it is created beside the board when missing. Existing spec and agent-spec
copies, plus content outside the managed markers, are preserved.

`/fit init git` (or `--git`) also adds the board to the parent `.gitignore` and
checks it out as a linked worktree on the parent repo's `fit` branch. If the
branch does not exist, it is created from the current board contents. If it
already exists, local ticket files are merged into the branch and committed.
When the same ticket path exists both locally and on the branch, `/fit init git`
asks whether to keep the branch version or the local version. If you cancel a
conflict prompt, the merge stops and the local board is left untouched.

### Board configuration (`conf.toml`)

A board may contain an optional `conf.toml` at its root. It is a plain TOML
file and is intentionally open-ended so FIT tooling can add sections later.
Current tools read the `[git]` table for the identity used on board commits:

```toml
[git]
name = "Sloppy McSlopperson"
email = "thesloppyslopperson@gmail.com"
```

When both values are present, FIT commits board changes with that identity
(`git -c user.name=... -c user.email=...`). When the file is absent, the table
is missing, or either value is empty, commits use the repository/system Git
identity instead. Top-level `gitname` and `gitemail` keys are accepted as
aliases for `[git] name` and `[git] email`.

`conf.toml` supports tables, dotted keys, basic and literal strings, integers,
floats, booleans, and single-line arrays. Malformed configuration fails the
commit with a line-numbered error rather than silently falling back.

### Git modes

The tools detect the board layout on every close; no extra configuration is
needed after initialization.

| Mode | Setup | Closing a ticket | `completed` / `commit` |
| --- | --- | --- | --- |
| Inline (default) | `fit_init` / `/fit init` leaves the board in the parent working tree, tracked by the parent branch. | `fit_move` to `closed` only moves the file. The move belongs in the parent work commit (for example `git commit -am "Close fix-typo"`); the tool never makes its own commit. | Neither key is written automatically. Use the parent commit itself as the record. |
| Fit-branch worktree | `fit_init` with `git: true` or `/fit init git`. Adds the board to the parent `.gitignore` and checks it out as a linked worktree on the parent repo's `fit` branch. | `fit_move` to `closed` writes `completed` and commits the board branch with `FIT: close <name>`. Parent-side work stays on the parent branch. | `completed` is written on close. Run `/fit git` after the parent work commit to record its hash as `commit`. |
| Separate repository | Put the board in its own Git repository, either outside the parent repo or nested with its own `.git`. | `fit_move` to `closed` writes `completed` and commits the board repository with `FIT: close <name>`. | `completed` is written on close. Run `/fit git` after the parent work commit to record its hash as `commit`. |

In the two non-inline modes, `/fit git` reads the latest commit from the parent
repository and records it on closed tickets without a hash. Inline boards skip
that step: `/fit git` reports that close moves belong to the parent work commit
and changes nothing.

### Recording commits for closed tickets

`/fit git` is for a fit-branch worktree or a separate board repository. It reads
the latest commit from the parent repository's current branch and adds it to
each closed ticket that does not already have a commit hash:

```yaml
completed: 2026-02-19T12:34:56.000Z
commit: 0123456789abcdef
```

`completed` is filled in by `fit_move` when the board is not inline. `commit`
is filled in later by `/fit git`, after the work commit exists. Existing keys
such as `commit_hash`, `git_commit`, or `hash` also count as recorded, so the
command is idempotent. It then commits the board, with a message derived from
the ticket names, for example `FIT: close fix-typo-in-readme`.

On an inline board `/fit git` is a no-op that explains the inline rule instead
of reporting a layout error.

## Development

```bash
npm install
npm run check     # tsc --noEmit + node --test
```

The core board logic (`src/fit.ts`) depends only on Node built-ins and is tested
without the Pi runtime. Supporting modules are deliberately small:

- `src/human.ts` — human-only fuzzy lookup
- `src/guard.ts` — write/edit/bash guard heuristics
- `src/config.ts` — review-mode and nogrill configuration parsing
- `src/conf.ts` — board `conf.toml` parsing and Git identity resolution
- `src/agents.ts` — managed `AGENTS.md` section
- `src/agent-spec.ts` — vendored `AGENT_SPEC.md` linked from that section
- `src/git.ts` — optional Git setup
- `src/index.ts` — Pi tool and command registration

## Notes on the FIT spec

This package implements FIT spec **v0.5**. Key rules the tools enforce:

- **Basic vs Strict.** No `STRICT` marker means Basic: all four status folders
  exist, but naming is permissive. A `STRICT` file containing a quoted version
  (for example `"0.5"`) opts in to Strict. The tools report the version they
  implement and apply known rules to unknown/newer versions.
- **Identity.** A Strict filename is `NN-short-name.md` with a two-digit
  priority from `00` to `99` (`00` first). The short name is the identity; it
  must be unique board-wide and is displayed in title case with `-` as spaces.
- **Length and characters.** Short names should stay under 30 characters.
  Filenames must be lowercase and safe on URL, Windows, macOS, and Linux;
  reserved Windows names and trailing dots are rejected in Strict mode.
- **Body.** Keep a 1-3 sentence summary, then put everything else under level-3
  (`###`) headers. A body outside that shape is an error in Strict mode.
- **Ordering.** Status order is `in_progress`, `open`, `backlog`, `closed`, then
  sub-status directory name ascending, then filename ascending, recursively.
- **Lifecycle.** Create in `open` or `backlog`; move the file to change status.
  `in_progress` holds at most one ticket per checkout. Close means move to
  `closed`.
- **Archive.** `fit_archive` appends a fenced record to `closed/archive.txt` and
  removes the closed ticket; `fit_restore` copies a record back to a status
  folder and removes it. Archived tickets are not actionable and are excluded
  from name uniqueness.
- **Spec copy.** `fit_init` places the spec at `fit/FIT_SPEC.md`, which the spec
  allows and `fit_list` ignores.
- **Agent spec.** `fit_init` also places the concise agent rules at
  `AGENT_SPEC.md` beside the board, so the link from the managed `AGENTS.md`
  section resolves. An existing copy is never overwritten.
- **AGENTS.md.** The managed section lives beside the board, delimited by
  `<!-- fit:begin -->` and `<!-- fit:end -->`. Content outside those markers is
  never modified.
- **Frontmatter is metadata.** Keys such as `status`, `priority`, `path`, and
  `id` are reported as structural warnings by `fit_check`; `completed`,
  `commit`, and `project` have validated formats.

## AI disclosure

See [AI_DISCLOSURE.md](./AI_DISCLOSURE.md).

## License

MIT. FIT itself is MIT-licensed by its authors.
