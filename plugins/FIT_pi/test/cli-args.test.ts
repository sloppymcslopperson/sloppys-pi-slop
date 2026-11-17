import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	UsageError,
	parseCliArgs,
	parseListLimit,
	parseNameMaxLength,
	parseNewPositionals,
	parsePriority,
	parseSetAssignments,
} from "../src/cli-args.ts";

function expectUsage(fn: () => unknown, pattern: RegExp): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof UsageError);
		assert.match(error.message, pattern);
		return true;
	});
}

describe("CLI argument parsing", () => {
	it("accepts --board before or after the command", () => {
		const before = parseCliArgs(["--board", "docs/fit", "list", "--json"]);
		assert.equal(before.positionals[0], "list");
		assert.equal(before.values.board, "docs/fit");
		assert.equal(before.values.json, true);

		const after = parseCliArgs(["list", "-b", "docs/fit"]);
		assert.equal(after.positionals[0], "list");
		assert.equal(after.values.board, "docs/fit");
	});

	it("mirrors new [status] [priority] <text>", () => {
		assert.deepEqual(parseNewPositionals(["open", "3", "Fix", "the", "typo."]), {
			status: "open",
			priority: 3,
			text: "Fix the typo.",
		});
		assert.deepEqual(parseNewPositionals([]), {
			status: "open",
			priority: 0,
			text: "",
		});
		assert.deepEqual(parseNewPositionals(["Fix", "the", "typo."]), {
			status: "open",
			priority: 0,
			text: "Fix the typo.",
		});
		assert.deepEqual(parseNewPositionals(["3", "Fix", "the", "typo."]), {
			status: "open",
			priority: 3,
			text: "Fix the typo.",
		});
		assert.deepEqual(parseNewPositionals(["backlog", "Later."]), {
			status: "backlog",
			priority: 0,
			text: "Later.",
		});
	});

	it("parses typed --set values and arrays", () => {
		assert.deepEqual(
			parseSetAssignments([
				"owner=alice",
				"count=3",
				"ready=true",
				"tags=[\"one\",\"two\"]",
				"empty=null",
			]),
			{
				owner: "alice",
				count: 3,
				ready: true,
				tags: ["one", "two"],
				empty: null,
			},
		);
		assert.deepEqual(parseSetAssignments(["label=01"]), { label: "01" });
		assert.equal(parseSetAssignments([]), undefined);
	});

	it("rejects malformed --set entries", () => {
		expectUsage(() => parseSetAssignments(["missing"]), /key=value/);
		expectUsage(() => parseSetAssignments(["=value"]), /empty key/);
	});

	it("validates priorities, limits, and name lengths", () => {
		assert.equal(parsePriority("99"), 99);
		assert.equal(parsePriority(undefined, 5), 5);
		expectUsage(() => parsePriority("100"), /between 0 and 99/);
		expectUsage(() => parsePriority("abc"), /integer/);

		assert.equal(parseListLimit("10", false), 10);
		assert.equal(parseListLimit(undefined, true), undefined);
		expectUsage(() => parseListLimit("0", false), /positive/);
		expectUsage(() => parseListLimit("10", true), /cannot be combined/);

		assert.equal(parseNameMaxLength("30"), 30);
		expectUsage(() => parseNameMaxLength("7"), /between 8 and 255/);
	});

	it("turns unknown options into usage errors", () => {
		expectUsage(() => parseCliArgs(["list", "--nope"]), /Unknown option/);
	});
});
