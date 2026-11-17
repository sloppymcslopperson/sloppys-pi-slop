import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface FileStat {
	mtimeMs: number;
	size: number;
}

/** A tracked file's last known state. null means the file was missing at that checkpoint. */
export type FileState = Record<string, FileStat | null>;

export type ChangeKind = "modified" | "added" | "deleted";

export interface FileChange {
	path: string;
	kind: ChangeKind;
	before: FileStat | null;
	after: FileStat | null;
}

export type CheckpointReason = "session-start" | "resume" | "enable" | "run" | "clear";

export interface CheckpointRecord {
	version: 1;
	type: "checkpoint";
	checkpoint: number;
	timestamp: string;
	reason: CheckpointReason;
	sessionId: string;
	cwd: string;
	files: FileState;
}

export type FreshmakerCommand =
	| { kind: "toggle" }
	| { kind: "on" }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "list" }
	| { kind: "clear" }
	| { kind: "clean"; maxAgeMs?: number }
	| { kind: "invalid"; reason: string };

export interface CleanResult {
	removed: string[];
	scanned: number;
}

const DURATION_UNITS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

export function getFreshmakerRoot(): string {
	return path.join(os.tmpdir(), "pi-freshmaker");
}

export function getSessionDir(root: string, sessionId: string): string {
	return path.join(root, sessionId);
}

export function getSessionLogPath(root: string, sessionId: string): string {
	return path.join(getSessionDir(root, sessionId), "checkpoints.jsonl");
}

export function resolveTrackedPath(filePath: string, cwd: string): string {
	return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
}

/** Parse durations such as 250ms, 30m, 12h, 7d, or 1w. Bare numbers are rejected. */
export function parseDuration(value: string): number | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i.exec(value);
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = DURATION_UNITS[match[2].toLowerCase()];
	if (!Number.isFinite(amount) || amount < 0 || unit === undefined) return null;
	return Math.round(amount * unit);
}

export function parseCommand(args: string): FreshmakerCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "toggle" };

	const command = parts[0].toLowerCase();
	if (command === "on" || command === "off" || command === "toggle" || command === "status" || command === "list" || command === "clear") {
		if (parts.length > 1) return { kind: "invalid", reason: `/${command} takes no arguments.` };
		return { kind: command };
	}

	if (command === "clean") {
		if (parts.length > 2) return { kind: "invalid", reason: "Usage: /freshmaker clean [30m|12h|7d]" };
		if (parts.length === 1) return { kind: "clean" };
		const maxAgeMs = parseDuration(parts[1]);
		if (maxAgeMs === null) {
			return { kind: "invalid", reason: `Invalid duration '${parts[1]}'. Use ms, s, m, h, d, or w (for example 7d).` };
		}
		return { kind: "clean", maxAgeMs };
	}

	return {
		kind: "invalid",
		reason: "Usage: /freshmaker [on|off|toggle|status|list|clear|clean [duration]]",
	};
}

