/**
 * Questionnaire tool
 *
 * Asks the user one or more multiple-choice questions in a single tabbed TUI.
 * Every question in the current call is visible in the tab row and reachable
 * with left/right (or Tab/Shift+Tab). Answers can be revisited and changed.
 * Multiple-select toggles are recorded as they happen; Done advances to the
 * next question (and can record an explicit Unanswered answer).
 *
 * A single question submits as soon as it is answered. Multi-question sessions
 * end on an explicit Submit tab, which accepts partial answers. Every question
 * always offers an inline "Type your own answer" row; there is no way for the
 * model to turn that off.
 *
 * Hosts without a terminal render the questions through their native
 * questionnaire sheet when one is available. Hosts that only expose the dialog
 * methods (RPC mode: select, input, confirm) ask the same questions one dialog
 * at a time. A host with neither reports an error result asking the model to
 * fall back to plain text; only an explicit cancel counts as a dismissal.
 *
 * The stock ACP adapter (pi-acp) shows selects but cannot collect free-form
 * text: it answers input/editor UI requests with a cancel. On those hosts the
 * free-form row becomes a selection, "Answer this in chat", which hands the
 * question back to the model instead of opening a dead-end text prompt.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned for this option" }),
	label: Type.String({ description: "Display text (1-5 words, concise)" }),
	description: Type.Optional(Type.String({ description: "Explanation of choice" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable unique identifier for this question" }),
	label: Type.Optional(
		Type.String({ description: "Short tab label, e.g. 'Scope' or 'Priority' (defaults to Q1, Q2, ...)" }),
	),
	prompt: Type.String({ description: "Complete question" }),
	options: Type.Array(OptionSchema, { description: "Available choices" }),
	multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask in this questionnaire" }),
});

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	multiple?: boolean;
}

interface Answer {
	id: string;
	/** Selected option values; empty for a custom-only answer or an empty Done. */
	selections: string[];
	/** Typed custom answers. */
	custom: string[];
	/** True when a single-select answer was typed rather than picked. */
	wasCustom: boolean;
}

interface Draft {
	selected: Set<string>;
	custom: string[];
}

interface QuestionnaireDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	/** Set when the questionnaire could not be shown or could not complete. */
	error?: string;
}

const OTHER_CHOICE = "Type your own answer";
/** Offered instead of the text prompt on hosts that cannot collect typed text. */
const CHAT_CHOICE = "Answer this in chat";
/** Multi-select only: hand the "add another item" job back to the model. */
const ADD_CHOICE = "Add an item in chat";
const DONE_CHOICE = "Done";
const NO_ANSWER = "(no answer)";

function tabLabel(question: Question, index: number): string {
	return question.label?.trim() || `Q${index + 1}`;
}

function answerLabel(question: Question): string {
	return question.label?.trim() || question.id;
}

function toDetails(
	questions: Question[],
	answers: Answer[],
	cancelled: boolean,
	error?: string,
): QuestionnaireDetails {
	return error === undefined ? { questions, answers, cancelled } : { questions, answers, cancelled, error };
}

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details: toDetails(questions, [], false, message),
	};
}

function answeredResult(questions: Question[], answers: Answer[]) {
	const lines = questions.map((question) => {
		const answer = answers.find((candidate) => candidate.id === question.id);
		return answerLine(question, answer);
	});

	return {
		content: [{ type: "text" as const, text: lines.join("\n") }],
		details: toDetails(questions, answers, false),
	};
}

/**
 * True when the host can collect free-form text through `ui.input`.
 *
 * pi-acp (the stock ACP adapter) renders `select`/`confirm` requests but cancels
 * `input`/`editor`, so offering a text prompt there ends in a silent dismissal.
 * The agent runs as a child of its adapter, so the parent command line is the
 * reliable local signal. `PI_QUESTIONNAIRE_TYPED_TEXT=0|1` overrides detection.
 */
function hostCollectsTypedText(): boolean {
	const forced = process.env.PI_QUESTIONNAIRE_TYPED_TEXT;
	if (forced === "0") return false;
	if (forced === "1") return true;

	let pid = process.pid;
	for (let depth = 0; depth < 3; depth += 1) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const ppid = Number.parseInt(fields[1] ?? "", 10);
			if (!Number.isFinite(ppid) || ppid <= 0) return true;
			if (/pi-acp/.test(readFileSync(`/proc/${ppid}/cmdline`, "utf8"))) return false;
			pid = ppid;
		} catch {
			// Not Linux, or /proc is unavailable: assume the host can ask for text.
			return true;
		}
	}

	return true;
}

