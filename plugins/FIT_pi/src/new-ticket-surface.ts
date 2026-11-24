/**
 * FIT new-ticket form surface.
 *
 * The form owns presentation state only. It emits an A2UI surface, folds panel
 * actions back into a normalized state, and prepares the same inputs the
 * `fit_new` tool and `/fit new` command already use. Board writes still happen
 * through createTicket.
 */

import {
	A2uiSurface,
	type A2uiAction,
	type A2uiPanelAction,
	type A2uiPanelPayload,
} from "./a2ui.ts";
import {
	MAX_PRIORITY,
	deriveTicketName,
	type BoardMode,
	type FrontmatterValue,
	type Ticket,
} from "./fit.ts";

/** Matches the FIT short-name limit used by createTicket. */
export const MAX_NEW_TICKET_TITLE_CHARS = 30;

/** Live title input may use letters in any case, digits, spaces, and hyphens. */
export const NEW_TICKET_TITLE_PATTERN = "^[A-Za-z0-9 -]*$";

const FRONTMATTER_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export const NEW_TICKET_ADD_ROW = "add-frontmatter-row";
export const NEW_TICKET_REMOVE_ROW = "remove-frontmatter-row";
export const NEW_TICKET_SUBMIT = "submit-new-ticket";
export const NEW_TICKET_CANCEL = "cancel-new-ticket";

export interface NewTicketFrontmatterRow {
	key: string;
	value: string;
}

export interface NewTicketFormState {
	status: "open" | "backlog";
	subdir: string;
	priority: string;
	title: string;
	body: string;
	/** True once the user edits the title; body edits no longer replace it. */
	titleTouched: boolean;
	frontmatter: NewTicketFrontmatterRow[];
	error?: string;
}

export interface NewTicketSurfaceInput {
	board: string;
	mode: BoardMode;
	state: NewTicketFormState;
}

export type NewTicketActionKind =
	| "add-row"
	| "remove-row"
	| "submit"
	| "cancel"
	| "unknown";

export interface ParsedNewTicketAction {
	kind: NewTicketActionKind;
	rowIndex?: number;
}

export interface NewTicketValues {
	status: string;
	priority: number;
	slug: string;
	content: string;
	frontmatter: Record<string, FrontmatterValue>;
}

export type PrepareNewTicketResult =
	| { ok: true; values: NewTicketValues }
	| { ok: false; error: string };

export function initialNewTicketState(): NewTicketFormState {
	return {
		status: "open",
		subdir: "",
		priority: "0",
		title: "",
		body: "",
		titleTouched: false,
		frontmatter: [],
	};
}

function frontmatterValueText(value: FrontmatterValue): string {
	if (Array.isArray(value)) return JSON.stringify(value);
	if (value === null) return "null";
	return String(value);
}

/**
 * Start a copied-ticket form from an existing ticket. Everything except the
 * title is prefilled; the title stays derived from the copied body so the user
 * can make it unique before creating the new ticket.
 */
export function initialNewTicketStateFromTicket(
	ticket: Ticket,
): NewTicketFormState {
	return {
		...initialNewTicketState(),
		status: ticket.status === "backlog" ? "backlog" : "open",
		subdir: ticket.subdir,
		priority: String(ticket.priority ?? 0),
		body: ticket.body,
		frontmatter: Object.entries(ticket.frontmatter).map(([key, value]) => ({
			key,
			value: frontmatterValueText(value),
		})),
	};
}

