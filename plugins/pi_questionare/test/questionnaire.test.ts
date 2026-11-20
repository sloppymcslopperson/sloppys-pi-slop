import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import questionnaire from "../extensions/questionnaire.ts";

interface RegisteredTool {
	name?: string;
	executionMode?: string;
	exposure?: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<ToolResult>;
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { cancelled?: boolean; error?: string; answers?: unknown[] };
}

interface PanelHandle {
	close?: () => void;
	closed?: Promise<unknown>;
}

function registeredTool(): RegisteredTool {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	questionnaire(pi);
	assert.equal(tools.length, 1);
	return tools[0];
}

const questions = [
	{
		id: "scope",
		label: "Scope",
		prompt: "Which scope?",
		options: [
			{ value: "small", label: "Small" },
			{ value: "large", label: "Large" },
		],
	},
];

function run(ctx: unknown): Promise<ToolResult> {
	return registeredTool().execute("call", { questions }, undefined, undefined, ctx);
}

function text(result: ToolResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function assertNotDismissed(result: ToolResult) {
	assert.equal(result.isError, true);
	assert.equal(result.details?.cancelled, false);
	assert.doesNotMatch(text(result), /dismissed/i);
	assert.match(text(result), /plain text/i);
}

test("exports a Pi extension function", () => {
	assert.equal(typeof questionnaire, "function");
});

test("registers the questionnaire tool", () => {
	const tool = registeredTool();
	assert.equal(tool.name, "questionnaire");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.exposure, "model-only");
});

test("reports a missing panel API as an error, not a dismissal", async () => {
	const result = await run({ hasUI: true, mode: "rpc", ui: {} });
	assertNotDismissed(result);
	assert.match(result.details?.error ?? "", /cannot display/i);
});

test("a panel that closes without a message is not reported as a dismissal", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () => ({ closed: Promise.resolve(undefined) }) as PanelHandle,
		},
	});
	assertNotDismissed(result);
	assert.match(result.details?.error ?? "", /before the user answered/i);
});

test("a panel that closes with an unrelated message is not reported as a dismissal", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () => ({ closed: Promise.resolve({ type: "dismiss" }) }) as PanelHandle,
		},
	});
	assertNotDismissed(result);
});

test("a panel that throws is reported as unavailable", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () => {
				throw new Error("no sheet here");
			},
		},
	});
	assertNotDismissed(result);
	assert.match(result.details?.error ?? "", /cannot display/i);
});

test("an explicit cancel from the panel is still a dismissal", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () => ({ closed: Promise.resolve({ type: "cancel" }) }) as PanelHandle,
		},
	});
	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, true);
	assert.match(text(result), /dismissed/i);
});

test("answers posted by the panel are returned as selections", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () =>
				({
					closed: Promise.resolve({
						type: "submit",
						answers: [{ id: "scope", selections: ["large"], custom: [] }],
					}),
				}) as PanelHandle,
		},
	});
	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, false);
	assert.match(text(result), /Scope: user selected: 2\. Large/);
});

test("submit with an unknown question id records nothing", async () => {
	const result = await run({
		hasUI: true,
		mode: "rpc",
		ui: {
			panel: () =>
				({
					closed: Promise.resolve({
						type: "submit",
						answers: [{ id: "other", selections: ["large"], custom: [] }],
					}),
				}) as PanelHandle,
		},
	});
	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: Unanswered/);
});

interface DialogReply {
	select?: Array<string | undefined>;
	input?: Array<string | undefined>;
	confirm?: boolean[];
}

/** A host with only the dialog methods: what RPC mode actually offers. */
function dialogHost(replies: DialogReply) {
	const seen: typeof replies = { select: [], input: [], confirm: [] };
	const next = <T>(queue: T[] | undefined): T | undefined => queue?.shift();
	return {
		seen,
		ctx: {
			hasUI: true,
			mode: "rpc",
			ui: {
				async select(_title: string, options: string[]) {
					const reply = next(replies.select);
					seen.select?.push(reply);
					if (reply === undefined) return undefined;
					// Fail loudly if a scripted reply is not an offered row.
					assert.ok(options.includes(reply), `"${reply}" is not one of: ${options.join(" | ")}`);
					return reply;
				},
				async input() {
					const reply = next(replies.input);
					seen.input?.push(reply);
					return reply;
				},
				async confirm() {
					const reply = next(replies.confirm) ?? false;
					seen.confirm?.push(reply);
					return reply;
				},
			},
		},
	};
}

test("a dialog-only host can answer a single question with a selection", async () => {
	const host = dialogHost({ select: ["2. Large"] });
	const result = await run(host.ctx);
	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, false);
	assert.match(text(result), /Scope: user selected: 2\. Large/);
});

test("a dialog-only host can answer a single question by typing", async () => {
	const host = dialogHost({ select: ["Type your own answer"], input: ["A medium one"] });
	const result = await run(host.ctx);
	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: user wrote: A medium one/);
});

