import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FitError, type Ticket, type TicketSummary } from "../src/fit.ts";
import {
	BATCH_AUTONOMY_INSTRUCTION,
	BATCH_GRILL_INSTRUCTION,
	buildPlanLegMessage,
	buildRunMessage,
	classifyPlannerCommand,
	parsePlanLegFlags,
	parsePlannerModeArgs,
	parseWorkRunFlags,
	selectSelectedWorkQueue,
	selectWorkQueue,
} from "../src/index.ts";

function summary(id: string, title = ""): TicketSummary {
	const filename = id.split("/").pop() ?? id;
	const name = filename.replace(/\.md$/, "");
	const status = id.split("/")[0] ?? "";
	const subdir = id.split("/").slice(1, -1).join("/");
	const shortName = name.replace(/^\d{2}-/, "");
	const priorityMatch = /^(\d{2})-/.exec(name);
	return {
		id,
		path: `/board/${id}`,
		status,
		subdir,
		filename,
		name,
		shortName,
		displayName: shortName
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" "),
		project: null,
		priority: priorityMatch ? Number(priorityMatch[1]) : null,
		title: title || shortName,
		bodyChars: title.length,
	};
}

function ticket(id: string, title: string): Ticket {
	return {
		...summary(id, title),
		content: title,
		revision: `${id}-rev`,
		frontmatterRaw: null,
		frontmatter: {},
		body: title,
	};
}

function expectFitError(fn: () => unknown, code: string): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof FitError, `expected FitError, got ${String(error)}`);
		assert.equal(error.code, code);
		return true;
	});
}

describe("work run flag parsing", () => {
	it("keeps a bare work command on the single-ticket path", () => {
		assert.deepEqual(parseWorkRunFlags([]), {
			review: undefined,
			nogrill: undefined,
			count: undefined,
			autocommit: false,
			rest: [],
		});
	});

	it("parses review, nogrill, autocommit, and a count in any order", () => {
		assert.deepEqual(parseWorkRunFlags(["3", "review", "nogrill", "autocommit"]), {
			review: true,
			nogrill: true,
			count: 3,
			autocommit: true,
			rest: [],
		});
		assert.equal(parseWorkRunFlags(["autocommit"]).count, undefined);
		assert.equal(parseWorkRunFlags(["autocommit"]).autocommit, true);
		assert.equal(parseWorkRunFlags(["2", "no-grill"]).nogrill, true);
	});

	it("rejects invalid counts and duplicates", () => {
		expectFitError(() => parseWorkRunFlags(["0"]), "INVALID_ARGUMENTS");
		expectFitError(() => parseWorkRunFlags(["-2"]), "INVALID_ARGUMENTS");
		expectFitError(() => parseWorkRunFlags(["2", "3"]), "INVALID_FLAG");
		expectFitError(() => parseWorkRunFlags(["review", "review"]), "INVALID_FLAG");
		expectFitError(() => parseWorkRunFlags(["autocommit", "autocommit"]), "INVALID_FLAG");
	});

	it("leaves unknown tokens for the command to report", () => {
		assert.deepEqual(parseWorkRunFlags(["nonsense"]).rest, ["nonsense"]);
	});
});

describe("work queue selection", () => {
	const tickets = [
		summary("in_progress/00-first.md"),
		summary("in_progress/01-second.md"),
		summary("open/00-third.md"),
		summary("open/01-fourth.md"),
		summary("backlog/00-later.md"),
		summary("closed/00-done.md"),
	];

	it("puts every in_progress ticket first, then open tickets", () => {
		assert.deepEqual(
			selectWorkQueue(tickets, 3).map((item) => item.id),
			["in_progress/00-first.md", "in_progress/01-second.md", "open/00-third.md"],
		);
	});

	it("excludes backlog unless the caller confirms a fallback", () => {
		assert.deepEqual(
			selectWorkQueue(tickets, 10).map((item) => item.id),
			[
				"in_progress/00-first.md",
				"in_progress/01-second.md",
				"open/00-third.md",
				"open/01-fourth.md",
			],
		);
		assert.deepEqual(
			selectWorkQueue(tickets, 10, true).map((item) => item.id),
			[
				"in_progress/00-first.md",
				"in_progress/01-second.md",
				"open/00-third.md",
				"open/01-fourth.md",
				"backlog/00-later.md",
			],
		);
	});

	it("never includes closed tickets", () => {
		const queue = selectWorkQueue(tickets, 20, true);
		assert.ok(queue.every((item) => item.status !== "closed"));
	});

	it("uses all in_progress tickets then selected open and backlog tickets", () => {
		const queue = selectSelectedWorkQueue(tickets, [
			"backlog/00-later.md",
			"open/01-fourth.md",
			"closed/00-done.md",
		]);
		assert.deepEqual(
			queue.map((item) => item.id),
			[
				"in_progress/00-first.md",
				"in_progress/01-second.md",
				"open/01-fourth.md",
				"backlog/00-later.md",
			],
		);
	});
});