function deferredResult(
	questions: Question[],
	answers: Answer[],
	ids: string[],
	adding?: { id: string; labels: string[] },
) {
	const labelOf = (id: string) => {
		const index = questions.findIndex((question) => question.id === id);
		return index >= 0 ? tabLabel(questions[index], index) : id;
	};
	const collected = questions
		.map((question) => answerLine(question, answers.find((answer) => answer.id === question.id)))
		.filter((line) => !line.endsWith(": Unanswered"));

	const text = [];
	if (adding) {
		const selected = adding.labels.length > 0 ? adding.labels.join(", ") : "nothing yet";
		text.push(
			`The user wants to add items to ${labelOf(adding.id)} that are not in the offered options. ` +
				`Already selected there: ${selected}. Ask them in plain text which additional items they want, ` +
				"then continue with their reply and keep the selections above. Do not treat this as a dismissal and do not re-ask it with this tool.",
		);
	} else {
		text.push(
			`The user chose to answer ${ids.map(labelOf).join(", ")} in their own words in chat, so no answer was captured for it. ` +
				"Ask that question in plain text in your next message and use their reply; do not treat this as a dismissal and do not re-ask it with this tool.",
		);
	}
	if (collected.length > 0) text.push("", "Already answered:", ...collected);

	return {
		content: [{ type: "text" as const, text: text.join("\n") }],
		details: toDetails(questions, answers, false),
	};
}

function cancelledResult(questions: Question[], answers: Answer[]) {
	return {
		content: [
			{
				type: "text" as const,
				text: "The user dismissed this questionnaire without submitting it. Do not continue with the current task: this means the user wants to clarify or pivot. Stop and wait for the user's next message.",
			},
		],
		details: toDetails(questions, answers, true),
	};
}

function validate(questions: Question[]): string | undefined {
	if (questions.length === 0) return "Error: no questions provided.";

	const ids = new Set<string>();
	for (const question of questions) {
		if (!question.id?.trim()) return "Error: a question is missing its id.";
		if (ids.has(question.id)) return `Error: duplicate question id "${question.id}".`;
		ids.add(question.id);

		if (!question.prompt?.trim()) return `Error: question "${question.id}" is missing its prompt.`;
		if (!Array.isArray(question.options) || question.options.length === 0) {
			return `Error: question "${question.id}" has no options.`;
		}

		const values = new Set<string>();
		for (const option of question.options) {
			if (!option.value?.trim()) {
				return `Error: question "${question.id}" has an option without a value.`;
			}
			if (!option.label?.trim()) {
				return `Error: question "${question.id}" has an option without a label.`;
			}
			if (values.has(option.value)) {
				return `Error: question "${question.id}" has duplicate option value "${option.value}".`;
			}
			values.add(option.value);
		}
	}

	return undefined;
}

function selectedLabels(question: Question, answer: Answer): string[] {
	return answer.selections.map((value) => {
		const index = question.options.findIndex((option) => option.value === value);
		return index >= 0 ? `${index + 1}. ${question.options[index].label}` : value;
	});
}

function answerLine(question: Question, answer: Answer | undefined): string {
	const label = answerLabel(question);
	if (!answer) return `${label}: Unanswered`;
	if (answer.wasCustom) return `${label}: user wrote: ${answer.custom[0] ?? NO_ANSWER}`;

	const parts: string[] = [];
	const picked = selectedLabels(question, answer);
	if (picked.length > 0) parts.push(`user selected: ${picked.join(", ")}`);
	if (answer.custom.length > 0) parts.push(`user wrote: ${answer.custom.join(", ")}`);
	if (parts.length === 0) return `${label}: Unanswered`;
	return `${label}: ${parts.join("; ")}`;
}

interface PanelHandle {
	post?: (data: unknown) => void;
	update?: (html: string) => void;
	close?: () => void;
	closed?: Promise<unknown>;
}

interface PanelOptions {
	html: string;
	title?: string;
	placement?: "sheet" | "widget";
	onMessage?: (data: unknown) => void;
}

interface DialogOptions {
	signal?: AbortSignal;
}

interface UiContext {
	ui: {
		panel?: (options: PanelOptions) => PanelHandle;
		select?: (title: string, options: string[], opts?: DialogOptions) => Promise<string | undefined>;
		input?: (title: string, placeholder?: string, opts?: DialogOptions) => Promise<string | undefined>;
	};
	signal?: AbortSignal;
}

/**
 * The app's native sheet: real tap targets instead of a key bar, and a proper
 * keyboard for the free-form row. The page owns the interaction and posts one
 * final message, so the extension's side stays small.
 */
