import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";

import type { BoardMode, Ticket, TicketSummary } from "../src/fit.ts";
import {
	BOARD_MOVE_ACTION,
	BOARD_WORK_ACTION,
	boardAutocommit,
	boardSelectedDestination,
	boardSelectedTicketIds,
	buildBoardSurface,
	buildTicketSurface,
} from "../src/board-surface.ts";
import type { A2uiPanelAction, A2uiPanelPayload } from "../src/a2ui.ts";

const basicMode: BoardMode = { mode: "basic", version: null, strict: null };

function ticket(
	id: string,
	title: string,
	options: { project?: string | null; status?: string; body?: string } = {},
): TicketSummary {
	const filename = id.split("/").pop() ?? id;
	const name = filename.replace(/\.md$/, "");
	const priorityMatch = /^(\d{2})-/.exec(name);
	const shortName = priorityMatch ? name.slice(3) : name;
	const status = options.status ?? id.split("/")[0] ?? "";
	return {
		id,
		path: `/board/${id}`,
		status,
		subdir: id.split("/").slice(1, -1).join("/"),
		filename,
		name,
		shortName,
		displayName: shortName
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" "),
		project: options.project ?? null,
		priority: priorityMatch ? Number(priorityMatch[1]) : null,
		title,
		bodyChars: options.body?.length ?? title.length,
	};
}

function fullTicket(summary: TicketSummary, body: string): Ticket {
	return {
		...summary,
		content: body,
		revision: "abc123",
		frontmatterRaw: null,
		frontmatter: {},
		body,
	};
}

function components(payload: A2uiPanelPayload): Array<Record<string, unknown>> {
	const create = payload.messages[0]?.createSurface;
	assert.ok(create);
	return create.components as Array<Record<string, unknown>>;
}

function assertValid(payload: A2uiPanelPayload): void {
	const processor = new MessageProcessor([basicCatalog]);
	assert.deepEqual(processor.processMessagesWithErrors(payload.messages), []);
	assert.ok(processor.getSurface(payload.surfaceId));
}