describe("planner command routing", () => {
	it("maps planner and plan to mode or leg", () => {
		assert.equal(classifyPlannerCommand("planner", []), "mode");
		assert.equal(classifyPlannerCommand("planner", ["on"]), "mode");
		assert.equal(classifyPlannerCommand("planner", ["leg"]), "leg");
		assert.equal(
			classifyPlannerCommand("planner", ["leg", "nogrill", "fix"]),
			"leg",
		);
		assert.equal(classifyPlannerCommand("plan", []), "mode");
		assert.equal(classifyPlannerCommand("plan", ["leg"]), "leg");
	});

	it("keeps the old command names as hidden aliases", () => {
		assert.equal(classifyPlannerCommand("agent", []), "mode");
		assert.equal(classifyPlannerCommand("mode", ["status"]), "mode");
		assert.equal(classifyPlannerCommand("agent", ["leg"]), "leg");
		assert.equal(classifyPlannerCommand("plan-a-leg", []), "leg");
	});

	it("ignores unrelated commands", () => {
		assert.equal(classifyPlannerCommand("list", []), undefined);
		assert.equal(classifyPlannerCommand("work", ["leg"]), undefined);
	});
});

describe("planner mode argument parsing", () => {
	it("keeps plain mode actions", () => {
		assert.deepEqual(parsePlannerModeArgs("planner", []), { action: "toggle" });
		assert.deepEqual(parsePlannerModeArgs("planner", ["on"]), { action: "on" });
		assert.deepEqual(parsePlannerModeArgs("planner", ["off"]), { action: "off" });
		assert.deepEqual(parsePlannerModeArgs("planner", ["status"]), {
			action: "status",
		});
	});

	it("turns a bare planner/plan prompt into an enabling action", () => {
		assert.deepEqual(parsePlannerModeArgs("planner", ["fix", "the", "typo"]), {
			action: "on",
			promptText: "fix the typo",
		});
		assert.deepEqual(parsePlannerModeArgs("plan", ["fix"]), {
			action: "on",
			promptText: "fix",
		});
		assert.deepEqual(parsePlannerModeArgs("planner", ["on", "fix"]), {
			action: "on",
			promptText: "fix",
		});
	});

	it("rejects prompt text after off, status, toggle, or hidden aliases", () => {
		expectFitError(
			() => parsePlannerModeArgs("planner", ["off", "later"]),
			"INVALID_ARGUMENTS",
		);
		expectFitError(
			() => parsePlannerModeArgs("planner", ["status", "now"]),
			"INVALID_ARGUMENTS",
		);
		expectFitError(
			() => parsePlannerModeArgs("planner", ["toggle", "now"]),
			"INVALID_ARGUMENTS",
		);
		expectFitError(
			() => parsePlannerModeArgs("agent", ["fix"]),
			"INVALID_ARGUMENTS",
		);
		expectFitError(
			() => parsePlannerModeArgs("mode", ["on", "fix"]),
			"INVALID_ARGUMENTS",
		);
	});
});

