import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BoardMode, TicketSummary } from "../src/fit.ts";
import { formatInProgressStatus } from "../src/status.ts";

const basicMode: BoardMode = { mode: "basic", version: null, strict: null };
const strictMode: BoardMode = {
	mode: "strict",
	version: "0.5",
	strict: '"0.5"',
};

function ticket(id: string): TicketSummary {
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
		title: "",
		bodyChars: 0,
	};
}

describe("in-progress footer status", () => {
	it("hides the indicator on Basic boards", () => {
		assert.equal(
			formatInProgressStatus(basicMode, [ticket("in_progress/00-work.md")]),
			undefined,
		);
	});

	it("hides the indicator when no Strict ticket is in progress", () => {
		assert.equal(
			formatInProgressStatus(strictMode, [ticket("open/00-later.md")]),
			undefined,
		);
	});

	it("shows the in-progress filename stem without .md or subdirectory", () => {
		assert.equal(
			formatInProgressStatus(strictMode, [
				ticket("in_progress/project-x/00-add-ui-element-showing.md"),
			]),
			"fit: in_progress 00-add-ui-element-showing",
		);
	});

	it("reports every in-progress ticket when Strict has more than one", () => {
		assert.equal(
			formatInProgressStatus(strictMode, [
				ticket("in_progress/00-first.md"),
				ticket("in_progress/01-second.md"),
			]),
			"fit: ERROR in_progress has 2 tickets: 00-first, 01-second",
		);
	});
});