function panelHtml(questions: Question[]): string {
	const data = JSON.stringify(questions).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root {
 color-scheme: light dark;
 --bg: #f2f2f7; --card: #ffffff; --text: #1c1c1e; --muted: #6e6e73;
 --tint: #0a84ff; --line: rgba(60, 60, 67, 0.16);
}
@media (prefers-color-scheme: dark) {
 :root { --bg: #000000; --card: #1c1c1e; --text: #f2f2f7; --muted: #98989f; --line: rgba(84, 84, 88, 0.45); }
}
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
 margin: 0; padding: 12px 12px calc(20px + env(safe-area-inset-bottom));
 background: var(--bg); color: var(--text);
 font: 16px/1.4 -apple-system, system-ui, sans-serif;
}
header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.title { flex: 1; font-size: 17px; font-weight: 600; }
#close { border: 0; background: none; color: var(--muted); font-size: 20px; padding: 6px 2px; cursor: pointer; }
#tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 10px; scrollbar-width: none; }
#tabs::-webkit-scrollbar { display: none; }
.tab {
 flex: none; border: 0; cursor: pointer; padding: 7px 13px; border-radius: 999px;
 background: var(--card); color: var(--muted); font: inherit; font-size: 14px;
}
.tab.on { background: var(--tint); color: #fff; }
.tab.done::after { content: " ✓"; }
.q { background: var(--card); border-radius: 14px; padding: 14px; }
.prompt { font-weight: 600; margin-bottom: 8px; }
.opt {
 display: flex; gap: 10px; align-items: flex-start; min-height: 44px;
 padding: 10px 0; border-top: 1px solid var(--line); cursor: pointer;
}
.opt:first-of-type { border-top: 0; }
.mark {
 flex: none; width: 22px; height: 22px; margin-top: 1px; border-radius: 11px;
 border: 2px solid var(--line); display: grid; place-items: center;
 font-size: 12px; line-height: 1; color: #fff;
}
.multi .mark { border-radius: 6px; }
.opt.sel .mark { background: var(--tint); border-color: var(--tint); }
.opt.sel .label { color: var(--tint); }
.body { flex: 1; }
.desc { color: var(--muted); font-size: 13px; }
input[type="text"] {
 width: 100%; min-height: 44px; margin-top: 10px; padding: 0 12px;
 border: 1px solid var(--line); border-radius: 10px;
 background: var(--bg); color: var(--text); font: inherit;
}
.row { display: flex; gap: 8px; margin-top: 10px; }
.btn {
 flex: 1; min-height: 44px; border: 0; border-radius: 12px; cursor: pointer;
 background: var(--tint); color: #fff; font: inherit; font-weight: 600;
}
.btn.ghost { background: transparent; color: var(--tint); border: 1px solid var(--tint); }
.chip {
 display: inline-flex; align-items: center; gap: 6px; margin: 10px 6px 0 0; padding: 7px 11px;
 border: 1px solid var(--line); border-radius: 999px; background: var(--bg);
 color: var(--text); font: inherit; font-size: 14px; cursor: pointer;
}
</style>
</head>
<body>
<header><div class="title">Questionnaire</div><button id="close" aria-label="Cancel">✕</button></header>
<nav id="tabs"></nav>
<main id="view"></main>
<script id="data" type="application/json">${data}</script>
<script>
(function () {
 var Q = JSON.parse(document.getElementById("data").textContent);
 var A = new Map();
 var cur = 0;
 var SUBMIT = Q.length;

 function tabName(q, i) {
 var label = (q.label || "").trim();
 return label || "Q" + (i + 1);
 }
 function h(tag, cls, text) {
 var e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text != null) e.textContent = text;
 return e;
 }
 function entry(q) {
 return A.get(q.id) || { id: q.id, selections: [], custom: [] };
 }
 function write(q, selections, custom) {
 A.set(q.id, { id: q.id, selections: selections.slice(), custom: custom.slice() });
 }

 function advance() {
 for (var step = 1; step <= Q.length; step++) {
 var idx = (cur + step) % Q.length;
 if (!A.has(Q[idx].id)) { cur = idx; draw(); return; }
 }
 cur = SUBMIT;
 draw();
 }

 // A single-question questionnaire submits the moment it is answered.
 function leave() {
 if (Q.length === 1) { done(); return; }
 advance();
 }

 function summary(q) {
 var a = A.get(q.id);
 if (!a) return "Unanswered";
 var parts = [];
 if (a.selections.length) {
 parts.push("selected: " + a.selections.map(function (value) {
 var idx = q.options.findIndex(function (o) { return o.value === value; });
 return idx >= 0 ? idx + 1 + ". " + q.options[idx].label : value;
 }).join(", "));
 }
 if (a.custom.length) parts.push("wrote: " + a.custom.join(", "));
 return parts.length ? parts.join("; ") : "Unanswered";
 }

 function questionView(q) {
 var card = h("div", "q" + (q.multiple ? " multi" : ""));
 card.appendChild(h("div", "prompt", q.prompt));
 var draft = entry(q);
 var picked = new Set(draft.selections);

 q.options.forEach(function (o) {
 var on = picked.has(o.value);
 var row = h("div", "opt" + (on ? " sel" : ""));
 row.appendChild(h("div", "mark", on ? "✓" : ""));
 var body = h("div", "body");
 body.appendChild(h("div", "label", o.label));
 if (o.description) body.appendChild(h("div", "desc", o.description));
 row.appendChild(body);
 row.onclick = function () {
 if (q.multiple) {
 if (picked.has(o.value)) picked.delete(o.value);
 else picked.add(o.value);
 write(q, Array.from(picked), entry(q).custom);
 draw();
 return;
 }
 write(q, [o.value], []);
 leave();
 };
 card.appendChild(row);
 });

 if (q.multiple) {
 draft.custom.forEach(function (text, idx) {
 var chip = h("button", "chip", text + " ✕");
 chip.onclick = function () {
 var a = entry(q);
 a.custom.splice(idx, 1);
 write(q, a.selections, a.custom);
 draw();
 };
 card.appendChild(chip);
 });
 }

 var input = document.createElement("input");
 input.type = "text";
 input.placeholder = "Type your own answer";
 input.autocapitalize = "sentences";
 card.appendChild(input);

 var row = h("div", "row");
 var add = h("button", "btn", q.multiple ? "Add answer" : "Use this answer");
 add.onclick = function () {
 var text = (input.value || "").trim();
 if (!text) return;
 var a = entry(q);
 if (q.multiple) {
 a.custom.push(text);
 write(q, a.selections, a.custom);
 draw();
 return;
 }
 write(q, [], [text]);
 leave();
 };
 // Return does what the button does, so a typed answer does not need a tap.
 input.addEventListener("keydown", function (event) {
 if (event.key !== "Enter" || event.isComposing) return;
 event.preventDefault();
 add.onclick();
 });
 row.appendChild(add);
 if (q.multiple) {
 var doneBtn = h("button", "btn ghost", "Done");
 doneBtn.onclick = function () {
 var a = entry(q);
 // Done is explicit: an empty selection still records an answer.
 write(q, a.selections, a.custom);
 advance();
 };
 row.appendChild(doneBtn);
 }
 card.appendChild(row);
 return card;
 }

 function submitView() {
 var card = h("div", "q");
 card.appendChild(h("div", "prompt", "Ready to submit"));
 Q.forEach(function (q, i) {
 var row = h("div", "opt");
 var body = h("div", "body");
 body.appendChild(h("div", "label", tabName(q, i)));
 body.appendChild(h("div", "desc", summary(q)));
 row.appendChild(body);
 row.onclick = function () { cur = i; draw(); };
 card.appendChild(row);
 });
 var row = h("div", "row");
 var submit = h("button", "btn", "Submit");
 submit.onclick = done;
 row.appendChild(submit);
 var cancel = h("button", "btn ghost", "Cancel");
 cancel.onclick = bail;
 row.appendChild(cancel);
 card.appendChild(row);
 return card;
 }

 function draw() {
 var nav = document.getElementById("tabs");
 nav.textContent = "";
 Q.forEach(function (q, i) {
 var tab = h("button", "tab" + (i === cur ? " on" : "") + (A.has(q.id) ? " done" : ""), tabName(q, i));
 tab.onclick = function () { cur = i; draw(); };
 nav.appendChild(tab);
 });
 var last = h("button", "tab" + (cur === SUBMIT ? " on" : ""), "Submit");
 last.onclick = function () { cur = SUBMIT; draw(); };
 nav.appendChild(last);

 var view = document.getElementById("view");
 view.textContent = "";
 view.appendChild(cur === SUBMIT ? submitView() : questionView(Q[cur]));
 }

 function deliver(payload) {
 try { pi.close(payload); } catch (e) {}
 try { pi.post(payload); } catch (e) {}
 }

 function done() {
 var answers = [];
 Q.forEach(function (q) {
 var a = A.get(q.id);
 if (a && (a.selections.length || a.custom.length)) {
 answers.push({ id: q.id, selections: a.selections, custom: a.custom });
 }
 });
 deliver({ type: "submit", answers: answers });
 }

 function bail() { deliver({ type: "cancel" }); }

 document.getElementById("close").onclick = bail;
 draw();
})();
</script>
</body>
</html>`;
}

/** Keep only answers the questions actually define, in the model's own shape. */
function normaliseAnswers(questions: Question[], raw: unknown): Answer[] {
	const found = new Map<string, Answer>();
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const candidate = entry as { id?: unknown; selections?: unknown; custom?: unknown };
			const question = questions.find((item) => item.id === candidate.id);
			if (!question) continue;

			const allowed = new Set(question.options.map((option) => option.value));
			const selections = Array.isArray(candidate.selections)
				? candidate.selections.filter(
						(value): value is string => typeof value === "string" && allowed.has(value),
					)
				: [];
			const custom = Array.isArray(candidate.custom)
				? candidate.custom.filter((value): value is string => typeof value === "string")
				: [];
			if (selections.length === 0 && custom.length === 0) continue;

			found.set(question.id, {
				id: question.id,
				selections,
				custom,
				wasCustom: !question.multiple && selections.length === 0 && custom.length > 0,
			});
		}
	}

	return questions.flatMap((question) => {
		const answer = found.get(question.id);
		return answer ? [answer] : [];
	});
}

/**
 * How a panel attempt ended. "unavailable" and "lost" are failures to show the
 * sheet, not user decisions, so they must never be reported as a cancellation.
 */
type PanelResult =
	| { kind: "answered"; answers: Answer[] }
	| { kind: "cancelled"; answers: Answer[] }
	| { kind: "deferred"; answers: Answer[]; ids: string[]; adding?: { id: string; labels: string[] } }
	| { kind: "unavailable" }
	| { kind: "lost" };

/** Ask through the app's native sheet and wait for one final message or a dismissal. */
async function askWithPanel(ctx: UiContext, questions: Question[]): Promise<PanelResult> {
	const panel = ctx.ui?.panel;
	if (typeof panel !== "function") return { kind: "unavailable" };

	return await new Promise<PanelResult>((resolve) => {
		let settled = false;
		let handle: PanelHandle | undefined;

		const finish = (result: PanelResult) => {
			if (settled) return;
			settled = true;
			if (ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
			resolve(result);
		};

		const decode = (data: unknown): PanelResult | null => {
			if (!data || typeof data !== "object") return null;
			const message = data as { type?: unknown; answers?: unknown };
			if (message.type === "cancel") return { kind: "cancelled", answers: [] };
			if (message.type === "submit") {
				return { kind: "answered", answers: normaliseAnswers(questions, message.answers) };
			}
			return null;
		};

		function onAbort() {
			try {
				handle?.close?.();
			} catch {
				// the sheet is already gone
			}
			finish({ kind: "cancelled", answers: [] });
		}

		try {
			handle = panel({
				title: "Questionnaire",
				placement: "sheet",
				html: panelHtml(questions),
				onMessage: (data) => {
					const result = decode(data);
					if (!result) return;
					try {
						handle?.close?.();
					} catch {
						// already closed by the page
					}
					finish(result);
				},
			});
		} catch {
			finish({ kind: "unavailable" });
			return;
		}

		// A sheet that goes away without posting submit/cancel was never answered:
		// report it as lost so the agent falls back to plain text instead of
		// believing the user dismissed the questions.
		const closed = handle?.closed;
		if (closed && typeof (closed as Promise<unknown>).then === "function") {
			(closed as Promise<unknown>).then(
				(message) => finish(decode(message) ?? { kind: "lost" }),
				() => finish({ kind: "lost" }),
			);
		}

		if (ctx.signal) {
			if (ctx.signal.aborted) {
				onAbort();
				return;
			}
			ctx.signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

const SUBMIT_CHOICE = "Submit answers";
const CANCEL_CHOICE = "Cancel";

function dialogOptions(ctx: UiContext): DialogOptions | undefined {
	return ctx.signal ? { signal: ctx.signal } : undefined;
}

/**
 * Fallback for hosts that have no panel API but do support the dialog methods
 * (RPC mode, for example). Same questions, asked one dialog at a time: a select
 * per question, an input for a typed answer, and a review step before submit.
 */
async function askWithDialogs(ctx: UiContext, questions: Question[]): Promise<PanelResult> {
	const ui = ctx.ui;
	if (typeof ui.select !== "function") return { kind: "unavailable" };
	const select = ui.select.bind(ui);
	const typing = hostCollectsTypedText();
	const input = typing && typeof ui.input === "function" ? ui.input.bind(ui) : undefined;

	const opts = dialogOptions(ctx);
	const answers = new Map<string, Answer>();

	/** Ask one question until it has an answer, or the user backs out. */
	async function askQuestion(
		question: Question,
		index: number,
	): Promise<
		| { outcome: "answered" }
		| { outcome: "cancelled" }
		| { outcome: "deferred" }
		| { outcome: "add-items"; labels: string[] }
	> {
		const draft: Draft = { selected: new Set(), custom: [] };
		const title = questions.length > 1
			? `${tabLabel(question, index)} (${index + 1}/${questions.length}): ${question.prompt}`
			: question.prompt;

		for (;;) {
			const lookup = new Map<string, string>();
			const options: string[] = [];

			question.options.forEach((option, optionIndex) => {
				const mark = question.multiple ? (draft.selected.has(option.value) ? "[x] " : "[ ] ") : "";
				const label = `${mark}${optionIndex + 1}. ${option.label}`;
				lookup.set(label, option.value);
				options.push(label);
			});
			options.push(typing ? OTHER_CHOICE : CHAT_CHOICE);
			if (question.multiple) options.push(DONE_CHOICE);
			// A host without text entry cannot add an option by typing, so offer the
			// job to the model instead, carrying what is already selected.
			if (question.multiple && !typing) options.push(ADD_CHOICE);

			const choice = await select(title, options, opts);
			if (choice === undefined || choice === CANCEL_CHOICE) return { outcome: "cancelled" };
			if (!typing && choice === CHAT_CHOICE) return { outcome: "deferred" };
			if (!typing && choice === ADD_CHOICE) {
				const labels = question.options
					.filter((option) => draft.selected.has(option.value))
					.map((option) => option.label);
				return { outcome: "add-items", labels };
			}

			if (choice === DONE_CHOICE) {
				// Done is explicit: an empty selection still records an answer.
				answers.set(question.id, {
					id: question.id,
					selections: [...draft.selected],
					custom: [...draft.custom],
					wasCustom: false,
				});
				return { outcome: "answered" };
			}

			if (choice === OTHER_CHOICE) {
				const typed = input ? await input("Type your own answer", "type something...", opts) : undefined;
				if (typed === undefined) return { outcome: "cancelled" };
				const text = typed.trim();
				if (!text) continue;
				if (question.multiple) {
					draft.custom.push(text);
					continue;
				}
				answers.set(question.id, {
					id: question.id,
					selections: [],
					custom: [text],
					wasCustom: true,
				});
				return { outcome: "answered" };
			}

			const value = lookup.get(choice);
			if (value === undefined) continue; // an unknown reply is not an answer

			if (question.multiple) {
				if (draft.selected.has(value)) draft.selected.delete(value);
				else draft.selected.add(value);
				continue;
			}

			answers.set(question.id, {
				id: question.id,
				selections: [value],
				custom: [],
				wasCustom: false,
			});
			return { outcome: "answered" };
		}
	}

	for (const [index, question] of questions.entries()) {
		const outcome = await askQuestion(question, index);
		if (outcome.outcome === "cancelled") return { kind: "cancelled", answers: [...answers.values()] };
		if (outcome.outcome === "deferred") {
			return { kind: "deferred", answers: [...answers.values()], ids: [question.id] };
		}
		if (outcome.outcome === "add-items") {
			return {
				kind: "deferred",
				answers: [...answers.values()],
				ids: [question.id],
				adding: { id: question.id, labels: outcome.labels },
			};
		}
	}

	// A single question is done once it has an answer, matching the sheet and TUI.
	if (questions.length === 1) return { kind: "answered", answers: [...answers.values()] };

	// Review: the user can still revisit a question before the answers are final.
	for (;;) {
		const lookup = new Map<string, number>();
		const options: string[] = [];
		questions.forEach((question, index) => {
			const label = `Review ${tabLabel(question, index)}: ${answerLine(question, answers.get(question.id))}`;
			lookup.set(label, index);
			options.push(label);
		});
		options.push(SUBMIT_CHOICE, CANCEL_CHOICE);

		const choice = await select("Ready to submit", options, opts);
		if (choice === undefined || choice === CANCEL_CHOICE) {
			return { kind: "cancelled", answers: [...answers.values()] };
		}
		if (choice === SUBMIT_CHOICE) return { kind: "answered", answers: [...answers.values()] };

		const target = lookup.get(choice);
		if (target === undefined) continue;
		const outcome = await askQuestion(questions[target], target);
		if (outcome.outcome === "cancelled") return { kind: "cancelled", answers: [...answers.values()] };
		if (outcome.outcome === "deferred") {
			return { kind: "deferred", answers: [...answers.values()], ids: [questions[target].id] };
		}
		if (outcome.outcome === "add-items") {
			return {
				kind: "deferred",
				answers: [...answers.values()],
				ids: [questions[target].id],
				adding: { id: questions[target].id, labels: outcome.labels },
			};
		}
	}
}

/** Ask through the app's native sheet, turning an unusable host into an error result. */
async function askWithPanelOrFail(ctx: UiContext, questions: Question[]) {
	let result = await askWithPanel(ctx, questions);
	// A host may offer dialogs without a panel (RPC mode does); those can still ask.
	if (result.kind === "unavailable") result = await askWithDialogs(ctx, questions);

	switch (result.kind) {
		case "answered":
			return answeredResult(questions, result.answers);
		case "cancelled":
			return cancelledResult(questions, result.answers);
		case "unavailable":
			return errorResult(
				"Error: this host cannot display the questionnaire sheet, so the user was not asked anything. Do not treat this as a dismissal: ask the questions in plain text instead and state your assumptions.",
				questions,
			);
		case "deferred":
			return deferredResult(questions, result.answers, result.ids, result.adding);
		case "lost":
			return errorResult(
				"Error: the questionnaire sheet closed before the user answered, so no answers were recorded. Do not treat this as a dismissal: ask the questions in plain text instead.",
				questions,
			);
	}
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more multiple-choice questions in a single tabbed questionnaire. " +
			"The user can switch between questions with left/right (or Tab), change earlier answers, and pick several " +
			"options when `multiple` is true. Every question always includes a free-form 'Type your own answer' row. " +
			"On hosts that cannot collect typed text (the stock ACP adapter, pi-acp), that row is offered as " +
			"'Answer this in chat' and the tool returns without an answer: ask that question in plain text instead. " +
			"Multiple-select questions there also offer 'Add an item in chat', which returns the current selections " +
			"and asks you to collect the extra items in plain text. " +
			"Use `id` as the stable key, `value` as the machine-readable answer, `label` as the short tab text, and " +
			"`prompt` as the full question. A single question submits as soon as it is answered; multiple questions end " +
			"on a Submit tab that accepts partial answers. Unanswered questions are reported as Unanswered.\n\n" +
			"Usage notes:\n" +
			"- `id` and option `value` are required and must be unique; do not add your own free-form option.\n" +
			'- If you recommend a specific option, make that the first option and add "(Recommended)" at the end of its label',
		promptGuidelines: [
			"Use the questionnaire tool to clarify ambiguity or gather preferences instead of guessing, but do not interrupt the user for things you can determine yourself.",
		],
		parameters: QuestionnaireParams,
		executionMode: "sequential",
		exposure: "model-only",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = (params.questions ?? []) as Question[];
			const problem = validate(questions);
			if (problem) return errorResult(problem, questions);

			if (!ctx.hasUI) {
				return errorResult(
					"Error: the questionnaire tool requires an interactive UI. Ask the questions in plain text instead and state your assumptions.",
					questions,
				);
			}

			if (ctx.mode !== "tui") {
				return await askWithPanelOrFail(ctx as unknown as UiContext, questions);
			}

			const isMulti = questions.length > 1;
			const answers = new Map<string, Answer>();

			const result = await ctx.ui.custom<{ answers: Answer[]; cancelled: boolean } | null>(
				(tui, theme, _keybindings, done) => {
					const submitTab = questions.length;
					let currentTab = 0;
					let optionIndex = 0;
					let inputMode = false;
					let cachedLines: string[] | undefined;
					const drafts = new Map<string, Draft>();

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function orderedAnswers(): Answer[] {
						return questions.flatMap((question) => {
							const answer = answers.get(question.id);
							return answer ? [answer] : [];
						});
					}

					function finish(cancelled: boolean) {
						done({ answers: orderedAnswers(), cancelled });
					}

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function currentQuestion(): Question | undefined {
						return currentTab < questions.length ? questions[currentTab] : undefined;
					}

					function getDraft(question: Question): Draft {
						let draft = drafts.get(question.id);
						if (!draft) {
							const answer = answers.get(question.id);
							draft = {
								selected: new Set(answer?.selections ?? []),
								custom: [...(answer?.custom ?? [])],
							};
							drafts.set(question.id, draft);
						}
						return draft;
					}

					function optionCount(question: Question): number {
						return question.multiple
							? question.options.length + getDraft(question).custom.length + 2
							: question.options.length + 1;
					}

					function allAnswered(): boolean {
						return questions.every((question) => answers.has(question.id));
					}

					function moveTab(direction: 1 | -1) {
						if (!isMulti) return;
						const total = questions.length + 1;
						currentTab = (currentTab + direction + total) % total;
						optionIndex = 0;
						refresh();
					}

					function advanceAfterAnswer() {
						if (!isMulti) {
							finish(false);
							return;
						}

						for (let step = 1; step <= questions.length; step++) {
							const index = (currentTab + step) % questions.length;
							if (!answers.has(questions[index].id)) {
								currentTab = index;
								optionIndex = 0;
								refresh();
								return;
							}
						}

						currentTab = submitTab;
						optionIndex = 0;
						refresh();
					}

					function commitSingle(question: Question, value: string) {
						answers.set(question.id, { id: question.id, selections: [value], custom: [], wasCustom: false });
						advanceAfterAnswer();
					}

					function commitSingleCustom(question: Question, text: string) {
						answers.set(question.id, { id: question.id, selections: [], custom: [text], wasCustom: true });
						advanceAfterAnswer();
					}

					function recordMultiDraft(question: Question, allowEmpty: boolean) {
						const draft = getDraft(question);
						const empty = draft.selected.size === 0 && draft.custom.length === 0;

						if (empty && !allowEmpty) {
							answers.delete(question.id);
							return;
						}

						answers.set(question.id, {
							id: question.id,
							selections: question.options
								.filter((option) => draft.selected.has(option.value))
								.map((option) => option.value),
							custom: [...draft.custom],
							wasCustom: false,
						});
					}

					function syncMultiDraft(question: Question) {
						recordMultiDraft(question, false);
					}

					function commitMulti(question: Question) {
						// Done is explicit: even an empty selection records an Unanswered answer.
						recordMultiDraft(question, true);
						advanceAfterAnswer();
					}

					function saveSingleChoice(question: Question) {
						const option = question.options[optionIndex];
						if (option) {
							commitSingle(question, option.value);
							return;
						}
						inputMode = true;
						editor.setText("");
						refresh();
					}

					function saveMultiChoice(question: Question) {
						const draft = getDraft(question);
						const customStart = question.options.length;
						const customEnd = customStart + draft.custom.length;

						if (optionIndex < customStart) {
							const option = question.options[optionIndex];
							if (draft.selected.has(option.value)) draft.selected.delete(option.value);
							else draft.selected.add(option.value);
							syncMultiDraft(question);
							refresh();
							return;
						}

						if (optionIndex < customEnd) {
							draft.custom.splice(optionIndex - customStart, 1);
							optionIndex = Math.min(optionIndex, optionCount(question) - 1);
							syncMultiDraft(question);
							refresh();
							return;
						}

						if (optionIndex === customEnd) {
							inputMode = true;
							editor.setText("");
							refresh();
							return;
						}

						commitMulti(question);
					}

					editor.onSubmit = (value) => {
						const question = currentQuestion();
						if (!question || !inputMode) return;

						const text = value.trim() || NO_ANSWER;
						inputMode = false;
						editor.setText("");

						if (question.multiple) {
							const draft = getDraft(question);
							if (!draft.custom.includes(text)) draft.custom.push(text);
							optionIndex = Math.min(optionCount(question) - 1, question.options.length + draft.custom.length + 1);
							syncMultiDraft(question);
							refresh();
							return;
						}

						commitSingleCustom(question, text);
					};

					function handleInput(data: string) {
						if (inputMode) {
							if (matchesKey(data, Key.escape)) {
								inputMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (isMulti) {
							if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
								moveTab(-1);
								return;
							}
							if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
								moveTab(1);
								return;
							}
						}

						if (currentTab === submitTab) {
							if (matchesKey(data, Key.enter)) finish(false);
							else if (matchesKey(data, Key.escape)) finish(true);
							return;
						}

						const question = currentQuestion();
						if (!question) return;

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(optionCount(question) - 1, optionIndex + 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							if (question.multiple) saveMultiChoice(question);
							else saveSingleChoice(question);
							return;
						}
						if (matchesKey(data, Key.escape)) finish(true);
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const prefixWidth = visibleWidth(prefix);
							if (prefixWidth >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
							const continuationPrefix = " ".repeat(prefixWidth);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
							}
						}

						function renderTabs() {
							const tabs: string[] = ["← "];
							for (let index = 0; index < questions.length; index++) {
								const answered = answers.has(questions[index].id);
								const text = ` ${answered ? "■" : "□"} ${tabLabel(questions[index], index)} `;
								const styled =
									index === currentTab
										? theme.bg("selectedBg", theme.fg("text", text))
										: theme.fg(answered ? "success" : "muted", text);
								tabs.push(`${styled} `);
							}
							const submitText = " ✓ Submit ";
							const submitStyled =
								currentTab === submitTab
									? theme.bg("selectedBg", theme.fg("text", submitText))
									: theme.fg("success", submitText);
							tabs.push(`${submitStyled} →`);
							addWrappedWithPrefix(" ", tabs.join(""));
						}

						function renderOptions(question: Question) {
							const draft = question.multiple ? getDraft(question) : undefined;
							const custom = draft?.custom ?? [];

							for (let index = 0; index < question.options.length; index++) {
								const option = question.options[index];
								const selected = index === optionIndex;
								const checked = draft?.selected.has(option.value) === true;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const checkbox = draft ? `[${checked ? "x" : " "}] ` : "";
								const color = selected || checked ? "accent" : "text";
								addWrappedWithPrefix(prefix, theme.fg(color, `${index + 1}. ${checkbox}${option.label}`));
								if (option.description) {
									addWrappedWithPrefix("     ", theme.fg("muted", option.description));
								}
							}

							for (let index = 0; index < custom.length; index++) {
								const row = question.options.length + index;
								const selected = row === optionIndex;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								addWrappedWithPrefix(
									prefix,
									theme.fg(selected ? "accent" : "text", `${row + 1}. [x] ${custom[index]}`),
								);
							}

							const addRow = question.options.length + custom.length;
							const addSelected = addRow === optionIndex;
							addWrappedWithPrefix(
								addSelected ? theme.fg("accent", "> ") : "  ",
								theme.fg(
									addSelected || inputMode ? "accent" : "text",
									`${addRow + 1}. ${OTHER_CHOICE}${inputMode ? " ✎" : ""}`,
								),
							);

							if (draft) {
								const doneRow = addRow + 1;
								const doneSelected = doneRow === optionIndex;
								addWrappedWithPrefix(
									doneSelected ? theme.fg("accent", "> ") : "  ",
									theme.fg(
										doneSelected ? "accent" : "text",
										`${doneRow + 1}. ${DONE_CHOICE}`,
									),
								);
							}
						}

						function renderSubmit() {
							addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
							lines.push("");
							for (let index = 0; index < questions.length; index++) {
								const answer = answers.get(questions[index].id);
								addWrappedWithPrefix(
									" ",
									theme.fg(answer ? "text" : "warning", answerLine(questions[index], answer)),
								);
							}
							lines.push("");
							if (allAnswered()) {
								addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
							} else {
								const missing = questions
									.map((question, index) => ({ question, index }))
									.filter(({ question }) => !answers.has(question.id))
									.map(({ question, index }) => tabLabel(question, index))
									.join(", ");
								addWrappedWithPrefix(
									" ",
									theme.fg("warning", `Unanswered: ${missing} • Enter submits anyway`),
								);
							}
							addWrappedWithPrefix(" ", theme.fg("dim", "←→ / Tab switch • Enter submit • Esc cancel"));
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						if (isMulti) {
							renderTabs();
							lines.push("");
						}

						const question = currentQuestion();

						if (currentTab === submitTab) {
							renderSubmit();
						} else if (question && inputMode) {
							addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
							lines.push("");
							renderOptions(question);
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
						} else if (question) {
							addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
							lines.push("");
							renderOptions(question);
							lines.push("");
							addWrappedWithPrefix(
								" ",
								theme.fg(
									"dim",
									isMulti
										? "←→ / Tab switch • ↑↓ move • Enter select • Esc cancel"
										: "↑↓ move • Enter select • Esc cancel",
								),
							);
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			if (!result || result.cancelled) {
				return cancelledResult(questions, result?.answers ?? []);
			}

			return answeredResult(questions, result.answers);
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? (args.questions as Question[]) : [];
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (questions.length > 0) {
				const labels = questions.map((question, index) => tabLabel(question, index)).join(", ");
				text += theme.fg("dim", ` (${labels})`);
				text += theme.fg("muted", ` — ${questions[0].prompt ?? ""}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("warning", details.error), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.questions.map((question) => {
				const answer = details.answers.find((candidate) => candidate.id === question.id);
				return (
					(answer ? theme.fg("success", "✓ ") : theme.fg("warning", "! ")) +
					theme.fg("muted", answerLine(question, answer))
				);
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
