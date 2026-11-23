import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	A2UI_MODE,
	A2UI_VERSION,
	A2uiSurface,
	BASIC_CATALOG_ID,
	actionContextString,
	parseA2uiAction,
	requestA2uiAction,
} from "../src/a2ui.ts";

describe("A2uiSurface", () => {
	it("builds one v1.0 createSurface with the Basic catalog", () => {
		const payload = new A2uiSurface({ surfaceId: "demo", title: "Demo" })
			.column("root", ["title", "actions"])
			.text("title", "Hello")
			.button("ok", "OK", { event: { name: "ok", context: { value: "yes" } } }, { variant: "primary" })
			.row("actions", ["ok"], { justify: "end" })
			.build();

		assert.equal(payload.mode, A2UI_MODE);
		assert.equal(payload.surfaceId, "demo");
		assert.equal(payload.title, "Demo");
		assert.equal(payload.messages.length, 1);
		const create = payload.messages[0]?.createSurface;
		assert.equal(payload.messages[0]?.version, A2UI_VERSION);
		assert.equal(create?.surfaceId, "demo");
		assert.equal(create?.catalogId, BASIC_CATALOG_ID);
		assert.equal(create?.sendDataModel, false);
		assert.equal(create?.dataModel, undefined);
		assert.deepEqual(
			create?.components.map((component) => component.id),
			["root", "title", "ok_label", "ok", "actions"],
		);
	});

	it("passes data model options and rejects duplicate ids", () => {
		const payload = new A2uiSurface({
			surfaceId: "demo",
			title: "Demo",
			sendDataModel: true,
			dataModel: { value: "x" },
			catalogId: "custom",
		})
			.text("root", "Root")
			.build();
		assert.equal(payload.messages[0]?.createSurface.catalogId, "custom");
		assert.equal(payload.messages[0]?.createSurface.sendDataModel, true);
		assert.deepEqual(payload.messages[0]?.createSurface.dataModel, { value: "x" });

		const surface = new A2uiSurface({ surfaceId: "demo", title: "Demo" }).text("same", "One");
		assert.throws(() => surface.text("same", "Two"), /Duplicate A2UI component id: same/);
	});

	it("builds a data-bound ChoicePicker from the Basic catalog", () => {
		const payload = new A2uiSurface({
			surfaceId: "demo",
			title: "Demo",
			sendDataModel: true,
			dataModel: { destination: ["open"] },
		})
			.choicePicker("destination", {
				label: "Move selected to",
				displayStyle: "chips",
				options: [
					{ label: "Open", value: "open" },
					{ label: "Closed", value: "closed" },
				],
				value: { "@path": "/destination" },
			})
			.build();
		assert.deepEqual(payload.messages[0]?.createSurface.components[0], {
			id: "destination",
			component: "ChoicePicker",
			label: "Move selected to",
			variant: "mutuallyExclusive",
			displayStyle: "chips",
			options: [
				{ label: "Open", value: "open" },
				{ label: "Closed", value: "closed" },
			],
			value: { "@path": "/destination" },
		});
	});

	it("refuses an empty surface", () => {
		assert.throws(
			() => new A2uiSurface({ surfaceId: "demo", title: "Demo" }).build(),
			/needs at least one component/,
		);
	});
});

describe("A2UI panel transport", () => {
	it("parses action strings and objects, and rejects unreadable values", () => {
		assert.deepEqual(parseA2uiAction('{"name":"show","context":{"ticketId":"open/00-a.md"}}'), {
			name: "show",
			context: { ticketId: "open/00-a.md" },
		});
		assert.deepEqual(parseA2uiAction({ name: "refresh", context: { n: 1 } }), {
			name: "refresh",
			context: { n: 1 },
		});
		assert.equal(parseA2uiAction("not json"), undefined);
		assert.equal(parseA2uiAction({ name: "" }), undefined);
		assert.equal(parseA2uiAction({ name: "x", context: [] }), undefined);
		assert.equal(parseA2uiAction({ cancelled: true }), undefined);
	});

	it("reads string context values only", () => {
		const action = parseA2uiAction({ name: "show", context: { ticketId: "open/00-a.md", n: 1 } });
		assert.ok(action);
		assert.equal(actionContextString(action, "ticketId"), "open/00-a.md");
		assert.equal(actionContextString(action, "n"), undefined);
		assert.equal(actionContextString(action, "missing"), undefined);
	});

	it("adapts a host panel, a missing panel, dismissal, and errors", async () => {
		const payload = new A2uiSurface({ surfaceId: "demo", title: "Demo" })
			.text("root", "Root")
			.build();

		const action = await requestA2uiAction(
			{ panel: async () => ({ name: "show", context: { ticketId: "open/00-a.md" } }) },
			payload,
		);
		assert.equal(action.kind, "action");
		if (action.kind === "action") {
			assert.equal(actionContextString(action.action, "ticketId"), "open/00-a.md");
		}

		assert.deepEqual(await requestA2uiAction({}, payload), { kind: "unavailable" });
		assert.deepEqual(
			await requestA2uiAction({ panel: async () => ({ cancelled: true }) }, payload),
			{ kind: "cancelled" },
		);
		assert.deepEqual(await requestA2uiAction({ panel: async () => undefined }, payload), {
			kind: "cancelled",
		});

		const failed = await requestA2uiAction(
			{
				panel: async () => {
					throw new Error("boom");
				},
			},
			payload,
		);
		assert.deepEqual(failed, { kind: "error", error: "boom" });

		const unreadable = await requestA2uiAction({ panel: async () => "nope" }, payload);
		assert.equal(unreadable.kind, "error");
	});
});
