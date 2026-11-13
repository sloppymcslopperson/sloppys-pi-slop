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
 */

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
}

const OTHER_CHOICE = "Type your own answer";
const DONE_CHOICE = "Done";
const NO_ANSWER = "(no answer)";

function tabLabel(question: Question, index: number): string {
	return question.label?.trim() || `Q${index + 1}`;
}

function answerLabel(question: Question): string {
	return question.label?.trim() || question.id;
}

function toDetails(questions: Question[], answers: Answer[], cancelled: boolean): QuestionnaireDetails {
	return { questions, answers, cancelled };
}

function errorResult(message: string, questions: Question[] = []) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true,
		details: toDetails(questions, [], true),
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

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more multiple-choice questions in a single tabbed questionnaire. " +
			"The user can switch between questions with left/right (or Tab), change earlier answers, and pick several " +
			"options when `multiple` is true. Every question always includes a free-form 'Type your own answer' row. " +
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

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return errorResult(
					"Error: the questionnaire tool requires an interactive TUI. Continue without asking the user and state your assumptions.",
					questions,
				);
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

			const lines = questions.map((question) => {
				const answer = result.answers.find((candidate) => candidate.id === question.id);
				return answerLine(question, answer);
			});

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: toDetails(questions, result.answers, false),
			};
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