/** Lowercase and hyphenate a title without truncating it. */
export function normalizeNewTicketTitle(value: string): string {
	const normalized = value.normalize("NFKC").toLowerCase();
	return normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function titleFromBody(body: string): string {
	const derived = normalizeNewTicketTitle(deriveTicketName(body));
	return derived || (body.trim() ? "ticket" : "");
}

/** Return state with the title normalized for redisplay after a failed save. */
export function normalizedNewTicketTitleState(
	state: NewTicketFormState,
): NewTicketFormState {
	const title = state.titleTouched
		? normalizeNewTicketTitle(state.title)
		: titleFromBody(state.body) || normalizeNewTicketTitle(state.title);
	return title === state.title ? state : { ...state, title };
}

function contextString(
	action: A2uiPanelAction,
	key: string,
	fallback: string,
): string {
	const value = action.context?.[key];
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

function contextChoice(
	action: A2uiPanelAction,
	key: string,
	fallback: string,
): string {
	const value = action.context?.[key];
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return fallback;
}

function contextIndex(action: A2uiPanelAction): number | undefined {
	const value = action.context?.rowIndex;
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	return undefined;
}

export function parseNewTicketAction(
	action: A2uiPanelAction,
): ParsedNewTicketAction {
	if (action.name === NEW_TICKET_ADD_ROW) return { kind: "add-row" };
	if (action.name === NEW_TICKET_REMOVE_ROW) {
		const rowIndex = contextIndex(action);
		return rowIndex === undefined
			? { kind: "unknown" }
			: { kind: "remove-row", rowIndex };
	}
	if (action.name === NEW_TICKET_SUBMIT) return { kind: "submit" };
	if (action.name === NEW_TICKET_CANCEL) return { kind: "cancel" };
	return { kind: "unknown" };
}

/**
 * Fold every field and row carried by an action back into the form state.
 * The title is derived from the body until the user edits it, then it stays.
 */
export function applyNewTicketFormAction(
	state: NewTicketFormState,
	action: A2uiPanelAction,
): NewTicketFormState {
	const parsed = parseNewTicketAction(action);
	if (parsed.kind === "cancel" || parsed.kind === "unknown") return state;

	const frontmatter = state.frontmatter.map((row, index) => ({
		key: contextString(action, `fmKey${index}`, row.key),
		value: contextString(action, `fmValue${index}`, row.value),
	}));
	const rawStatus = contextChoice(action, "status", state.status);
	const status = rawStatus === "backlog" ? "backlog" : "open";
	const body = contextString(action, "body", state.body);
	let title = contextString(action, "title", state.title);
	let titleTouched = state.titleTouched;

	if (!titleTouched) {
		if (title !== state.title) {
			// The user changed the title before this action, so stop following body.
			titleTouched = true;
		} else {
			title = titleFromBody(body);
		}
	}

	const next: NewTicketFormState = {
		...state,
		status,
		subdir: contextString(action, "subdir", state.subdir),
		priority: contextString(action, "priority", state.priority),
		title,
		body,
		titleTouched,
		frontmatter,
		error: undefined,
	};

	if (parsed.kind === "add-row") {
		next.frontmatter = [...frontmatter, { key: "", value: "" }];
	} else if (parsed.kind === "remove-row" && parsed.rowIndex !== undefined) {
		if (parsed.rowIndex < frontmatter.length) {
			next.frontmatter = frontmatter.filter(
				(_row, index) => index !== parsed.rowIndex,
			);
		}
	}
	return next;
}

function inferFrontmatterValue(text: string): FrontmatterValue {
	const value = text.trim();
	if (value === "" || value === "~" || value.toLowerCase() === "null") return null;
	if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith("[") && value.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (
				Array.isArray(parsed) &&
				parsed.every(
					(item) =>
						item === null ||
						["string", "number", "boolean"].includes(typeof item),
				)
			) {
				return parsed as FrontmatterValue;
			}
		} catch {
			// Not JSON; keep the text so the user can correct it.
		}
	}
	return value;
}

function parseFrontmatterRows(
	rows: NewTicketFrontmatterRow[],
): { frontmatter: Record<string, FrontmatterValue> } | { error: string } {
	const frontmatter: Record<string, FrontmatterValue> = {};
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const key = row.key.trim();
		if (!key) {
			if (row.value.trim()) {
				return { error: `Frontmatter row ${index + 1} needs a key.` };
			}
			continue;
		}
		if (!FRONTMATTER_KEY_RE.test(key)) {
			return {
				error: `Invalid frontmatter key on row ${index + 1}: ${JSON.stringify(key)}.`,
			};
		}
		if (seen.has(key)) {
			return { error: `Duplicate frontmatter key: ${key}.` };
		}
		seen.add(key);
		frontmatter[key] = inferFrontmatterValue(row.value);
	}
	return { frontmatter };
}

