import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MessageProcessor } from "@a2ui/web_core";
import { basicCatalog } from "@a2ui/web_core/catalogs/basic/v1";

import type { BoardMode, Ticket } from "../src/fit.ts";
import type { A2uiPanelAction, A2uiPanelPayload } from "../src/a2ui.ts";
import {
	MAX_NEW_TICKET_TITLE_CHARS,
	NEW_TICKET_ADD_ROW,
	NEW_TICKET_REMOVE_ROW,
	NEW_TICKET_SUBMIT,
	NEW_TICKET_TITLE_PATTERN,
	applyNewTicketFormAction,
	buildNewTicketSurface,
	initialNewTicketState,
	initialNewTicketStateFromTicket,
	normalizedNewTicketTitleState,
	parseNewTicketAction,
	prepareNewTicket,
} from "../src/new-ticket-surface.ts";

const basicMode: BoardMode = { mode: "basic", version: null, strict: null };

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

function action(
	name: string,
	context: Record<string, unknown> = {},
): A2uiPanelAction {
	return { name, context };
}

describe("new ticket A2UI form", () => {
	it("starts empty and builds a data-bound form with add-row and submit actions", () => {
		const state = initialNewTicketState();
		assert.deepEqual(state, {
			status: "open",
			subdir: "",
			priority: "0",
			title: "",
			body: "",
			titleTouched: false,
			frontmatter: [],
		});

		const payload = buildNewTicketSurface({
			board: "/repo/fit",
			mode: basicMode,
			state,
		});
		assert.equal(payload.surfaceId, "fit_new_ticket");
		assert.equal(payload.messages[0]?.createSurface.sendDataModel, true);
		assert.deepEqual(payload.messages[0]?.createSurface.dataModel, {
			status: "open",
			subdir: "",
			priority: "0",
			title: "",
			body: "",
			frontmatter: [],
		});

		const list = components(payload);
		const status = list.find((component) => component["id"] === "status");
		assert.equal(status?.["component"], "ChoicePicker");
		assert.deepEqual(status?.["options"], [
			{ label: "Open", value: "open" },
			{ label: "Backlog", value: "backlog" },
		]);
		assert.deepEqual(status?.["value"], { "@path": "/status" });

		const title = list.find((component) => component["id"] === "title");
		assert.equal(title?.["component"], "TextField");
		assert.deepEqual(title?.["value"], { "@path": "/title" });
		const titleChecks = title?.["checks"] as Array<{
			condition: { "@call": string; args: Record<string, unknown> };
			message: string;
		}>;
		assert.equal(titleChecks.length, 2);
		assert.equal(
			titleChecks[0]?.condition.args["pattern"],
			NEW_TICKET_TITLE_PATTERN,
		);
		assert.match(titleChecks[0]?.message ?? "", /letters, digits, spaces, and hyphens/i);
		assert.match(titleChecks[1]?.message ?? "", /30 characters/);
		assert.equal(
			titleChecks.some((check) => check.condition["@call"] === "required"),
			false,
		);

		const liveTitlePattern = new RegExp(NEW_TICKET_TITLE_PATTERN);
		assert.equal(liveTitlePattern.test(""), true);
		assert.equal(liveTitlePattern.test("My Title"), true);
		assert.equal(liveTitlePattern.test("my-title 2"), true);
		assert.equal(liveTitlePattern.test("not/allowed"), false);

		const rows = list.find((component) => component["id"] === "frontmatter_rows");
		assert.equal(rows?.["component"], "Text");
		assert.equal(rows?.["text"], "No frontmatter yet.");

		const add = list.find((component) => component["id"] === "add_row");
		assert.deepEqual(add?.["action"], {
			event: {
				name: NEW_TICKET_ADD_ROW,
				context: {
					status: { "@path": "/status" },
					subdir: { "@path": "/subdir" },
					priority: { "@path": "/priority" },
					title: { "@path": "/title" },
					body: { "@path": "/body" },
				},
			},
		});

		const create = list.find((component) => component["id"] === "create");
		const createAction = create?.["action"] as { event?: { name?: string } };
		assert.equal(createAction.event?.name, NEW_TICKET_SUBMIT);
		assertValid(payload);
	});

	it("derives the title from body until it is edited, then keeps the manual title", () => {
		let state = initialNewTicketState();
		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_ADD_ROW, {
				status: "backlog",
				subdir: "docs",
				priority: "7",
				title: "",
				body: "Fix the broken typo. More detail under a heading.",
			}),
		);

		assert.equal(state.status, "backlog");
		assert.equal(state.subdir, "docs");
		assert.equal(state.priority, "7");
		assert.equal(state.title, "fix-the-broken-typo");
		assert.equal(state.titleTouched, false);
		assert.deepEqual(state.frontmatter, [{ key: "", value: "" }]);

		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_ADD_ROW, {
				status: "backlog",
				subdir: "docs",
				priority: "7",
				title: "Manual Title",
				body: "Updated body.",
				fmKey0: "project",
				fmValue0: "docs",
			}),
		);
		assert.equal(state.title, "Manual Title");
		assert.equal(state.titleTouched, true);
		assert.deepEqual(state.frontmatter, [
			{ key: "project", value: "docs" },
			{ key: "", value: "" },
		]);

		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_ADD_ROW, {
				status: "backlog",
				subdir: "docs",
				priority: "7",
				title: "Manual Title",
				body: "Another body that must not replace the title.",
				fmKey0: "project",
				fmValue0: "docs",
			}),
		);
		assert.equal(state.title, "Manual Title");
		assert.equal(state.titleTouched, true);
	});

	it("adds and removes frontmatter rows while preserving current values", () => {
		let state = initialNewTicketState();
		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_ADD_ROW, {
				status: "open",
				priority: "0",
				title: "a-title",
				body: "Body.",
			}),
		);
		assert.deepEqual(state.frontmatter, [{ key: "", value: "" }]);

		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_ADD_ROW, {
				status: "open",
				priority: "0",
				title: "a-title",
				body: "Body.",
				fmKey0: "project",
				fmValue0: "docs",
			}),
		);
		assert.deepEqual(state.frontmatter, [
			{ key: "project", value: "docs" },
			{ key: "", value: "" },
		]);

		state = applyNewTicketFormAction(
			state,
			action(NEW_TICKET_REMOVE_ROW, {
				status: "open",
				priority: "0",
				title: "a-title",
				body: "Body.",
				fmKey0: "project",
				fmValue0: "docs",
				rowIndex: 0,
			}),
		);
		assert.deepEqual(state.frontmatter, [{ key: "", value: "" }]);
	});

	it("builds rows and errors into a valid surface with remove actions", () => {
		const state = {
			...initialNewTicketState(),
			title: "a-title",
			body: "Body.",
			frontmatter: [
				{ key: "project", value: "docs" },
				{ key: "reviewed", value: "true" },
			],
			error: "Ticket body is required.",
		};
		const payload = buildNewTicketSurface({
			board: "/repo/fit",
			mode: basicMode,
			state,
		});
		const list = components(payload);
		assert.equal(list.find((component) => component["id"] === "error")?.["text"], state.error);
		const remove = list.find((component) => component["id"] === "fm_1_remove");
		const removeAction = remove?.["action"] as {
			event?: { name?: string; context?: Record<string, unknown> };
		};
		assert.equal(removeAction.event?.name, NEW_TICKET_REMOVE_ROW);
		assert.equal(removeAction.event?.context?.["rowIndex"], 1);
		assert.deepEqual(removeAction.event?.context?.["fmKey1"], { "@path": "/frontmatter/1/key" });
		assertValid(payload);
	});

	it("prefills a copy from every source field except the title", () => {
		const source: Ticket = {
			id: "closed/07-old-work.md",
			path: "/board/closed/07-old-work.md",
			status: "closed",
			subdir: "docs",
			filename: "07-old-work.md",
			name: "07-old-work",
			shortName: "old-work",
			displayName: "Old Work",
			project: "docs",
			priority: 7,
			title: "Old work.",
			bodyChars: 5,
			content: "Body.",
			revision: "abc123",
			frontmatterRaw: null,
			frontmatter: {
				project: "docs",
				reviewed: true,
				count: 3,
				empty: null,
				tags: ["a", 2],
			},
			body: "Body.\n\n### Notes",
		};

		const state = initialNewTicketStateFromTicket(source);
		assert.equal(state.status, "open");
		assert.equal(state.subdir, "docs");
		assert.equal(state.priority, "7");
		assert.equal(state.title, "");
		assert.equal(state.titleTouched, false);
		assert.equal(state.body, source.body);
		assert.deepEqual(state.frontmatter, [
			{ key: "project", value: "docs" },
			{ key: "reviewed", value: "true" },
			{ key: "count", value: "3" },
			{ key: "empty", value: "null" },
			{ key: "tags", value: "[\"a\",2]" },
		]);

		const prepared = prepareNewTicket(state);
		assert.equal(prepared.ok, true);
		if (prepared.ok) {
			assert.equal(prepared.values.status, "open/docs");
			assert.equal(prepared.values.priority, 7);
			assert.deepEqual(prepared.values.frontmatter.tags, ["a", 2]);
		}

		const backlog = initialNewTicketStateFromTicket({
			...source,
			status: "backlog",
		});
		assert.equal(backlog.status, "backlog");
	});

	it("normalizes the displayed title after a failed save", () => {
		const manual = normalizedNewTicketTitleState({
			...initialNewTicketState(),
			title: "Manual Title",
			titleTouched: true,
		});
		assert.equal(manual.title, "manual-title");
		assert.equal(manual.titleTouched, true);

		const derived = normalizedNewTicketTitleState({
			...initialNewTicketState(),
			body: "Fix the broken typo. Details.",
		});
		assert.equal(derived.title, "fix-the-broken-typo");
		assert.equal(derived.titleTouched, false);
	});

	it("parses action names and prepares normalized create inputs", () => {
		assert.deepEqual(parseNewTicketAction(action(NEW_TICKET_ADD_ROW)), {
			kind: "add-row",
		});
		assert.deepEqual(
			parseNewTicketAction(action(NEW_TICKET_REMOVE_ROW, { rowIndex: 2 })),
			{ kind: "remove-row", rowIndex: 2 },
		);
		assert.deepEqual(parseNewTicketAction(action(NEW_TICKET_SUBMIT)), {
			kind: "submit",
		});
		assert.deepEqual(parseNewTicketAction(action("other")), { kind: "unknown" });

		const prepared = prepareNewTicket({
			status: "backlog",
			subdir: "/docs/",
			priority: "09",
			title: "My Title",
			body: "Summary sentence. More detail.",
			titleTouched: true,
			frontmatter: [
				{ key: "project", value: "docs" },
				{ key: "draft", value: "true" },
				{ key: "count", value: "3" },
				{ key: "empty", value: "" },
			],
		});
		assert.deepEqual(prepared, {
			ok: true,
			values: {
				status: "backlog/docs",
				priority: 9,
				slug: "my-title",
				content: "Summary sentence. More detail.",
				frontmatter: {
					project: "docs",
					draft: true,
					count: 3,
					empty: null,
				},
			},
		});
	});

	it("derives a missing title on submit and reports validation errors", () => {
		const derived = prepareNewTicket({
			...initialNewTicketState(),
			body: "Fix the broken typo. Details.",
		});
		assert.deepEqual(derived, {
			ok: true,
			values: {
				status: "open",
				priority: 0,
				slug: "fix-the-broken-typo",
				content: "Fix the broken typo. Details.",
				frontmatter: {},
			},
		});

		const missingBody = prepareNewTicket({
			...initialNewTicketState(),
			title: "a-title",
		});
		assert.equal(missingBody.ok, false);
		if (!missingBody.ok) assert.match(missingBody.error, /body is required/i);

		const missingTitle = prepareNewTicket({
			...initialNewTicketState(),
			body: "Body.",
			titleTouched: true,
		});
		assert.equal(missingTitle.ok, false);
		if (!missingTitle.ok) assert.match(missingTitle.error, /title is required/i);

		const longTitle = prepareNewTicket({
			...initialNewTicketState(),
			title: "a".repeat(MAX_NEW_TICKET_TITLE_CHARS + 1),
			body: "Body.",
			titleTouched: true,
		});
		assert.equal(longTitle.ok, false);
		if (!longTitle.ok) assert.match(longTitle.error, /30 characters/);

		const badPriority = prepareNewTicket({
			...initialNewTicketState(),
			title: "a-title",
			body: "Body.",
			titleTouched: true,
			priority: "100",
		});
		assert.equal(badPriority.ok, false);
		if (!badPriority.ok) assert.match(badPriority.error, /priority/i);

		const badKey = prepareNewTicket({
			...initialNewTicketState(),
			title: "a-title",
			body: "Body.",
			titleTouched: true,
			frontmatter: [{ key: "bad key", value: "x" }],
		});
		assert.equal(badKey.ok, false);
		if (!badKey.ok) assert.match(badKey.error, /invalid frontmatter key/i);

		const duplicate = prepareNewTicket({
			...initialNewTicketState(),
			title: "a-title",
			body: "Body.",
			titleTouched: true,
			frontmatter: [
				{ key: "project", value: "one" },
				{ key: "project", value: "two" },
			],
		});
		assert.equal(duplicate.ok, false);
		if (!duplicate.ok) assert.match(duplicate.error, /duplicate frontmatter key/i);
	});
});
