/**
 * Generic A2UI v1.0 surface builder and panel transport.
 *
 * This module knows nothing about FIT. It builds plain JSON for the Basic
 * catalog and adapts a host's optional `ui.panel(payload)` bridge, so a surface
 * consumer can render or replace it without importing an A2UI runtime.
 */

export const A2UI_MODE = "a2ui";
export const A2UI_VERSION = "1.0";
/** v1.0 Basic catalog id, fixed by the renderer contract. */
export const BASIC_CATALOG_ID =
	"https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

export type DynamicString = string | { "@path": string };
export type DynamicStringList = string[] | { "@path": string };

export interface A2uiComponent {
	id: string;
	component: string;
	[key: string]: unknown;
}

export interface A2uiAction {
	event: {
		name: string;
		context?: Record<string, unknown>;
	};
}

export interface CreateSurfaceMessage {
	version: typeof A2UI_VERSION;
	createSurface: {
		surfaceId: string;
		catalogId: string;
		sendDataModel: boolean;
		dataModel?: Record<string, unknown>;
		components: A2uiComponent[];
	};
}

export interface A2uiPanelPayload {
	title: string;
	mode: typeof A2UI_MODE;
	surfaceId: string;
	messages: CreateSurfaceMessage[];
}

export interface A2uiPanelOptions {
	timeout?: number;
	signal?: AbortSignal;
}

export type A2uiPanelFn = (
	payload: A2uiPanelPayload,
	options?: A2uiPanelOptions,
) => Promise<unknown>;

export interface A2uiPanelAction {
	name: string;
	context?: Record<string, unknown>;
	[key: string]: unknown;
}

export type A2uiPanelOutcome =
	| { kind: "action"; action: A2uiPanelAction }
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "error"; error: string };

export interface SurfaceOptions {
	surfaceId: string;
	title: string;
	catalogId?: string;
	sendDataModel?: boolean;
	dataModel?: Record<string, unknown>;
}

export interface TextOptions {
	variant?: "caption" | "body";
}

export interface RowOptions {
	justify?: "center" | "end" | "spaceAround" | "spaceBetween" | "spaceEvenly" | "start" | "stretch";
	align?: "start" | "center" | "end" | "stretch";
}

export interface ColumnOptions extends RowOptions {}

export interface ListOptions {
	direction?: "vertical" | "horizontal";
	align?: "start" | "center" | "end" | "stretch";
}

export interface ButtonOptions {
	variant?: "default" | "primary" | "borderless";
	labelId?: string;
	labelVariant?: "caption" | "body";
}

export interface ChoicePickerOptions {
	label?: DynamicString;
	variant?: "multipleSelection" | "mutuallyExclusive";
	displayStyle?: "checkbox" | "chips";
	filterable?: boolean;
	options: Array<{ label: DynamicString; value: string }>;
	value: DynamicStringList;
}

/**
 * Build one v1.0 surface with unique component ids. Unknown components are
 * deliberately not supported: a renderer should only see the Basic catalog.
 */
export class A2uiSurface {
	private readonly components: A2uiComponent[] = [];
	private readonly ids = new Set<string>();
	private readonly options: SurfaceOptions;

	constructor(options: SurfaceOptions) {
		this.options = options;
	}

	add(...components: A2uiComponent[]): this {
		for (const component of components) {
			if (!component.id) throw new Error("A2UI component needs an id");
			if (this.ids.has(component.id)) {
				throw new Error(`Duplicate A2UI component id: ${component.id}`);
			}
			this.ids.add(component.id);
			this.components.push(component);
		}
		return this;
	}

	text(id: string, text: DynamicString, options: TextOptions = {}): this {
		return this.add({
			id,
			component: "Text",
			text,
			variant: options.variant ?? "body",
		});
	}

	button(
		id: string,
		label: string,
		action: A2uiAction,
		options: ButtonOptions = {},
	): this {
		const labelId = options.labelId ?? `${id}_label`;
		this.text(labelId, label, { variant: options.labelVariant ?? "body" });
		return this.add({
			id,
			component: "Button",
			child: labelId,
			variant: options.variant ?? "default",
			action,
		});
	}

