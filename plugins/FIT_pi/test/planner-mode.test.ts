import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.ts";
import { createTicket, initBoard, moveTicket } from "../src/fit.ts";
import { DEFERRED_TICKET_PLANNER_REMINDER, LATE_AGENT_MODE_REMINDER } from "../src/prompt.ts";

const roots: string[] = [];
const originalPlanEnv = process.env.FIT_PLAN;

afterEach(async () => {
	if (originalPlanEnv === undefined) delete process.env.FIT_PLAN;
	else process.env.FIT_PLAN = originalPlanEnv;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	root: string;
	board: string;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	sent: string[];
	notices: string[];
	command(args: string): Promise<void>;
	run(event: string, payload?: unknown): Promise<unknown[]>;
}

async function makeBoard(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "fit-planner-mode-"));
	roots.push(root);
	const board = join(root, "fit");
	await initBoard(board);
	return board;
}

function makeHarness(board: string): Harness {
	const root = join(board, "..");
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const flags = new Map<string, unknown>();
	const sent: string[] = [];
	const notices: string[] = [];

	const pi = {
		registerFlag(name: string, definition: { default?: unknown }) {
			flags.set(name, definition.default);
		},
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command);
		},
		registerShortcut() {},
		getFlag(name: string) {
			return flags.get(name);
		},
		sendUserMessage(text: string) {
			sent.push(text);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: root,
		mode: "rpc",
		hasUI: true,
		ui: {
			notify(message: string) {
				notices.push(message);
			},
			setStatus() {},
			setFooter() {},
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;

	extension(pi);

	return {
		root,
		board,
		pi,
		ctx,
		sent,
		notices,
		async command(args: string) {
			const command = commands.get("fit");
			assert.ok(command, "fit command was registered");
			await command.handler(args, ctx);
		},
		async run(event: string, payload: unknown = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx));
			}
			return results;
		},
	};
}

describe("planner mode first-prompt activation", () => {
	it("stays silent, then attaches the reminder to the first prompt", async () => {
		const board = await makeBoard();
		const harness = makeHarness(board);
		await harness.run("session_start", { reason: "startup" });

		await harness.command("planner on");

		assert.equal(harness.sent.length, 0);
		assert.ok(harness.notices.some((notice) => /Planner mode is on/.test(notice)));

		const first = await harness.run("before_agent_start", {
			messageType: "user",
			prompt: "plan the next change",
		});
		const content = (first[0] as { message?: { content?: string } } | undefined)?.message
			?.content;
		assert.ok(content);
		assert.match(content, /Planner mode is active/);
		assert.ok(content.includes(LATE_AGENT_MODE_REMINDER));

		const second = await harness.run("before_agent_start", {
			messageType: "user",
			prompt: "continue",
		});
		const secondContent = (second[0] as { message?: { content?: string } } | undefined)
			?.message?.content;
		assert.ok(secondContent);
		assert.doesNotMatch(secondContent, /Before doing any work, plan it/);
	});

	it("sends an explicit planner prompt immediately with the reminder", async () => {
		const board = await makeBoard();
		const harness = makeHarness(board);
		await harness.run("session_start", { reason: "startup" });

		await harness.command("planner fix the typo");

		assert.equal(harness.sent.length, 1);
		assert.match(harness.sent[0], /^fix the typo/);
		assert.ok(harness.sent[0].includes(LATE_AGENT_MODE_REMINDER));
	});

	it("adds a tailored reminder to the first generated work prompt", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Improve the planner.", slug: "planner-work" });
		await moveTicket({ board, id: created.ticket.id, status: "in_progress" });
		const harness = makeHarness(board);
		await harness.run("session_start", { reason: "startup" });

		await harness.command("planner on");
		await harness.command("work");

		assert.equal(harness.sent.length, 1);
		assert.ok(harness.sent[0].includes(DEFERRED_TICKET_PLANNER_REMINDER));
		assert.ok(!harness.sent[0].includes(LATE_AGENT_MODE_REMINDER));

		const next = await harness.run("before_agent_start", {
			messageType: "user",
			prompt: "continue",
		});
		const content = (next[0] as { message?: { content?: string } } | undefined)?.message
			?.content;
		assert.ok(content);
		assert.doesNotMatch(content, /Before doing any work, plan it/);
	});

	it("defers the reminder for planner mode enabled by the environment", async () => {
		process.env.FIT_PLAN = "1";
		const board = await makeBoard();
		const harness = makeHarness(board);
		await harness.run("session_start", { reason: "startup" });

		assert.equal(harness.sent.length, 0);
		const first = await harness.run("before_agent_start", {
			messageType: "user",
			prompt: "start planning",
		});
		const content = (first[0] as { message?: { content?: string } } | undefined)?.message
			?.content;
		assert.ok(content);
		assert.ok(content.includes(LATE_AGENT_MODE_REMINDER));
	});
});
