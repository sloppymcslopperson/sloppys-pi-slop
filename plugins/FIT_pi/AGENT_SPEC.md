# FIT agent spec

Self-contained rules for FIT boards. Source: upstream FIT_SPEC v0.5. `MUST` = required (violation → noncompliant), `SHOULD` = warning, `MAY` = optional. Unmentioned = allowed. A board failing BASIC is **freestyle**: agents MAY decline it.

## Mode

- `<board>/STRICT` exists → **STRICT**. Content = version string with quotes, e.g. `"0.5"`. Unknown version → warn, apply known rules, report the version you implement.
- Absent → **BASIC**. Enforce Basic only; do not assume Strict rules.
- STRICT ⇒ BASIC. Where they conflict, STRICT wins.

## Basic (always applies)

- Board dir: any name (`fit` recommended).
- Status dirs, sort order: `in_progress` `open` `backlog` `closed`. All four MUST exist.
- Extra top-level status dirs and sub-status dirs MAY exist at any depth. Full status = `/`-join of dirs between board and ticket file (e.g. `open/blocked`).
- Status dirs MAY contain non-`.md` files (e.g. `.gitkeep`, `archive.txt`).
- Ticket = any `.md` under a status dir at any depth. All such files are valid tickets.
- Tickets MAY be named anything; multiple tickets per status are allowed. Do not assume Strict naming, identity, or lifecycle rules.
- Ordering: status (order above) → sub-status dir name ascending → filename ascending, recursive (example: `"00" < "01" < "10" < "9" < "B" < "a"`).
- Frontmatter: optional, only at line 1: exact `---`, valid YAML block, exact `---`. Non-authoritative for status, priority, name, identity. Defined keys: `completed` (ISO-8601 date/datetime), `commit` (hash), `project` (name); other keys allowed.

## Strict (mode = STRICT only)

Strict overrides Basic; a strict board also satisfies Basic. Any `.md` is still a valid ticket; **compliant** = meets every rule here.

### Board

- Dir MUST be `fit`, at repo root or outside any repo.
- MUST NOT have extra top-level status dirs.
- Status dirs (incl. sub-statuses) MUST contain only `.md`, `.gitkeep`, `fit/closed/archive.txt`, and images linked from `.md`.
- `STRICT` and `archive.txt` are not tickets.

### Ticket

- Path-encoded properties:
  - **name**: filename minus `NN-` and `.md`; identity; MUST be unique in the board (archived excluded; report duplicates, user resolves); display SHOULD be title-case with `-` → space.
  - **priority**: `NN`, `00`–`99`; sort key, `00` first; changing it preserves identity.
  - **status**: parent dir path after `fit/` (e.g. `open/blocked`), i.e. the full status; deeper segments are sub-statuses.
- Filename MUST be `NN-<lowercase-name>.md` with a two-digit `NN`. Missing priority (`fix-bug.md`) = valid ticket, noncompliant name.
- Filename MUST avoid URL-illegal characters and be legal on Windows, macOS, and Linux.
- Short name SHOULD be <30 chars.
- Body: optional summary SHOULD be 1–3 sentences. Everything after the summary MUST be under level-3 (`### `) headers; each header = one concept.

### Lifecycle

- Create in `open` or `backlog`. Move the file to change status. Close = move to `closed`.
- `in_progress` MUST hold ≤1 ticket, counting sub-statuses. Limit is per branch/worktree.

### Archive (optional)

- Append to `closed/archive.txt`, then delete the ticket file. Record format:

````
### fit/<status>/<NN-name>.md
```
<exact ticket contents>
```
````

- Archived = non-actionable, not a ticket, excluded from name uniqueness.
- Restore: copy the fenced body into a new `.md` under a status dir, then remove the record.
- `archive.txt` MAY be moved out as backup; its absence is fine.

## Validate (in order)

1. Mode: `STRICT` content/version, else BASIC/freestyle.
2. Basic: four status dirs exist; all tickets are `.md` under a status dir.
3. Strict board: leaf `fit`; no extra top-level status dirs; status-dir whitelist.
4. Strict ticket: filename matches `^\d{2}-[a-z0-9-]+\.md$`; priority `00`–`99`; name unique; filename chars legal; short name <30 (warn); frontmatter delimiters, YAML, defined-key formats; post-summary content under `### ` headers.
5. Strict lifecycle: ≤1 `in_progress` ticket including sub-statuses.
6. Strict archive: records match header + fence; `archive.txt` is not a ticket.

MUST failure = noncompliant; SHOULD failure = warning. Never infer status, priority, name, or identity from frontmatter.