export async function statPath(absolutePath: string): Promise<FileStat | null> {
	try {
		const info = await stat(absolutePath);
		return { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return null;
	}
}

export async function snapshotPaths(paths: Iterable<string>): Promise<FileState> {
	const unique = [...new Set(paths)].sort();
	const entries = await Promise.all(unique.map(async (filePath) => [filePath, await statPath(filePath)] as const));
	return Object.fromEntries(entries);
}

export function sameStat(a: FileStat | null, b: FileStat | null): boolean {
	if (a === null || b === null) return a === b;
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Compare the last known state with the current one. Keys present in both states are
 * compared directly; null represents a missing file, which allows deleted -> added
 * transitions to be reported.
 */
export function diffStates(previous: FileState, current: FileState): FileChange[] {
	const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
	const changes: FileChange[] = [];

	for (const filePath of keys) {
		const before = Object.hasOwn(previous, filePath) ? previous[filePath] : null;
		const after = Object.hasOwn(current, filePath) ? current[filePath] : null;

		if (before === null && after === null) continue;
		if (before === null) {
			changes.push({ path: filePath, kind: "added", before, after });
			continue;
		}
		if (after === null) {
			changes.push({ path: filePath, kind: "deleted", before, after });
			continue;
		}
		if (!sameStat(before, after)) {
			changes.push({ path: filePath, kind: "modified", before, after });
		}
	}

	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function displayPath(absolutePath: string, cwd: string): string {
	const relative = path.relative(cwd, absolutePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return absolutePath;
}

function formatStat(value: FileStat | null): string {
	if (value === null) return "missing";
	return `${value.size} B, mtime ${new Date(value.mtimeMs).toISOString()}`;
}

export function describeChange(change: FileChange, cwd: string): string {
	const file = displayPath(change.path, cwd);
	if (change.kind === "added") return `- added: ${file} (${formatStat(change.after)})`;
	if (change.kind === "deleted") return `- deleted: ${file} (was ${formatStat(change.before)})`;
	return `- modified: ${file} (${formatStat(change.before)} -> ${formatStat(change.after)})`;
}

export function formatInjection(changes: FileChange[], cwd: string): string {
	const lines = changes.map((change) => describeChange(change, cwd));
	return [
		"[FRESHMAKER] Files loaded into context have changed since the last checkpoint:",
		...lines,
		"",
		"Some context may be stale. Re-read any changed file before relying on its contents.",
	].join("\n");
}

export function formatList(changes: FileChange[], cwd: string, logPath: string): string {
	if (changes.length === 0) {
		return `Freshmaker: no tracked file changes since the last checkpoint.\nlog: ${logPath}`;
	}
	return [
		`Freshmaker: ${changes.length} tracked file change(s) since the last checkpoint:`,
		...changes.map((change) => describeChange(change, cwd)),
		`log: ${logPath}`,
	].join("\n");
}

export function createCheckpointRecord(options: {
	checkpoint: number;
	reason: CheckpointReason;
	sessionId: string;
	cwd: string;
	files: FileState;
	now?: Date;
}): CheckpointRecord {
	return {
		version: 1,
		type: "checkpoint",
		checkpoint: options.checkpoint,
		timestamp: (options.now ?? new Date()).toISOString(),
		reason: options.reason,
		sessionId: options.sessionId,
		cwd: options.cwd,
		files: options.files,
	};
}

export function serializeCheckpoint(record: CheckpointRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export async function appendCheckpoint(logPath: string, record: CheckpointRecord): Promise<void> {
	await mkdir(path.dirname(logPath), { recursive: true });
	await appendFile(logPath, serializeCheckpoint(record), "utf8");
}

export async function replaceCheckpointLog(logPath: string, record: CheckpointRecord): Promise<void> {
	await mkdir(path.dirname(logPath), { recursive: true });
	await writeFile(logPath, serializeCheckpoint(record), "utf8");
}

export async function readLastCheckpointNumber(logPath: string): Promise<number> {
	try {
		const text = await readFile(logPath, "utf8");
		const lines = text.split("\n");
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index].trim();
			if (!line) continue;
			try {
				const record = JSON.parse(line) as Partial<CheckpointRecord>;
				if (typeof record.checkpoint === "number" && Number.isInteger(record.checkpoint) && record.checkpoint >= 0) {
					return record.checkpoint;
				}
			} catch {
				// Ignore malformed lines and keep looking for the last valid checkpoint.
			}
		}
	} catch {
		// Missing or unreadable log: start numbering from zero.
	}
	return 0;
}

/**
 * Delete per-session directories under root whose log (or directory) is older than maxAgeMs.
 * The current session is always preserved.
 */
export async function cleanSessionLogs(
	root: string,
	maxAgeMs: number,
	currentSessionId: string,
	now: number = Date.now(),
): Promise<CleanResult> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return { removed: [], scanned: 0 };
	}

	const removed: string[] = [];
	let scanned = 0;

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentSessionId) continue;
		scanned++;
		const sessionDir = path.join(root, entry.name);
		const logPath = path.join(sessionDir, "checkpoints.jsonl");

		let mtimeMs: number;
		try {
			mtimeMs = (await stat(logPath)).mtimeMs;
		} catch {
			try {
				mtimeMs = (await stat(sessionDir)).mtimeMs;
			} catch {
				continue;
			}
		}

		if (now - mtimeMs > maxAgeMs) {
			try {
				await rm(sessionDir, { recursive: true, force: true });
				removed.push(sessionDir);
			} catch {
				// Leave directories we cannot remove in place; cleanup is best-effort.
			}
		}
	}

	return { removed, scanned };
}