test("an empty typed answer re-asks instead of recording nothing", async () => {
	const host = dialogHost({
		select: ["Type your own answer", "1. Small"],
		input: ["   "],
	});
	const result = await run(host.ctx);
	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: user selected: 1\. Small/);
});

test("dismissing a dialog is a dismissal, not an unavailable host", async () => {
	const host = dialogHost({ select: [undefined] });
	const result = await run(host.ctx);
	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, true);
	assert.match(text(result), /dismissed/i);
});

test("a dialog-only host can toggle several answers and finish with Done", async () => {
	const host = dialogHost({
		select: ["[ ] 1. Small", "[x] 1. Small", "[ ] 1. Small", "[ ] 2. Large", "Done"],
	});
	const multi = [
		{
			id: "scope",
			label: "Scope",
			prompt: "Which scopes?",
			multiple: true,
			options: [
				{ value: "small", label: "Small" },
				{ value: "large", label: "Large" },
			],
		},
	];
	const result = await registeredTool().execute("call", { questions: multi }, undefined, undefined, host.ctx);
	assert.notEqual(result.isError, true);
	assert.match(text(result), /1\. Small, 2\. Large/);
});

test("a multi-question dialog host can review and submit", async () => {
	const two = [
		{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "small", label: "Small" }] },
		{ id: "speed", label: "Speed", prompt: "How fast?", options: [{ value: "fast", label: "Fast" }] },
	];
	const host = dialogHost({
		select: ["1. Small", "1. Fast", "Submit answers"],
	});
	const result = await registeredTool().execute("call", { questions: two }, undefined, undefined, host.ctx);
	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: user selected: 1\. Small/);
	assert.match(text(result), /Speed: user selected: 1\. Fast/);
	assert.equal(host.seen.select?.length, 3);
});

test("a multi-question dialog host can revisit a question before submitting", async () => {
	const two = [
		{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }] },
		{ id: "speed", label: "Speed", prompt: "How fast?", options: [{ value: "fast", label: "Fast" }] },
	];
	const host = dialogHost({
		select: [
			"1. Small",
			"1. Fast",
			"Review Scope: Scope: user selected: 1. Small",
			"2. Large",
			"Submit answers",
		],
	});
	const result = await registeredTool().execute("call", { questions: two }, undefined, undefined, host.ctx);
	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: user selected: 2\. Large/);
});

test("cancelling the review step is a dismissal that keeps the answers", async () => {
	const two = [
		{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "small", label: "Small" }] },
		{ id: "speed", label: "Speed", prompt: "How fast?", options: [{ value: "fast", label: "Fast" }] },
	];
	const host = dialogHost({ select: ["1. Small", "1. Fast", "Cancel"] });
	const result = await registeredTool().execute("call", { questions: two }, undefined, undefined, host.ctx);
	assert.equal(result.details?.cancelled, true);
	assert.match(text(result), /dismissed/i);
});

/** Run with the typed-text capability pinned, the way pi-acp's env detection reads it. */
async function withTypedText<T>(value: "0" | "1", fn: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_QUESTIONNAIRE_TYPED_TEXT;
	process.env.PI_QUESTIONNAIRE_TYPED_TEXT = value;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PI_QUESTIONNAIRE_TYPED_TEXT;
		else process.env.PI_QUESTIONNAIRE_TYPED_TEXT = previous;
	}
}

test("a host that cannot type is offered 'Answer this in chat' instead of a dead-end prompt", async () => {
	// pi-acp cancels input/editor UI requests, so a text prompt here would end as
	// a silent dismissal. The row becomes a selection that hands back to the model.
	const host = dialogHost({ select: ["Answer this in chat"] });
	const result = await withTypedText("0", () => run(host.ctx));

	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, false);
	assert.doesNotMatch(text(result), /dismissed/i);
	assert.match(text(result), /in their own words in chat/i);
	assert.match(text(result), /plain text/i);
	// No text dialog was ever requested, because the host would have cancelled it.
	assert.deepEqual(host.seen.input, []);
	assert.equal(host.seen.select?.[0], "Answer this in chat");
});

test("answering one question in chat keeps the answers already collected", async () => {
	const two = [
		{ id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "small", label: "Small" }] },
		{ id: "speed", label: "Speed", prompt: "How fast?", options: [{ value: "fast", label: "Fast" }] },
	];
	const host = dialogHost({ select: ["1. Small", "Answer this in chat"] });
	const result = await withTypedText("0", () =>
		registeredTool().execute("call", { questions: two }, undefined, undefined, host.ctx),
	);

	assert.notEqual(result.isError, true);
	assert.equal(result.details?.cancelled, false);
	assert.match(text(result), /Speed/);
	assert.match(text(result), /Scope: user selected: 1\. Small/);
});

test("a host that can type still gets the 'Type your own answer' prompt", async () => {
	const host = dialogHost({ select: ["Type your own answer"], input: ["A medium one"] });
	const result = await withTypedText("1", () => run(host.ctx));

	assert.notEqual(result.isError, true);
	assert.match(text(result), /Scope: user wrote: A medium one/);
	assert.deepEqual(host.seen.input, ["A medium one"]);
});
