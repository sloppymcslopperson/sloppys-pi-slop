import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import freshmakerExtension from "../extensions/freshmaker.ts";
import { getFreshmakerRoot } from "../extensions/core.ts";

test("extension toggles, tracks reads, and injects changes hidden from the TUI", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "freshmaker-cwd-"));
	const sessionId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const handlers: Record<string, (event: never, ctx: never) => unknown> = {};
	const commands: Record<string, { handler: (args: string, ctx: never) => Promise<void> }> = {};

	const ctx = {
		cwd,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "watched.txt" } }],
					},
				},
			],
		},
	};

	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => {
			handlers[event] = handler;
		},
		appendEntry: () => undefined,
		registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) => {
			commands[name] = options;
		},
	};

	try {
		const watched = path.join(cwd, "watched.txt");
		await writeFile(watched, "one");
		freshmakerExtension(pi as never);

		await handlers.session_start({ reason: "startup" } as never, ctx as never);
		await commands.freshmaker.handler("on", ctx as never);
		await handlers.tool_result({ toolName: "read", isError: false, input: { path: "watched.txt" } } as never, ctx as never);

		const runStart = { systemPromptOptions: { contextFiles: [], skills: [] } } as never;
		const unchanged = await handlers.before_agent_start(runStart, ctx as never);
		assert.equal(unchanged, undefined);

		// The agent reads the file, then writes it during the same run. The
		// checkpoint at settle must absorb that write instead of reporting it on
		// the next prompt.
		await writeFile(watched, "one plus agent contents");
		await handlers.agent_settled({} as never, ctx as never);

		const afterAgentWrite = await handlers.before_agent_start(runStart, ctx as never);
		assert.equal(afterAgentWrite, undefined);

		// A change made outside the agent run is still reported on the next prompt.
		await writeFile(watched, "one plus external contents");
		const changed = (await handlers.before_agent_start(runStart, ctx as never)) as {
			message?: { content?: string; display?: boolean };
		};

		assert.equal(changed.message?.display, false);
		assert.match(changed.message?.content ?? "", /watched\.txt/);
		assert.match(changed.message?.content ?? "", /modified:/);
		assert.ok(statuses.includes("freshmaker: on"));

		await commands.freshmaker.handler("off", ctx as never);
		assert.equal(statuses.at(-1), undefined);
		assert.ok(notifications.some((message) => message.includes("Freshmaker off")));
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(path.join(getFreshmakerRoot(), sessionId), { recursive: true, force: true });
	}
});