describe("planner leg flags and prompt", () => {
	it("parses only nogrill and keeps the rest as text", () => {
		assert.deepEqual(parsePlanLegFlags([]), { nogrill: undefined, rest: [] });
		assert.deepEqual(parsePlanLegFlags(["nogrill", "fix", "the", "typo"]), {
			nogrill: true,
			rest: ["fix", "the", "typo"],
		});
		assert.deepEqual(parsePlanLegFlags(["fix", "nogrill"]).rest, ["fix", "nogrill"]);
	});

	it("rejects duplicate nogrill flags", () => {
		expectFitError(
			() => parsePlanLegFlags(["nogrill", "no-grill"]),
			"INVALID_FLAG",
		);
	});

	it("names the umbrella, destination, and parent id", () => {
		const text = buildPlanLegMessage(
			ticket("in_progress/00-big-work.md", "Big work"),
			"/repo/fit",
			"open/project-x",
			false,
			false,
		);
		assert.match(text, /Plan a leg of work for FIT ticket in_progress\/00-big-work\.md/);
		assert.match(text, /Leg destination: open\/project-x/);
		assert.match(text, /parent frontmatter: in_progress\/00-big-work\.md/);
		assert.match(text, /final review ticket/);
	});

	it("marks a command-created umbrella and includes grilling only when enabled", () => {
		const plain = buildPlanLegMessage(
			ticket("open/00-new-leg.md", "New leg"),
			"/repo/fit",
			"open",
			false,
			true,
			"open/00-new-leg.md",
		);
		assert.match(plain, /created open\/00-new-leg\.md as the umbrella/);
		assert.doesNotMatch(plain, /grill me/);

		const grilled = buildPlanLegMessage(
			ticket("open/00-new-leg.md", "New leg"),
			"/repo/fit",
			"open",
			true,
			false,
		);
		assert.match(grilled, /grill me/);
		assert.match(grilled, /ask how many implementation tickets/);
	});
});

describe("batch work prompt", () => {
	const board = "/repo/fit";
	const tickets = [
		ticket("in_progress/00-first.md", "First ticket"),
		ticket("open/01-second.md", "Second ticket"),
	];

	it("lists the fixed queue with ids, revisions, and titles", () => {
		const text = buildRunMessage(tickets, 2, board, false, true, false);
		assert.match(text, /in_progress\/00-first\.md \(revision in_progress\/00-first\.md-rev\)/);
		assert.match(text, /open\/01-second\.md \(revision open\/01-second\.md-rev\)/);
		assert.match(text, /First ticket/);
		assert.match(text, /Second ticket/);
		assert.match(text, /fixed queue of 2/);
		assert.match(text, /snapshot from before grilling/);
	});

	it("includes immediate batch grilling and the cancel rule", () => {
		const text = buildRunMessage(tickets, 2, board, false, true, false);
		assert.ok(text.includes(BATCH_GRILL_INSTRUCTION));
		assert.match(text, /Grill the whole queue now/);
		assert.match(text, /If the user cancels any setup or grilling question, stop immediately/);
	});

	it("omits batch grilling when nogrill is selected", () => {
		const text = buildRunMessage(tickets, 2, board, false, false, false);
		assert.ok(!text.includes(BATCH_GRILL_INSTRUCTION));
		assert.ok(!text.includes("Before doing any implementation"));
	});

	it("includes autonomous sequencing and the scope-expansion halt", () => {
		const text = buildRunMessage(tickets, 2, board, false, true, false);
		assert.ok(text.includes(BATCH_AUTONOMY_INSTRUCTION));
		assert.match(text, /without asking for confirmation between tickets/);
		assert.match(text, /halt the batch and ask the user/);
		assert.match(text, /fixed queue/);
	});

	it("includes autocommit instructions only when requested", () => {
		const plain = buildRunMessage(tickets, 2, board, false, true, false);
		assert.ok(!plain.includes("Autocommit is on"));
		const autocommit = buildRunMessage(tickets, 2, board, false, true, true);
		assert.match(autocommit, /Autocommit is on/);
		assert.match(autocommit, /FIT: close <short-name>/);
		assert.match(autocommit, /git rev-parse HEAD/);
		assert.match(autocommit, /never stage unrelated dirty files/);
		assert.match(autocommit, /do not record a commit hash for a commit that was not made/);
		assert.match(autocommit, /only if you made a commit/);
	});

	it("reports a shortfall when fewer tickets are available", () => {
		const text = buildRunMessage(tickets, 5, board, false, true, false);
		assert.match(text, /Only 2 of 5 requested tickets could be queued/);
	});

	it("leaves a single review ticket in_progress", () => {
		const text = buildRunMessage(tickets.slice(0, 1), 1, board, true, false, false);
		assert.match(text, /Review mode is ON/);
		assert.match(text, /Do not move this ticket to closed/);
		assert.doesNotMatch(text, /close it with fit_move/);
	});
});
