import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-fit-cli-"));
	roots.push(root);
	return root;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
	const env = { ...process.env };
	delete env.FIT_BOARD;
	delete env.FIT_GUARD;
	const child = spawn(process.execPath, [CLI, ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
		child.on("error", rejectPromise);
		child.on("close", resolvePromise);
	});
	return { code, stdout, stderr };
}

function json(result: RunResult): Record<string, unknown> {
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("pi-fit CLI", () => {
	it("initializes a Strict board and creates/lists tickets as JSON", async () => {
		const root = await makeRoot();
		const init = await run(["--board", "fit", "init", "--strict", "--json"], root);
		assert.equal(init.code, 0);
		const initialized = json(init);
		assert.equal(initialized.ok, true);
		assert.equal(initialized.command, "init");
		assert.equal(initialized.strict, true);

		const create = await run(
			["--board", "fit", "new", "open", "3", "Fix the typo in the README.", "--json"],
			root,
		);
		assert.equal(create.code, 0);
		const created = json(create);
		const ticket = created.ticket as { id: string; priority: number; title: string };
		assert.equal(ticket.id, "open/03-fix-the-typo-in-the-readme.md");
		assert.equal(ticket.priority, 3);
		assert.equal(ticket.title, "Fix the typo in the README.");

		const list = await run(["--board", "fit", "list", "--status", "open", "--json"], root);
		assert.equal(list.code, 0);
		const listed = json(list);
		assert.equal(listed.ok, true);
		assert.equal(listed.command, "list");
		assert.equal((listed.tickets as unknown[]).length, 1);
		assert.equal((listed.counts as Record<string, number>).open, 1);
		assert.equal((listed.mode as { mode: string }).mode, "strict");
	});

	it("moves, shows the current ticket, and reports no next ticket", async () => {
		const root = await makeRoot();
		await run(["--board", "fit", "init", "--strict"], root);
		const create = json(
			await run(["--board", "fit", "new", "open", "0", "First task.", "--json"], root),
		);
		const id = (create.ticket as { id: string }).id;

		const move = await run(["--board", "fit", "move", id, "in_progress", "--json"], root);
		assert.equal(move.code, 0);
		assert.equal(json(move).toId, "in_progress/00-first-task.md");

		const current = await run(["--board", "fit", "show", "--json"], root);
		assert.equal(current.code, 0);
		const shown = json(current).ticket as { id: string; status: string };
		assert.equal(shown.id, "in_progress/00-first-task.md");
		assert.equal(shown.status, "in_progress");

		const next = await run(["--board", "fit", "next", "--json"], root);
		assert.equal(next.code, 0);
		assert.equal(json(next).ticket, null);
	});

	it("updates frontmatter and body, closes, archives, and restores", async () => {
		const root = await makeRoot();
		await run(["--board", "fit", "init", "--strict"], root);
		const created = json(
			await run(["--board", "fit", "new", "open", "0", "Archive me.", "--json"], root),
		);
		const id = (created.ticket as { id: string }).id;

		const update = await run(
			[
				"--board",
				"fit",
				"update",
				id,
				"--append",
				"### Notes\n\nKeep this detail.",
				"--set",
				"owner=alice",
				"--set",
				"count=3",
				"--json",
			],
			root,
		);
		assert.equal(update.code, 0);
		const updated = json(update).ticket as {
			frontmatter: Record<string, unknown>;
			body: string;
		};
		assert.equal(updated.frontmatter.owner, "alice");
		assert.equal(updated.frontmatter.count, 3);
		assert.match(updated.body, /Keep this detail/);

		const close = await run(["--board", "fit", "close", id, "--json"], root);
		assert.equal(close.code, 0);
		assert.equal((json(close).ticket as { status: string }).status, "closed");

		const archive = await run(
			["--board", "fit", "archive", "closed/00-archive-me.md", "--json"],
			root,
		);
		assert.equal(archive.code, 0);
		const archived = json(archive);
		assert.equal(archived.archivedId, "closed/00-archive-me.md");
		const recordPath = archived.recordPath as string;
		assert.match(recordPath, /fit\/closed\/00-archive-me\.md$/);

		const restore = await run(["--board", "fit", "restore", recordPath, "--json"], root);
		assert.equal(restore.code, 0);
		assert.equal((json(restore).ticket as { id: string }).id, "open/00-archive-me.md");
	});

	it("returns usage and FIT errors with the documented exit codes", async () => {
		const root = await makeRoot();
		await run(["--board", "fit", "init", "--strict"], root);

		const unknownOption = await run(["--board", "fit", "list", "--nope"], root);
		assert.equal(unknownOption.code, 2);
		assert.match(unknownOption.stderr, /USAGE:/);

		const jsonUsage = await run(["--board", "fit", "list", "--nope", "--json"], root);
		assert.equal(jsonUsage.code, 2);
		assert.equal((JSON.parse(jsonUsage.stderr) as Record<string, unknown>).code, "USAGE");

		const malformed = await run(["--board", "fit", "new", "open", "100", "Text"], root);
		assert.equal(malformed.code, 2);
		assert.match(malformed.stderr, /USAGE:/);

		const missing = await run(["--board", "fit", "show", "missing", "--json"], root);
		assert.equal(missing.code, 1);
		assert.equal(missing.stdout, "");
		const error = JSON.parse(missing.stderr) as Record<string, unknown>;
		assert.equal(error.ok, false);
		assert.equal(error.code, "TICKET_NOT_FOUND");

		const noCurrent = await run(["--board", "fit", "show", "--json"], root);
		assert.equal(noCurrent.code, 1);
		assert.equal((JSON.parse(noCurrent.stderr) as Record<string, unknown>).code, "NO_IN_PROGRESS");
	});

	it("prints help and version", async () => {
		const root = await makeRoot();
		const help = await run(["--help"], root);
		assert.equal(help.code, 0);
		assert.match(help.stdout, /Usage:/);
		assert.match(help.stdout, /Exit codes: 0 success/);

		const version = await run(["version"], root);
		assert.equal(version.code, 0);
		assert.match(version.stdout, /^\d+\.\d+\.\d+/);
	});

	it("suggests free names and reports mode/path/check", async () => {
		const root = await makeRoot();
		await run(["--board", "fit", "init"], root);
		const created = json(
			await run(["--board", "fit", "new", "open", "0", "Fix typo.", "--json"], root),
		);
		const id = (created.ticket as { id: string }).id;

		const name = await run(["--board", "fit", "name", "open", "0", "Fix typo.", "--json"], root);
		assert.equal(name.code, 0);
		assert.equal(json(name).filename, "00-fix-typo-2.md");

		const mode = await run(["--board", "fit", "mode", "--json"], root);
		assert.equal(mode.code, 0);
		assert.equal(json(mode).mode, "basic");

		const path = await run(["--board", "fit", "path", id, "--json"], root);
		assert.equal(path.code, 0);
		assert.ok((json(path).path as string).endsWith("open/00-fix-typo.md"));

		const check = await run(["--board", "fit", "check", "--json"], root);
		assert.equal(check.code, 0);
		assert.equal(json(check).ok, true);
		assert.ok(Array.isArray(json(check).issues));
	});
});
