/**
 * FIT-specific A2UI surfaces.
 *
 * These functions only map board data to the generic builder in a2ui.ts. They
 * emit plain JSON and never read or mutate the board themselves.
 */

import {
	A2uiSurface,
	type A2uiAction,
	type A2uiPanelAction,
	type A2uiPanelPayload,
} from "./a2ui.ts";
import {
	FIT_STATUS_ORDER,
	type BoardMode,
	type Ticket,
	type TicketSummary,
} from "./fit.ts";

export const BOARD_WORK_ACTION = "work-selected";
export const BOARD_MOVE_ACTION = "move-selected";
export const BOARD_NEW_ACTION = "new-ticket";
export const TICKET_COPY_ACTION = "copy-ticket";

const STATUS_LABELS: Record<string, string> = {
	in_progress: "In progress",
	open: "Open",
	backlog: "Backlog",
	closed: "Closed",
};

const FIT_STATUS_ORDER_SET = new Set<string>(FIT_STATUS_ORDER);
const BODY_MAX_CHARS = 8000;
const FRONTMATTER_MAX_CHARS = 1200;

export interface BoardSurfaceInput {
	board: string;
	mode: BoardMode;
	tickets: TicketSummary[];
	/** Board-wide counts, including tickets outside the display limit. */
	counts: Record<string, number>;
	/** Total visible count before the display limit, for the "showing" note. */
	listed: number;
	total: number;
	filter?: string;
	agentMode?: boolean;
	/** Ticket ids checked in the board list. */
	selected?: string[];
	autocommit?: boolean;
	/** Destination statuses selected in the bulk-move picker. */
	destination?: string[];
	error?: string;
	notice?: string;
}

export interface TicketSurfaceInput {
	board: string;
	mode: BoardMode;
	ticket: Ticket;
}

function clip(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	return `${chars.slice(0, maxChars).join("")}\n[... ${chars.length - maxChars} characters omitted]`;
}

function ticketTitle(ticket: TicketSummary): string {
	return ticket.title || ticket.displayName || "(no body)";
}

function ticketAction(name: string, ticketId?: string): A2uiAction {
	return {
		event: {
			name,
			...(ticketId ? { context: { ticketId } } : {}),
		},
	};
}

function isSelectableTicket(ticket: TicketSummary): boolean {
	return ticket.status === "open" || ticket.status === "backlog";
}

/** Read the checked ticket ids from a board Work action in board order. */
export function boardSelectedTicketIds(
	action: A2uiPanelAction,
	tickets: TicketSummary[],
): string[] {
	const selected: string[] = [];
	tickets.filter(isSelectableTicket).forEach((ticket, index) => {
		const value = action.context?.[`selected_${index}`];
		if (value === true || value === "true" || value === 1 || value === "1") {
			selected.push(ticket.id);
		}
	});
	return selected;
}

/** Read the destination status from a board Move action. */
export function boardSelectedDestination(
	action: A2uiPanelAction,
): string | undefined {
	const value = action.context?.destination;
	if (typeof value === "string") return value || undefined;
	if (Array.isArray(value)) {
		return value.find((item): item is string => typeof item === "string");
	}
	return undefined;
}

/** Read the board Work action's autocommit checkbox. */
export function boardAutocommit(action: A2uiPanelAction): boolean {
	const value = action.context?.autocommit;
	return value === true || value === "true" || value === 1 || value === "1";
}

function modeLabel(mode: BoardMode): string {
	return mode.mode === "strict"
		? `strict${mode.version ? ` ${mode.version}` : ""}`
		: "basic";
}

function statusOrder(tickets: TicketSummary[]): string[] {
	const extra = [...new Set(tickets.map((ticket) => ticket.status))].filter(
		(status) => !FIT_STATUS_ORDER_SET.has(status),
	);
	return [...FIT_STATUS_ORDER, ...extra];
}

function countsText(counts: Record<string, number>): string {
	const extra = Object.keys(counts).filter(
		(status) => !FIT_STATUS_ORDER_SET.has(status),
	);
	return [...FIT_STATUS_ORDER, ...extra]
		.filter((status) => (counts[status] ?? 0) > 0)
		.map((status) => `${status} ${counts[status]}`)
		.join(" · ");
}

/**
 * One board surface: a header, per-status tabs, a card per ticket with View,
 * Start, and Close actions, and a footer with Refresh and Close.
 */
