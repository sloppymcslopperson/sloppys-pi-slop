# @sloppymcslopperson/pi-questions

A tabbed multiple-choice questionnaire tool for [Pi](https://pi.dev).

The `questionnaire` tool asks one or more questions in a single TUI. Every
question always includes a free-form "Type your own answer" row. Multiple
questions end on a Submit tab that accepts partial answers.

Hosts without a usable questionnaire sheet fall back to their dialog methods
and ask the same questions one dialog at a time: a select per question, an
input for a typed answer, and a review step before submit. Hosts with neither a
sheet nor dialogs report an error result asking the model to fall back to
plain-text questions. Only an explicit cancel is reported as a user dismissal.

### Hosts that cannot collect typed text

The stock ACP adapter ([pi-acp](https://www.npmjs.com/package/pi-acp)) renders
`select` and `confirm` UI requests but cancels `input`/`editor` requests, so a
text prompt would end as a silent dismissal. The extension detects that adapter
by inspecting the parent process command line (Linux `/proc`) and, on those
hosts, offers the free-form row as **"Answer this in chat"** instead of a text
prompt. Selecting it returns a normal, non-error result that asks the model to
put the question in plain text, keeping any answers already collected; it is
never reported as a dismissal.

Multiple-select questions on those hosts also get **"Add an item in chat"**.
Picking it returns the items selected so far and asks the model to collect the
additional items in plain text, so a list can grow past the offered options
without a text-input dialog.

Set `PI_QUESTIONNAIRE_TYPED_TEXT=0` to force the chat hand-off, or `=1` to force
the text prompt (useful to test either behaviour on any host).

## Install

Install the package from this checkout:

```bash
pi install /path/to/pi_questionare
```

From a git URL, use the same `pi install` command with a `git:` source once the
repository has a remote.

Try the extension without installing it:

```bash
pi -e ./extensions/questionnaire.ts
```

After installing, start Pi and ask the model to use the `questionnaire` tool to
clarify a decision or gather preferences.

## Package layout

```text
package.json
extensions/
  questionnaire.ts
test/
  questionnaire.test.ts
```

`package.json` declares the package with the `pi-package` keyword and points
`pi.extensions` at `extensions/questionnaire.ts`.

## Development

```bash
npm install
npm run check
```

`npm run check` runs the TypeScript typecheck and the extension smoke test. The
host-provided packages (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, and `typebox`) are peer dependencies supplied by Pi.

## License

This is free and unencumbered software released into the public domain under
the [Unlicense](UNLICENSE).