describe("FIT board A2UI surfaces", () => {
	it("builds per-status tabs with inspect, start, and close actions", () => {
		const open = ticket("open/03-fix-typo.md", "Fix typo.", { project: "docs" });
		const closed = ticket("closed/00-done.md", "Done.");
		const payload = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [open, closed],
			counts: { open: 1, closed: 1 },
			listed: 2,
			total: 2,
		});

		assert.equal(payload.surfaceId, "fit_board");
		const list = components(payload);
		const tabs = list.find((component) => component["component"] === "Tabs");
		assert.deepEqual(tabs?.["tabs"], [
			{ title: "Open", child: "status_0" },
			{ title: "Closed", child: "status_1" },
		]);
		const openStart = list.find((component) => component["id"] === "ticket_0_0_start");
		assert.deepEqual(openStart?.["action"], {
			event: { name: "start", context: { ticketId: "open/03-fix-typo.md" } },
		});
		const openView = list.find((component) => component["id"] === "ticket_0_0_view");
		assert.deepEqual(openView?.["action"], {
			event: { name: "show", context: { ticketId: "open/03-fix-typo.md" } },
		});
		const closedStart = list.find((component) => component["id"] === "ticket_1_0_start");
		const closedClose = list.find((component) => component["id"] === "ticket_1_0_close");
		assert.equal(closedStart, undefined);
		assert.equal(closedClose, undefined);
		const meta = list.find((component) => component["id"] === "meta");
		assert.match(String(meta?.["text"]), /Tickets: 2 total \(open 1 · closed 1\)/);
		assert.match(String(meta?.["text"]), /Board: \/repo\/fit/);
		assertValid(payload);
	});

	it("uses a text placeholder when the board or filtered view is empty", () => {
		const empty = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [],
			counts: {},
			listed: 0,
			total: 0,
		});
		const emptyTabs = components(empty).find((component) => component["id"] === "tabs");
		assert.equal(emptyTabs?.["component"], "Text");
		assert.equal(emptyTabs?.["text"], "No tickets yet.");

		const filtered = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [],
			counts: { open: 1 },
			listed: 0,
			total: 1,
			filter: "closed/",
		});
		const filteredTabs = components(filtered).find((component) => component["id"] === "tabs");
		assert.equal(filteredTabs?.["text"], "No tickets match this view.");
		assertValid(empty);
		assertValid(filtered);
	});

	it("adds checkboxes only to open and backlog cards and builds the Work action", () => {
		const current = ticket("in_progress/00-current.md", "Current.");
		const open = ticket("open/03-fix-typo.md", "Fix typo.");
		const backlog = ticket("backlog/04-later.md", "Later.");
		const closed = ticket("closed/00-done.md", "Done.");
		const payload = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [current, open, backlog, closed],
			counts: { in_progress: 1, open: 1, backlog: 1, closed: 1 },
			listed: 4,
			total: 4,
			selected: [open.id],
			autocommit: true,
		});

		assert.equal(payload.messages[0]?.createSurface.sendDataModel, true);
		assert.deepEqual(payload.messages[0]?.createSurface.dataModel, {
			selected: [true, false],
			autocommit: true,
			destination: [],
		});

		const list = components(payload);
		const selects = list.filter(
			(component) =>
				component["component"] === "CheckBox" && component["label"] === "Select",
		);
		assert.equal(selects.length, 2);
		assert.deepEqual(
			selects.map((component) => component["value"]),
			[{ "@path": "/selected/0" }, { "@path": "/selected/1" }],
		);

		const autocommit = list.find((component) => component["id"] === "autocommit");
		assert.equal(autocommit?.["component"], "CheckBox");
		assert.deepEqual(autocommit?.["value"], { "@path": "/autocommit" });

		const work = list.find((component) => component["id"] === "work");
		const workAction = work?.["action"] as {
			event?: { name?: string; context?: Record<string, unknown> };
		};
		assert.equal(workAction.event?.name, BOARD_WORK_ACTION);
		assert.deepEqual(workAction.event?.context, {
			autocommit: { "@path": "/autocommit" },
			selected_0: { "@path": "/selected/0" },
			selected_1: { "@path": "/selected/1" },
		});

		const action: A2uiPanelAction = {
			name: BOARD_WORK_ACTION,
			context: { selected_0: true, selected_1: false, autocommit: true },
		};
		assert.deepEqual(
			boardSelectedTicketIds(action, [current, open, backlog, closed]),
			[open.id],
		);
		assert.equal(boardAutocommit(action), true);
		assertValid(payload);
	});

	it("builds a bulk move bar with a destination ChoicePicker", () => {
		const open = ticket("open/03-fix-typo.md", "Fix typo.");
		const backlog = ticket("backlog/04-later.md", "Later.");
		const payload = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [open, backlog],
			counts: { open: 1, backlog: 1 },
			listed: 2,
			total: 2,
			selected: [open.id],
			destination: ["backlog"],
			notice: "Moved 1 ticket(s) to backlog:",
		});

		assert.deepEqual(payload.messages[0]?.createSurface.dataModel, {
			selected: [true, false],
			autocommit: false,
			destination: ["backlog"],
		});

		const list = components(payload);
		const picker = list.find((component) => component["id"] === "destination");
		assert.equal(picker?.["component"], "ChoicePicker");
		assert.equal(picker?.["variant"], "mutuallyExclusive");
		assert.deepEqual(picker?.["value"], { "@path": "/destination" });
		assert.deepEqual(
			(picker?.["options"] as Array<Record<string, unknown>>).map((option) => option["value"]),
			["in_progress", "open", "backlog", "closed"],
		);

		const move = list.find((component) => component["id"] === "move");
		const moveAction = move?.["action"] as {
			event?: { name?: string; context?: Record<string, unknown> };
		};
		assert.equal(moveAction.event?.name, BOARD_MOVE_ACTION);
		assert.deepEqual(moveAction.event?.context, {
			destination: { "@path": "/destination" },
			selected_0: { "@path": "/selected/0" },
			selected_1: { "@path": "/selected/1" },
		});
		assert.equal(
			list.find((component) => component["id"] === "notice")?.["text"],
			"Moved 1 ticket(s) to backlog:",
		);

		assert.equal(
			boardSelectedDestination({ name: BOARD_MOVE_ACTION, context: { destination: ["closed"] } }),
			"closed",
		);
		assert.equal(
			boardSelectedDestination({ name: BOARD_MOVE_ACTION, context: { destination: "open" } }),
			"open",
		);
		assert.equal(
			boardSelectedDestination({ name: BOARD_MOVE_ACTION, context: { destination: [] } }),
			undefined,
		);
		assertValid(payload);
	});

	it("omits the bulk move bar when no ticket is selectable", () => {
		const closed = ticket("closed/00-done.md", "Done.");
		const payload = buildBoardSurface({
			board: "/repo/fit",
			mode: basicMode,
			tickets: [closed],
			counts: { closed: 1 },
			listed: 1,
			total: 1,
		});
		const list = components(payload);
		assert.equal(list.find((component) => component["id"] === "destination"), undefined);
		assert.equal(list.find((component) => component["id"] === "move"), undefined);
		assertValid(payload);
	});

	it("builds a ticket detail surface with body and start/close/board actions", () => {
		const summary = ticket("open/03-fix-typo.md", "Fix typo.", { project: "docs" });
		const detail = fullTicket(summary, "Summary.\n\n### Notes\n\nFix the typo.");
		const payload = buildTicketSurface({ board: "/repo/fit", mode: basicMode, ticket: detail });

		assert.equal(payload.surfaceId, "fit_ticket");
		assert.equal(payload.title, "open/03-fix-typo.md");
		const list = components(payload);
		const body = list.find((component) => component["id"] === "body");
		assert.equal(body?.["text"], detail.body);
		const meta = list.find((component) => component["id"] === "meta");
		assert.match(String(meta?.["text"]), /project: docs/);
		assert.match(String(meta?.["text"]), /revision: abc123/);
		const start = list.find((component) => component["id"] === "start");
		assert.deepEqual(start?.["action"], {
			event: { name: "start", context: { ticketId: "open/03-fix-typo.md" } },
		});
		const board = list.find((component) => component["id"] === "board");
		assert.deepEqual(board?.["action"], { event: { name: "board" } });
		assertValid(payload);

		const closed = buildTicketSurface({
			board: "/repo/fit",
			mode: basicMode,
			ticket: fullTicket(ticket("closed/00-done.md", "Done."), "Done."),
		});
		const closedList = components(closed);
		assert.equal(closedList.find((component) => component["id"] === "start"), undefined);
		assert.equal(closedList.find((component) => component["id"] === "close"), undefined);
		assertValid(closed);
	});
});