/** Validate the form and turn it into createTicket inputs. */
export function prepareNewTicket(
	state: NewTicketFormState,
): PrepareNewTicketResult {
	const body = state.body;
	if (!body.trim()) return { ok: false, error: "Ticket body is required." };

	const derivedTitle = state.titleTouched
		? state.title
		: titleFromBody(body) || state.title;
	const slug = normalizeNewTicketTitle(derivedTitle);
	if (!slug) return { ok: false, error: "Ticket title is required." };
	if (Array.from(slug).length > MAX_NEW_TICKET_TITLE_CHARS) {
		return {
			ok: false,
			error: `Title must be ${MAX_NEW_TICKET_TITLE_CHARS} characters or fewer.`,
		};
	}

	const priorityText = state.priority.trim() || "0";
	if (!/^\d{1,2}$/.test(priorityText)) {
		return {
			ok: false,
			error: `Priority must be an integer between 0 and ${MAX_PRIORITY}.`,
		};
	}
	const priority = Number(priorityText);
	if (priority < 0 || priority > MAX_PRIORITY) {
		return {
			ok: false,
			error: `Priority must be an integer between 0 and ${MAX_PRIORITY}.`,
		};
	}

	const subdir = state.subdir.trim().replace(/^\/+|\/+$/g, "");
	const status = subdir
		? `${state.status}/${subdir.split("/").filter(Boolean).join("/")}`
		: state.status;

	const parsedFrontmatter = parseFrontmatterRows(state.frontmatter);
	if ("error" in parsedFrontmatter) {
		return { ok: false, error: parsedFrontmatter.error };
	}

	return {
		ok: true,
		values: {
			status,
			priority,
			slug,
			content: body,
			frontmatter: parsedFrontmatter.frontmatter,
		},
	};
}

function formContext(
	state: NewTicketFormState,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const context: Record<string, unknown> = {
		status: { "@path": "/status" },
		subdir: { "@path": "/subdir" },
		priority: { "@path": "/priority" },
		title: { "@path": "/title" },
		body: { "@path": "/body" },
		...extra,
	};
	state.frontmatter.forEach((_row, index) => {
		context[`fmKey${index}`] = { "@path": `/frontmatter/${index}/key` };
		context[`fmValue${index}`] = { "@path": `/frontmatter/${index}/value` };
	});
	return context;
}

function action(
	name: string,
	context: Record<string, unknown>,
): A2uiAction {
	return { event: { name, context } };
}

function modeLabel(mode: BoardMode): string {
	return mode.mode === "strict"
		? `strict${mode.version ? ` ${mode.version}` : ""}`
		: "basic";
}

function addTextField(
	surface: A2uiSurface,
	id: string,
	label: string,
	path: string,
	options: {
		variant?: "shortText" | "longText" | "number" | "obscured";
		placeholder?: string;
		checks?: Array<Record<string, unknown>>;
	} = {},
): void {
	surface.add({
		id,
		component: "TextField",
		label,
		value: { "@path": path },
		variant: options.variant ?? "shortText",
		...(options.placeholder ? { placeholder: options.placeholder } : {}),
		...(options.checks ? { checks: options.checks } : {}),
	});
}

/**
 * Build the new-ticket form. Frontmatter starts empty; Add row appends a pair
 * and each pair has a remove button. Text fields bind to the surface data model.
 */