export function buildBoardSurface(input: BoardSurfaceInput): A2uiPanelPayload {
	const selectable = input.tickets.filter(isSelectableTicket);
	const selectedIds = new Set(input.selected ?? []);
	const selectionIndex = new Map(
		selectable.map((ticket, index) => [ticket.id, index] as const),
	);
	const surface = new A2uiSurface({
		surfaceId: "fit_board",
		title: "FIT board",
		sendDataModel: true,
		dataModel: {
			selected: selectable.map((ticket) => selectedIds.has(ticket.id)),
			autocommit: input.autocommit === true,
			destination: input.destination ?? [],
		},
	});
	const rootChildren = ["title", "meta", "new_bar", "tabs"];
	if (input.error) rootChildren.push("error");
	if (input.notice) rootChildren.push("notice");
	rootChildren.push("work_bar");
	if (selectable.length > 0) rootChildren.push("move_bar");
	rootChildren.push("footer");

	const meta = [
		`Board: ${input.board}`,
		`Mode: ${modeLabel(input.mode)}`,
		`Tickets: ${input.total} total${countsText(input.counts) ? ` (${countsText(input.counts)})` : ""}`,
		input.filter ? `Filter: ${input.filter}` : "",
		input.agentMode ? "Planner mode: on (FIT-only)" : "",
		input.listed < input.total ? `Showing ${input.listed} of ${input.total}` : "",
	]
		.filter(Boolean)
		.join(" · ");

	surface.column("root", rootChildren);
	surface.text("title", "FIT board");
	surface.text("meta", meta, { variant: "caption" });
	surface.button(
		"new_ticket",
		"New ticket",
		ticketAction(BOARD_NEW_ACTION),
		{ variant: "primary" },
	);
	surface.row("new_bar", ["new_ticket"], { justify: "end" });

	const grouped = new Map<string, TicketSummary[]>();
	for (const ticket of input.tickets) {
		const group = grouped.get(ticket.status);
		if (group) group.push(ticket);
		else grouped.set(ticket.status, [ticket]);
	}

	const tabs: Array<{ title: string; child: string }> = [];
	let tabIndex = 0;
	for (const status of statusOrder(input.tickets)) {
		const tickets = grouped.get(status);
		if (!tickets?.length) continue;
		const columnId = `status_${tabIndex}`;
		const cardIds: string[] = [];

		tickets.forEach((ticket, ticketIndex) => {
			const prefix = `ticket_${tabIndex}_${ticketIndex}`;
			const idText = `${prefix}_id`;
			const titleText = `${prefix}_title`;
			const actionsId = `${prefix}_actions`;
			const bodyId = `${prefix}_body`;
			const cardId = `${prefix}_card`;
			const actionIds: string[] = [];
			const cardChildren: string[] = [];

			const selectIndex = selectionIndex.get(ticket.id);
			if (selectIndex !== undefined) {
				const selectId = `${prefix}_select`;
				surface.add({
					id: selectId,
					component: "CheckBox",
					label: "Select",
					value: { "@path": `/selected/${selectIndex}` },
				});
				cardChildren.push(selectId);
			}

			const label = ticket.project ? `${ticket.id}  [${ticket.project}]` : ticket.id;
			surface.text(idText, label, { variant: "caption" });
			surface.text(titleText, ticketTitle(ticket));

			surface.button(`${prefix}_view`, "View", ticketAction("show", ticket.id), {
				variant: "borderless",
			});
			actionIds.push(`${prefix}_view`);
			if (ticket.status !== "closed") {
				surface.button(`${prefix}_start`, "Start", ticketAction("start", ticket.id), {
					variant: "primary",
				});
				surface.button(`${prefix}_close`, "Close ticket", ticketAction("close", ticket.id), {
					variant: "borderless",
				});
				actionIds.push(`${prefix}_start`, `${prefix}_close`);
			}

			surface.row(actionsId, actionIds, { justify: "end" });
			surface.column(bodyId, [...cardChildren, idText, titleText, actionsId]);
			surface.card(cardId, bodyId);
			cardIds.push(cardId);
		});

		surface.column(columnId, cardIds);
		tabs.push({ title: STATUS_LABELS[status] ?? status, child: columnId });
		tabIndex += 1;
	}

	if (tabs.length > 0) {
		surface.tabs("tabs", tabs);
	} else {
		// The root still lists "tabs" for a stable shape; an empty board uses a
		// Text component under that id instead of a Tabs component.
		surface.text("tabs", input.total === 0 ? "No tickets yet." : "No tickets match this view.");
	}

	if (input.error) {
		surface.text("error", input.error, { variant: "caption" });
	}
	if (input.notice) {
		surface.text("notice", input.notice, { variant: "caption" });
	}

	const selectedContext: Record<string, unknown> = {};
	selectable.forEach((_ticket, index) => {
		selectedContext[`selected_${index}`] = { "@path": `/selected/${index}` };
	});
	surface.add({
		id: "autocommit",
		component: "CheckBox",
		label: "Autocommit",
		value: { "@path": "/autocommit" },
	});
	surface.button(
		"work",
		"Work selected",
		{
			event: {
				name: BOARD_WORK_ACTION,
				context: {
					autocommit: { "@path": "/autocommit" },
					...selectedContext,
				},
			},
		},
		{ variant: "primary" },
	);
	surface.row("work_bar", ["autocommit", "work"], { justify: "end" });

	if (selectable.length > 0) {
		surface.choicePicker("destination", {
			label: "Move selected to",
			displayStyle: "chips",
			options: FIT_STATUS_ORDER.map((status) => ({
				label: STATUS_LABELS[status] ?? status,
				value: status,
			})),
			value: { "@path": "/destination" },
		});
		surface.button(
			"move",
			"Move selected",
			{
				event: {
					name: BOARD_MOVE_ACTION,
					context: {
						destination: { "@path": "/destination" },
						...selectedContext,
					},
				},
			},
			{ variant: "default" },
		);
		surface.row("move_bar", ["destination", "move"], { justify: "end" });
	}

	surface.button("refresh", "Refresh", ticketAction("refresh"), { variant: "borderless" });
	surface.button("cancel", "Close panel", ticketAction("cancel"), { variant: "borderless" });
	surface.row("footer", ["refresh", "cancel"], { justify: "end" });

	return surface.build();
}

