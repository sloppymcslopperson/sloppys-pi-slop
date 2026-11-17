import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	appendCheckpoint,
	cleanSessionLogs,
	createCheckpointRecord,
	diffStates,
	formatInjection,
	formatList,
	getSessionLogPath,
	parseCommand,
	parseDuration,
	readLastCheckpointNumber,
	replaceCheckpointLog,
	resolveTrackedPath,
	type CheckpointRecord,
	type FileState,
} from "../extensions/core.ts";

const DAY = 86_400_000;

function record(checkpoint: number, files: FileState = {}, sessionId = "session-1"): CheckpointRecord {
	return createCheckpointRecord({
		checkpoint,
		reason: checkpoint === 1 ? "session-start" : "run",
		sessionId,
		cwd: "/work",
		files,
		now: new Date("2025-01-01T00:00:00.000Z"),
	});
}

test("parseDuration accepts supported units and rejects bare numbers", () => {
	assert.equal(parseDuration("250ms"), 250);
	assert.equal(parseDuration("30m"), 30 * 60_000);
	assert.equal(parseDuration("12h"), 12 * 3_600_000);
	assert.equal(parseDuration("1d"), DAY);
	assert.equal(parseDuration("1.5d"), 1.5 * DAY);
	assert.equal(parseDuration("7"), null);
	assert.equal(parseDuration("1y"), null);
	assert.equal(parseDuration("-1d"), null);
	assert.equal(parseDuration(""), null);
});

test("parseCommand maps commands and validates clean durations", () => {
	assert.deepEqual(parseCommand(""), { kind: "toggle" });
	assert.deepEqual(parseCommand("on"), { kind: "on" });
	assert.deepEqual(parseCommand("off"), { kind: "off" });
	assert.deepEqual(parseCommand("list"), { kind: "list" });
	assert.deepEqual(parseCommand("clear"), { kind: "clear" });
	assert.deepEqual(parseCommand("clean"), { kind: "clean" });
	assert.deepEqual(parseCommand("clean 7d"), { kind: "clean", maxAgeMs: 7 * DAY });
	assert.equal(parseCommand("clean 7").kind, "invalid");
	assert.equal(parseCommand("on now").kind, "invalid");
	assert.equal(parseCommand("bogus").kind, "invalid");
});

test("diffStates reports modified, added, and deleted files only", () => {
	const previous: FileState = {
		"/work/a.ts": { mtimeMs: 1, size: 10 },
		"/work/b.ts": { mtimeMs: 2, size: 20 },
		"/work/e.ts": { mtimeMs: 3, size: 30 },
		"/work/gone.ts": null,
	};
	const current: FileState = {
		"/work/a.ts": { mtimeMs: 9, size: 10 },
		"/work/b.ts": { mtimeMs: 2, size: 20 },
		"/work/e.ts": null,
		"/work/gone.ts": null,
		"/work/new.ts": { mtimeMs: 4, size: 40 },
	};

	assert.deepEqual(diffStates(previous, current), [
		{
			path: "/work/a.ts",
			kind: "modified",
			before: { mtimeMs: 1, size: 10 },
			after: { mtimeMs: 9, size: 10 },
		},
		{
			path: "/work/e.ts",
			kind: "deleted",
			before: { mtimeMs: 3, size: 30 },
			after: null,
		},
		{
			path: "/work/new.ts",
			kind: "added",
			before: null,
			after: { mtimeMs: 4, size: 40 },
		},
	]);
});

test("diffStates treats size changes as modifications", () => {
	const previous: FileState = { "/work/a.ts": { mtimeMs: 1, size: 10 } };
	const current: FileState = { "/work/a.ts": { mtimeMs: 1, size: 11 } };
	assert.equal(diffStates(previous, current)[0]?.kind, "modified");
});

test("formatting uses cwd-relative paths and includes change details", () => {
	const changes = diffStates(
		{ "/work/src/a.ts": { mtimeMs: 1, size: 10 } },
		{ "/work/src/a.ts": { mtimeMs: 2, size: 12 } },
	);
	const injection = formatInjection(changes, "/work");
	assert.match(injection, /\[FRESHMAKER\]/);
	assert.match(injection, /modified: src\/a\.ts/);
	assert.match(injection, /10 B/);
	assert.match(injection, /12 B/);

	const list = formatList(changes, "/work", "/tmp/log");
	assert.match(list, /1 tracked file change/);
	assert.match(list, /log: \/tmp\/log/);

	assert.equal(
		formatList([], "/work", "/tmp/log"),
		"Freshmaker: no tracked file changes since the last checkpoint.\nlog: /tmp/log",
	);
});

test("resolveTrackedPath resolves relative paths against cwd", () => {
	assert.equal(resolveTrackedPath("src/a.ts", "/work"), "/work/src/a.ts");
	assert.equal(resolveTrackedPath("/elsewhere/a.ts", "/work"), "/elsewhere/a.ts");
});

test("checkpoint logs append records and can be replaced", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "freshmaker-log-"));
	try {
		const logPath = getSessionLogPath(dir, "session-1");
		await appendCheckpoint(logPath, record(1, { "/work/a.ts": { mtimeMs: 1, size: 2 } }));
		await appendCheckpoint(logPath, record(2, { "/work/a.ts": { mtimeMs: 3, size: 4 } }));

		assert.equal(await readLastCheckpointNumber(logPath), 2);
		const lines = (await readFile(logPath, "utf8")).trim().split("\n");
		assert.equal(lines.length, 2);
		assert.deepEqual(JSON.parse(lines[1]).files, { "/work/a.ts": { mtimeMs: 3, size: 4 } });

		await replaceCheckpointLog(logPath, record(1, {}));
		assert.equal(await readLastCheckpointNumber(logPath), 1);
		assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cleanSessionLogs removes old sessions but keeps current and fresh ones", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "freshmaker-clean-"));
	try {
		const now = Date.now();
		const oldLog = getSessionLogPath(root, "old-session");
		const freshLog = getSessionLogPath(root, "fresh-session");
		const currentLog = getSessionLogPath(root, "current-session");
		for (const logPath of [oldLog, freshLog, currentLog]) {
			await mkdir(path.dirname(logPath), { recursive: true });
			await writeFile(logPath, `${JSON.stringify(record(1))}\n`);
		}

		const oldTime = new Date(now - 3 * DAY);
		await utimes(oldLog, oldTime, oldTime);

		const result = await cleanSessionLogs(root, DAY, "current-session", now);
		assert.equal(result.removed.length, 1);
		assert.equal(result.scanned, 2);
		assert.equal(result.removed[0], path.dirname(oldLog));

		await assert.rejects(stat(oldLog));
		assert.ok(await stat(currentLog));
		assert.ok(await stat(freshLog));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