	choicePicker(id: string, options: ChoicePickerOptions): this {
		return this.add({
			id,
			component: "ChoicePicker",
			...(options.label ? { label: options.label } : {}),
			variant: options.variant ?? "mutuallyExclusive",
			displayStyle: options.displayStyle ?? "checkbox",
			...(options.filterable !== undefined ? { filterable: options.filterable } : {}),
			options: options.options,
			value: options.value,
		});
	}

	row(id: string, children: string[], options: RowOptions = {}): this {
		return this.add({
			id,
			component: "Row",
			children,
			...(options.justify ? { justify: options.justify } : {}),
			...(options.align ? { align: options.align } : {}),
		});
	}

	column(id: string, children: string[], options: ColumnOptions = {}): this {
		return this.add({
			id,
			component: "Column",
			children,
			...(options.justify ? { justify: options.justify } : {}),
			...(options.align ? { align: options.align } : {}),
		});
	}

	list(id: string, children: string[], options: ListOptions = {}): this {
		return this.add({
			id,
			component: "List",
			children,
			...(options.direction ? { direction: options.direction } : {}),
			...(options.align ? { align: options.align } : {}),
		});
	}

	card(id: string, child: string): this {
		return this.add({ id, component: "Card", child });
	}

	divider(id: string, axis: "horizontal" | "vertical" = "horizontal"): this {
		return this.add({ id, component: "Divider", axis });
	}

	tabs(id: string, tabs: Array<{ title: DynamicString; child: string }>): this {
		return this.add({ id, component: "Tabs", tabs });
	}

	build(): A2uiPanelPayload {
		if (this.components.length === 0) {
			throw new Error("A2UI surface needs at least one component");
		}
		const create: CreateSurfaceMessage["createSurface"] = {
			surfaceId: this.options.surfaceId,
			catalogId: this.options.catalogId ?? BASIC_CATALOG_ID,
			sendDataModel: this.options.sendDataModel ?? false,
			...(this.options.dataModel ? { dataModel: this.options.dataModel } : {}),
			components: [...this.components],
		};
		return {
			title: this.options.title,
			mode: A2UI_MODE,
			surfaceId: this.options.surfaceId,
			messages: [{ version: A2UI_VERSION, createSurface: create }],
		};
	}
}

/** Return the host's panel bridge when it exposes one. */
export function panelFor(ui: unknown): A2uiPanelFn | undefined {
	if (!ui || typeof ui !== "object") return undefined;
	const panel = (ui as { panel?: unknown }).panel;
	return typeof panel === "function" ? (panel.bind(ui) as A2uiPanelFn) : undefined;
}

export function parseA2uiAction(raw: unknown): A2uiPanelAction | undefined {
	let value = raw;
	if (typeof value === "string") {
		if (!value.trim()) return undefined;
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.cancelled === true) return undefined;
	if (typeof record.name !== "string" || !record.name.trim()) return undefined;
	const context = record.context;
	if (
		context !== undefined &&
		(context === null || typeof context !== "object" || Array.isArray(context))
	) {
		return undefined;
	}
	return {
		...record,
		name: record.name,
		...(context ? { context: context as Record<string, unknown> } : {}),
	};
}

/** Read one string value from an action context. */
export function actionContextString(
	action: A2uiPanelAction,
	key: string,
): string | undefined {
	const value = action.context?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Send a surface and decode the host's action. A missing answer is a dismissal;
 * a thrown or unreadable answer is reported so the caller can fall back.
 */
export async function requestA2uiAction(
	ui: unknown,
	payload: A2uiPanelPayload,
	options?: A2uiPanelOptions,
): Promise<A2uiPanelOutcome> {
	const panel = panelFor(ui);
	if (!panel) return { kind: "unavailable" };
	let raw: unknown;
	try {
		raw = await panel(payload, options);
	} catch (error) {
		return {
			kind: "error",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (raw === undefined || raw === null) return { kind: "cancelled" };
	if (typeof raw === "object" && (raw as { cancelled?: unknown }).cancelled === true) {
		return { kind: "cancelled" };
	}
	const action = parseA2uiAction(raw);
	if (!action) return { kind: "error", error: "The panel returned an unreadable action." };
	return { kind: "action", action };
}
