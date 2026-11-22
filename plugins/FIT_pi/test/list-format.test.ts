import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BoardMode, TicketSummary } from "../src/fit.ts";
import { formatList } from "../src/index.ts";

const basicMode: BoardMode = { mode: "basic", version: null, strict: null };

function ticket(
	id: string,
	title = "",
	project: string | null = null,
): TicketSummary {
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
		project,
		priority: priorityMatch ? Number(priorityMatch[1]) : null,
		title,
		bodyChars: title.length,
	};
}

const counts = { in_progress: 1, open: 2, backlog: 1, closed: 0 };

describe("human list formatting", () => {
	it("groups tickets by status with headings and per-status counts", () => {
		const tickets = [
			ticket("in_progress/00-fix-login.md", "Fix login."),
			ticket("open/03-fix-typo.md", "Fix typo."),
			ticket("open/10-add-search.md", "Add search."),
			ticket("backlog/50-clean-docs.md", "Clean docs."),
		];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts);

		assert.match(text, /Tickets: 4 total · in_progress 1 · open 2 · backlog 1 · closed 0/);
		assert.match(text, /\nin_progress\/ {2}1 ticket\n─+\n/);
		assert.match(text, /\nopen\/ {2}2 tickets\n─+\n/);
		assert.match(text, /\nbacklog\/ {2}1 ticket\n─+\n/);
		assert.ok(!text.includes("closed/"));
	});

	it("pads ids so titles line up and annotates projects", () => {
		const tickets = [
			ticket("open/03-fix-typo.md", "Fix typo."),
			ticket("open/10-add-search.md", "Add search.", "search"),
		];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts);
		const rows = text
			.split("\n")
			.filter((line) => line.startsWith("  open/"))
			.map((line) => line.slice(2));
		const titleColumns = rows.map((row) => row.indexOf("Fix typo.") >= 0
			? row.indexOf("Fix typo.")
			: row.indexOf("Add search."));

		assert.equal(titleColumns[0], titleColumns[1]);
		assert.match(text, /Add search\. {2}\[search\]/);
	});

	it("wraps the title when an id is wider than the id column", () => {
		const longId = `open/00-${"a".repeat(70)}.md`;
		const tickets = [ticket(longId, "Long name.")];
		const text = formatList("/board/fit", basicMode, tickets, tickets, {
			in_progress: 0,
			open: 1,
			backlog: 0,
			closed: 0,
		});

		assert.ok(text.includes(`  ${longId}\n      Long name.`));
	});

	it("stacks every id and title when stacked is enabled", () => {
		const tickets = [
			ticket("open/03-fix-typo.md", "Fix typo."),
			ticket("open/10-add-search.md", "Add search.", "search"),
		];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts, {
			stacked: true,
		});

		assert.ok(
			text.includes(
				"  open/03-fix-typo.md\n      Fix typo.\n  open/10-add-search.md\n      Add search.  [search]",
			),
		);
	});

	it("keeps stacked long ids and titles at the same indentation", () => {
		const longId = `open/00-${"a".repeat(70)}.md`;
		const tickets = [ticket(longId, "Long name.")];
		const text = formatList("/board/fit", basicMode, tickets, tickets, {
			in_progress: 0,
			open: 1,
			backlog: 0,
			closed: 0,
		}, { stacked: true });

		assert.ok(text.includes(`  ${longId}\n      Long name.`));
	});

	it("wraps stacked titles with an inset continuation", () => {
		const title =
			"Add a Ctrl+Alt+A keyboard shortcut that toggles FIT agent mode, with a visible footer shortcut hint.";
		const tickets = [ticket("closed/00-add-agent-mode-shortcut.md", title)];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts, {
			stacked: true,
			width: 60,
		});
		const lines = text.split("\n");
		const start = lines.findIndex((line) => line === "  closed/00-add-agent-mode-shortcut.md");
		const content = lines.slice(start + 1).filter((line) => line.startsWith("      "));

		assert.ok(start >= 0);
		assert.ok(content.length > 1);
		assert.ok(content.every((line) => line.length <= 60));
		assert.equal(content.map((line) => line.slice(6)).join(" "), title);
	});

	it("truncates long titles without adding rows", () => {
		const tickets = [ticket("open/00-long.md", "x".repeat(200))];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts);
		const row = text.split("\n").find((line) => line.startsWith("  open/00-long.md"));

		assert.ok(row);
		assert.ok(row.includes("…"));
		assert.equal(row.includes("x".repeat(121)), false);
	});

	it("uses the display name when a ticket has no body title", () => {
		const tickets = [ticket("open/00-empty-body.md", "")];
		const text = formatList("/board/fit", basicMode, tickets, tickets, counts);
		assert.match(text, /open\/00-empty-body\.md {2}Empty Body/);
	});

	it("explains filters, limits, and empty views", () => {
		const tickets = [ticket("open/03-fix-typo.md", "Fix typo.")];
		const filtered = formatList(
			"/board/fit",
			basicMode,
			[...tickets, ticket("open/04-other.md", "Other.")],
			tickets,
			counts,
			{ filter: "open/03", limit: 1 },
		);
		assert.match(filtered, /Filter: open\/03/);
		assert.match(filtered, /Showing 1 of 2 tickets, limit 1; adjust the filter or limit/);

		const empty = formatList("/board/fit", basicMode, [], [], {
			in_progress: 0,
			open: 0,
			backlog: 0,
			closed: 0,
		});
		assert.match(empty, /No tickets yet\./);
	});

	it("shows planner mode in the header only when enabled", () => {
		const tickets = [ticket("open/03-fix-typo.md", "Fix typo.")];
		const enabled = formatList("/board/fit", basicMode, tickets, tickets, counts, {
			agentMode: true,
		});
		const disabled = formatList("/board/fit", basicMode, tickets, tickets, counts);

		assert.match(enabled, /Planner mode: on \(FIT-only\)/);
		assert.ok(!disabled.includes("Planner mode:"));
	});
});
