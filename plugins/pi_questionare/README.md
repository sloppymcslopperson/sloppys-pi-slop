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