export function buildNewTicketSurface(
	input: NewTicketSurfaceInput,
): A2uiPanelPayload {
	const { state } = input;
	const surface = new A2uiSurface({
		surfaceId: "fit_new_ticket",
		title: "New FIT ticket",
		sendDataModel: true,
		dataModel: {
			status: state.status,
			subdir: state.subdir,
			priority: state.priority,
			title: state.title,
			body: state.body,
			frontmatter: state.frontmatter.map((row) => ({ ...row })),
		},
	});

	const rootChildren = [
		"heading",
		"meta",
		"status",
		"subdir",
		"priority",
		"title",
		"body",
		"frontmatter_divider",
		"frontmatter_heading",
		"frontmatter_rows",
		"add_row",
	];
	if (state.error) rootChildren.push("error");
	rootChildren.push("footer");
	surface.column("root", rootChildren);
	surface.text("heading", "New FIT ticket");
	surface.text(
		"meta",
		`Board: ${input.board} · Mode: ${modeLabel(input.mode)} · New tickets start in open or backlog`,
		{ variant: "caption" },
	);

	surface.add({
		id: "status",
		component: "ChoicePicker",
		label: "Status",
		variant: "mutuallyExclusive",
		displayStyle: "chips",
		options: [
			{ label: "Open", value: "open" },
			{ label: "Backlog", value: "backlog" },
		],
		value: { "@path": "/status" },
	});
	addTextField(surface, "subdir", "Subdirectory (optional)", "/subdir", {
		placeholder: "project-x",
	});
	addTextField(surface, "priority", "Priority (00-99)", "/priority", {
		variant: "number",
		placeholder: "0",
	});
	addTextField(surface, "title", "Title (slug)", "/title", {
		placeholder: "lowercase-hyphenated-title",
		checks: [
			{
				condition: {
					"@call": "regex",
					args: {
						value: { "@path": "/title" },
						pattern: NEW_TICKET_TITLE_PATTERN,
					},
				},
				message: "Use letters, digits, spaces, and hyphens.",
			},
			{
				condition: {
					"@call": "length",
					args: { value: { "@path": "/title" }, max: MAX_NEW_TICKET_TITLE_CHARS },
				},
				message: `Title must be ${MAX_NEW_TICKET_TITLE_CHARS} characters or fewer.`,
			},
		],
	});
	addTextField(surface, "body", "Body", "/body", {
		variant: "longText",
		placeholder: "1-3 sentence summary, then ### sections",
		checks: [
			{
				condition: {
					"@call": "required",
					args: { value: { "@path": "/body" } },
				},
				message: "Body is required.",
			},
		],
	});

	surface.divider("frontmatter_divider");
	surface.text("frontmatter_heading", "Frontmatter", { variant: "caption" });

	const rowChildren: string[] = [];
	state.frontmatter.forEach((_row, index) => {
		const keyId = `fm_${index}_key`;
		const valueId = `fm_${index}_value`;
		const removeId = `fm_${index}_remove`;
		const rowId = `fm_${index}_row`;
		addTextField(surface, keyId, "Key", `/frontmatter/${index}/key`);
		addTextField(surface, valueId, "Value", `/frontmatter/${index}/value`);
		surface.button(
			removeId,
			"x",
			action(NEW_TICKET_REMOVE_ROW, {
				...formContext(state, { rowIndex: index }),
			}),
			{ variant: "borderless" },
		);
		surface.row(rowId, [keyId, valueId, removeId], { align: "end" });
		rowChildren.push(rowId);
	});
	if (rowChildren.length > 0) {
		surface.column("frontmatter_rows", rowChildren);
	} else {
		surface.text("frontmatter_rows", "No frontmatter yet.", { variant: "caption" });
	}

	surface.button(
		"add_row",
		"Add row",
		action(NEW_TICKET_ADD_ROW, formContext(state)),
		{ variant: "borderless" },
	);

	if (state.error) surface.text("error", state.error, { variant: "caption" });

	surface.button(
		"create",
		"Create ticket",
		action(NEW_TICKET_SUBMIT, formContext(state)),
		{ variant: "primary" },
	);
	surface.button(
		"cancel",
		"Cancel",
		action(NEW_TICKET_CANCEL, {}),
		{ variant: "borderless" },
	);
	surface.row("footer", ["create", "cancel"], { justify: "end" });

	return surface.build();
}
