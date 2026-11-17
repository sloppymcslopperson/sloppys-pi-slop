import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FIT_AGENTS_BEGIN,
	FIT_AGENTS_END,
	mergeAgentsContent,
} from "../src/agents.ts";

describe("AGENTS.md FIT section", () => {
	it("creates the managed section for a new file", () => {
		const merged = mergeAgentsContent(null);
		assert.equal(merged.changed, true);
		assert.match(merged.content, new RegExp(FIT_AGENTS_BEGIN));
		assert.match(merged.content, new RegExp(FIT_AGENTS_END));
		assert.match(merged.content, /Prefer dedicated tools over direct manipulation/);
		assert.match(merged.content, /Do not read ticket files/);
		assert.doesNotMatch(merged.content, /250/);
		assert.match(merged.content, /\[AGENT_SPEC\.md\]\(AGENT_SPEC\.md\)/);
		assert.match(merged.content, /`00` to `99`/);
		assert.match(merged.content, /short-name identity/);
		assert.match(merged.content, /STRICT/);
		assert.match(merged.content, /`fit_archive`/);
		assert.match(merged.content, /At most one ticket may be in `in_progress`/);
	});

	it("appends to existing instructions without overwriting them", () => {
		const existing = "# Project rules\n\nAlways run tests.\n";
		const merged = mergeAgentsContent(existing);
		assert.equal(merged.changed, true);
		assert.ok(merged.content.startsWith(existing.trimEnd()));
		assert.match(merged.content, /## FIT tickets/);
	});

	it("replaces only the marked block", () => {
		const existing = [
			"# Project rules",
			"",
			FIT_AGENTS_BEGIN,
			"old fit instructions",
			FIT_AGENTS_END,
			"",
			"Keep this line.",
			"",
		].join("\n");
		const merged = mergeAgentsContent(existing);
		assert.equal(merged.changed, true);
		assert.ok(merged.content.startsWith("# Project rules\n\n"));
		assert.ok(merged.content.endsWith("\n\nKeep this line.\n"));
		assert.doesNotMatch(merged.content, /old fit instructions/);
		assert.match(merged.content, /## FIT tickets/);
	});

	it("is idempotent once the section is current", () => {
		const first = mergeAgentsContent("# Project rules\n");
		const second = mergeAgentsContent(first.content);
		assert.equal(second.changed, false);
		assert.equal(second.content, first.content);
	});

	it("preserves CRLF line endings when appending", () => {
		const merged = mergeAgentsContent("# Rules\r\n\r\nBe careful.\r\n");
		assert.match(merged.content, /## FIT tickets/);
		assert.ok(merged.content.includes("\r\n"));
		assert.doesNotMatch(merged.content, /(?<!\r)\n/);
	});
});
