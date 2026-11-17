import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TicketSummary } from "../src/fit.ts";
import { fuzzyFind, fuzzyScore } from "../src/human.ts";

function ticket(id: string, title = ""): TicketSummary {
	const filename = id.split("/").pop() ?? id;
	const name = filename.replace(/\.md$/, "");
	const priorityMatch = /^(\d{2})-/.exec(name);
	const shortName = priorityMatch ? name.slice(3) : name;
	return {
		id,
		path: `/board/${id}`,
		status: id.split("/")[0] ?? "",
		subdir: id.split("/").slice(1, -1).join("/"),
		filename,
		name,
		shortName,
		displayName: shortName
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" "),
		project: null,
		priority: priorityMatch ? Number(priorityMatch[1]) : null,
		title,
		bodyChars: title.length,
	};
}

describe("human fuzzy lookup", () => {
	const tickets = [
		ticket("open/03-fix-typo-in-readme.md", "Fix typo in README."),
		ticket("open/04-fix-login-bug.md", "Fix login bug."),
		ticket("backlog/10-add-search.md", "Add search."),
	];

	it("prefers exact filenames", () => {
		const matches = fuzzyFind(tickets, "03-fix-typo-in-readme.md");
		assert.equal(matches[0].id, "open/03-fix-typo-in-readme.md");
	});

	it("matches substrings and subsequences", () => {
		assert.equal(fuzzyFind(tickets, "typo")[0].id, "open/03-fix-typo-in-readme.md");
		assert.equal(fuzzyFind(tickets, "login")[0].id, "open/04-fix-login-bug.md");
		assert.ok(fuzzyFind(tickets, "fxrdm").some((t) => t.id.includes("readme")));
	});

	it("scores exact matches highest and returns deterministic ties", () => {
		assert.ok(fuzzyScore(tickets[0], "readme") > fuzzyScore(tickets[1], "readme"));
		const tied = [ticket("open/02-b.md"), ticket("open/01-a.md")];
		assert.deepEqual(
			fuzzyFind(tied, "0").map((t) => t.id),
			["open/01-a.md", "open/02-b.md"],
		);
	});

	it("returns no candidates for a non-match", () => {
		assert.deepEqual(fuzzyFind(tickets, "zzzzzz"), []);
	});
});
