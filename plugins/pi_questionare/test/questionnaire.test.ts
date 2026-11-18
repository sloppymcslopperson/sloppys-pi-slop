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