/** One ticket surface: metadata, optional frontmatter, body, and actions. */
export function buildTicketSurface(input: TicketSurfaceInput): A2uiPanelPayload {
	const { ticket } = input;
	const surface = new A2uiSurface({ surfaceId: "fit_ticket", title: ticket.id });
	const rootChildren = ["title", "meta"];
	if (ticket.frontmatterRaw?.trim()) rootChildren.push("frontmatter");
	rootChildren.push("divider", "body", "actions");

	const meta = [
		ticket.id,
		`status: ${ticket.status}${ticket.subdir ? ` (${ticket.subdir})` : ""}`,
		`priority: ${ticket.priority ?? "none"}`,
		`project: ${ticket.project ?? "none"}`,
		`revision: ${ticket.revision}`,
		`board: ${input.board}`,
		`mode: ${modeLabel(input.mode)}`,
	].join(" · ");

	surface.column("root", rootChildren);
	surface.text("title", ticketTitle(ticket));
	surface.text("meta", meta, { variant: "caption" });
	if (ticket.frontmatterRaw?.trim()) {
		surface.text("frontmatter", clip(ticket.frontmatterRaw.trim(), FRONTMATTER_MAX_CHARS), {
			variant: "caption",
		});
	}
	surface.divider("divider");
	surface.text(
		"body",
		ticket.body.trim() ? clip(ticket.body.trim(), BODY_MAX_CHARS) : "(no body)",
	);

	const actionIds: string[] = [];
	if (ticket.status !== "closed") {
		surface.button("start", ticket.status === "in_progress" ? "Work on this" : "Start", ticketAction("start", ticket.id), {
			variant: "primary",
		});
		surface.button("close", "Close ticket", ticketAction("close", ticket.id), {
			variant: "borderless",
		});
		actionIds.push("start", "close");
	}
	surface.button(
		"copy",
		"New from copy",
		ticketAction(TICKET_COPY_ACTION, ticket.id),
		{ variant: "borderless" },
	);
	surface.button("board", "Board", ticketAction("board"), { variant: "borderless" });
	surface.button("cancel", "Close", ticketAction("cancel"), { variant: "borderless" });
	actionIds.push("copy", "board", "cancel");
	surface.row("actions", actionIds, { justify: "end" });

	return surface.build();
}
