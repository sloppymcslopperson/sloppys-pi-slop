import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import questionnaire from "../extensions/questionnaire.ts";

interface RegisteredTool {
	name?: string;
	executionMode?: string;
	exposure?: string;
}

test("exports a Pi extension function", () => {
	assert.equal(typeof questionnaire, "function");
});

test("registers the questionnaire tool", () => {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	questionnaire(pi);

	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "questionnaire");
	assert.equal(tools[0].executionMode, "sequential");
	assert.equal(tools[0].exposure, "model-only");
});
