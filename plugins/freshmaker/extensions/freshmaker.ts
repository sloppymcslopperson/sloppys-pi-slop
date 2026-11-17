/**
 * Freshmaker Extension
 *
 * Tracks files loaded into context, checkpoints their mtime/size after enabled
 * agent runs, and injects a hidden notice when a tracked file changed.
 * Monitoring starts on in each session. The /freshmaker command controls it and
 * inspects or clears the log.
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
	appendCheckpoint,
	cleanSessionLogs,
	createCheckpointRecord,
	diffStates,
	formatInjection,
	formatList,
	getFreshmakerRoot,
	getSessionLogPath,
	parseCommand,
	parseDuration,
	readLastCheckpointNumber,
	replaceCheckpointLog,
	resolveTrackedPath,
	snapshotPaths,
	statPath,
	type CheckpointReason,
	type FileState,
} from "./core.ts";

const DEFAULT_MAX_AGE = "1d";

function createSerialRunner() {
	let tail: Promise<unknown> = Promise.resolve();
	return function run<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = tail.then(fn, fn);
		tail = next.catch(() => undefined);
		return next;
	};
}

function readPathsFromSession(ctx: ExtensionContext, cwd: string): string[] {
	const paths = new Set<string>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = (entry as { message?: unknown }).message as
			| { role?: string; content?: unknown }
			| undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;

		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; name?: unknown; arguments?: unknown };
			if (candidate.type !== "toolCall" || candidate.name !== "read") continue;
			const args = candidate.arguments as { path?: unknown } | undefined;
			if (typeof args?.path === "string") {
				paths.add(resolveTrackedPath(args.path, cwd));
			}
		}
	}

	return [...paths];
}

export default function freshmakerExtension(pi: ExtensionAPI): void {
	const serial = createSerialRunner();

	let cwd = process.cwd();
	let sessionId = "";
	let logPath = "";
	let enabled = false;
	let tracked = new Set<string>();
	let baselines: FileState = {};
	let checkpointNumber = 0;
	let lastEnabledCheckpoint: number | null = null;

	function updateStatus(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus("freshmaker", enabled ? "freshmaker: on" : undefined);
		} catch {
			// Status is best-effort in non-interactive modes.
		}
	}

	async function trackPaths(paths: Iterable<string>, refreshExisting: boolean): Promise<void> {
		for (const filePath of paths) {
			const absolutePath = resolveTrackedPath(filePath, cwd);
			if (!refreshExisting && tracked.has(absolutePath)) continue;
			tracked.add(absolutePath);
			baselines[absolutePath] = await statPath(absolutePath);
		}
	}

	async function appendRecord(reason: CheckpointReason, files: FileState, markEnabled: boolean): Promise<number> {
		checkpointNumber += 1;
		const record = createCheckpointRecord({
			checkpoint: checkpointNumber,
			reason,
			sessionId,
			cwd,
			files,
		});
		await appendCheckpoint(logPath, record);
		if (markEnabled) lastEnabledCheckpoint = checkpointNumber;
		return checkpointNumber;
	}

	async function initializeSession(ctx: ExtensionContext, reason: string): Promise<void> {
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		logPath = getSessionLogPath(getFreshmakerRoot(), sessionId);
		enabled = true;
		tracked = new Set();
		baselines = {};
		lastEnabledCheckpoint = null;
		checkpointNumber = await readLastCheckpointNumber(logPath);

		await trackPaths(readPathsFromSession(ctx, cwd), true);
		baselines = await snapshotPaths(tracked);

		const checkpointReason: CheckpointReason = reason === "reload" || reason === "resume" ? "resume" : "session-start";
		await appendRecord(checkpointReason, baselines, true);

		try {
			pi.appendEntry("freshmaker", {
				sessionId,
				logPath,
				reason,
				startedAt: new Date().toISOString(),
			});
		} catch {
			// Recording the log path in the session is best-effort.
		}

		updateStatus(ctx);
	}

	async function ensureSession(ctx: ExtensionContext): Promise<void> {
		if (!logPath) await initializeSession(ctx, "startup");
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		await ensureSession(ctx);
		const command = parseCommand(args);

		switch (command.kind) {
			case "invalid":
				ctx.ui.notify(command.reason, "warning");
				return;

			case "toggle":
				await setEnabled(!enabled, ctx);
				return;

			case "on":
				if (enabled) {
					ctx.ui.notify("Freshmaker is already on.", "info");
					return;
				}
				await setEnabled(true, ctx);
				return;

			case "off":
				if (!enabled) {
					ctx.ui.notify("Freshmaker is already off.", "info");
					return;
				}
				await setEnabled(false, ctx);
				return;

			case "status": {
				ctx.ui.notify(
					[
						`Freshmaker: ${enabled ? "on" : "off"}`,
						`tracked files: ${tracked.size}`,
						`last checkpoint: ${checkpointNumber}`,
						`last enabled checkpoint: ${lastEnabledCheckpoint ?? "none"}`,
						`log: ${logPath}`,
					].join("\n"),
					"info",
				);
				return;
			}

			case "list": {
				const current = await snapshotPaths(tracked);
				const changes = diffStates(baselines, current);
				ctx.ui.notify(formatList(changes, cwd, logPath), "info");
				return;
			}

			case "clear": {
				tracked = new Set();
				baselines = {};
				checkpointNumber = 0;
				lastEnabledCheckpoint = null;

				checkpointNumber = 1;
				const record = createCheckpointRecord({
					checkpoint: checkpointNumber,
					reason: "clear",
					sessionId,
					cwd,
					files: {},
				});
				await replaceCheckpointLog(logPath, record);
				if (enabled) lastEnabledCheckpoint = checkpointNumber;

				updateStatus(ctx);
				ctx.ui.notify("Freshmaker: cleared the current session log and watch list.", "info");
				return;
			}

			case "clean": {
				const configured = command.maxAgeMs;
				const raw = configured === undefined ? (process.env.PI_FRESHMAKER_MAX_AGE?.trim() || DEFAULT_MAX_AGE) : undefined;
				const maxAgeMs = configured ?? parseDuration(raw ?? DEFAULT_MAX_AGE);
				if (maxAgeMs === null) {
					ctx.ui.notify(`Invalid PI_FRESHMAKER_MAX_AGE value '${raw}'. Use ms, s, m, h, d, or w.`, "warning");
					return;
				}
				const result = await cleanSessionLogs(getFreshmakerRoot(), maxAgeMs, sessionId);
				const label = configured === undefined ? (raw ?? DEFAULT_MAX_AGE) : `${maxAgeMs}ms`;
				ctx.ui.notify(
					`Freshmaker: removed ${result.removed.length} old session log(s) older than ${label} (scanned ${result.scanned}).`,
					"info",
				);
				return;
			}
		}
	}

	async function setEnabled(next: boolean, ctx: ExtensionContext): Promise<void> {
		enabled = next;

		if (enabled && lastEnabledCheckpoint === null) {
			// First enable in this session: establish a silent baseline so pre-enable
			// changes are not reported.
			baselines = await snapshotPaths(tracked);
			await appendRecord("enable", baselines, true);
		}

		updateStatus(ctx);
		if (enabled) {
			ctx.ui.notify(
				`Freshmaker on: watching ${tracked.size} file(s); log: ${logPath}`,
				"info",
			);
		} else {
			ctx.ui.notify("Freshmaker off: reads are still tracked, but no checks or checkpoints run.", "info");
		}
	}

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		await serial(() => initializeSession(ctx, event.reason));
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		const readPath = input.path;

		await serial(async () => {
			await ensureSession(ctx);
			await trackPaths([readPath], true);
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;

		return serial(async () => {
			await ensureSession(ctx);

			const contextPaths: string[] = [];
			for (const file of event.systemPromptOptions.contextFiles ?? []) {
				contextPaths.push(file.path);
			}
			for (const skill of event.systemPromptOptions.skills ?? []) {
				contextPaths.push(skill.filePath);
			}
			await trackPaths(contextPaths, false);

			const current = await snapshotPaths(tracked);
			const changes = diffStates(baselines, current);

			if (changes.length === 0) return;

			return {
				message: {
					customType: "freshmaker",
					content: formatInjection(changes, cwd),
					display: false,
				},
			};
		});
	});

	// Defer the checkpoint until the run settles (when the agent is waiting for
	// user input). Files the agent read and then wrote during the same run are
	// therefore baselined as the agent left them, avoiding a false change report
	// on the next prompt.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled) return;

		await serial(async () => {
			await ensureSession(ctx);
			const current = await snapshotPaths(tracked);
			baselines = current;
			await appendRecord("run", current, true);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus("freshmaker", undefined);
		} catch {
			// Ignore teardown races in non-interactive modes.
		}
	});

	pi.registerCommand("freshmaker", {
		description: "Toggle or inspect file-change checkpoints for loaded files",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "toggle", "status", "list", "clear", "clean"].map((value) => ({
				value,
				label: value,
			}));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await serial(() => handleCommand(args, ctx));
		},
	});
}
