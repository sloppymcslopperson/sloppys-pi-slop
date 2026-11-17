import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	FitError,
	archiveTicket,
	checkBoard,
	createTicket,
	initBoard,
	listTickets,
	moveTicket,
	readBoardMode,
	readTicket,
	restoreArchivedTicket,
	updateTicket,
} from "../src/fit.ts";
import { FIT_SPEC_VERSION } from "../src/spec.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeRoot(prefix = "fit-pi-e2e-"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

async function makeBoard(options: { strict?: boolean } = {}): Promise<string> {
	const root = await makeRoot();
	const board = join(root, "fit");
	await initBoard(board, { strict: options.strict });
	return board;
}

async function writeTicket(board: string, id: string, content: string): Promise<string> {
	const path = join(board, ...id.split("/"));
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf8");
	return path;
}

async function expectFitError(
	promise: Promise<unknown>,
	code: string,
): Promise<FitError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof FitError, `expected FitError, got ${String(error)}`);
		assert.equal(error.code, code);
		return error;
	}
	assert.fail(`expected FitError ${code}`);
}

describe("end-to-end FIT workflows", () => {
	it("detects Basic and Strict modes from the board marker", async () => {
		const basic = await makeBoard();
		assert.equal((await readBoardMode(basic)).mode, "basic");
		assert.equal((await checkBoard(basic)).mode.mode, "basic");

		const strict = await makeBoard({ strict: true });
		const mode = await readBoardMode(strict);
		assert.equal(mode.mode, "strict");
		assert.equal(mode.version, FIT_SPEC_VERSION);
		assert.equal((await checkBoard(strict)).mode.version, FIT_SPEC_VERSION);
	});

	it("validates Strict boards with required and optional rule severities", async () => {
		const board = await makeBoard({ strict: true });
		await writeTicket(board, "open/00-good.md", "Summary.\n\n### Notes\n\nDetail.\n");
		await writeTicket(board, "open/00-Bad.md", "Summary.\n\n## Old\n");
		await writeTicket(
			board,
			`open/00-${"a".repeat(30)}.md`,
			"Summary.\n",
		);
		await writeTicket(board, "backlog/00-Bad.md", "Summary.\n");
		await mkdir(join(board, "archive"));

		const result = await checkBoard(board);
		const codes = new Set(result.issues.map((issue) => issue.code));
		assert.ok(codes.has("TICKET_FILENAME_FORMAT"));
		assert.ok(codes.has("TICKET_NAME_UNIQUE"));
		assert.ok(codes.has("STRICT_EXTRA_STATUS"));
		assert.ok(codes.has("NON_CANONICAL_STATUS") === false);
		const section = result.issues.find(
			(issue) => issue.code === "TICKET_BODY_SECTIONS",
		);
		assert.equal(section?.severity, "error");
		const shortName = result.issues.find(
			(issue) => issue.code === "TICKET_SHORT_NAME_LENGTH",
		);
		assert.equal(shortName?.severity, "warning");
		assert.ok(
			result.issues
				.filter((issue) => issue.code === "TICKET_FILENAME_FORMAT")
				.every((issue) => issue.severity === "error"),
		);
	});

	it("derives names, enforces board-wide uniqueness, and looks up by short name", async () => {
		const board = await makeBoard();
		const first = await createTicket({
			board,
			content: "Fix the typo in the README.",
			priority: 3,
		});
		assert.equal(first.ticket.id, "open/03-fix-the-typo-in-the-readme.md");
		assert.equal(first.ticket.shortName, "fix-the-typo-in-the-readme");

		await expectFitError(
			createTicket({
				board,
				content: "A colliding ticket.",
				slug: "fix-the-typo-in-the-readme",
				status: "backlog",
				priority: 4,
			}),
			"NAME_TAKEN",
		);

		const shown = await readTicket(board, "fix-the-typo-in-the-readme");
		assert.equal(shown.id, first.ticket.id);
	});

	it("orders tickets by status, sub-status, then filename", async () => {
		const board = await makeBoard();
		await createTicket({ board, content: "Ten.", priority: 10, slug: "ten" });
		await createTicket({ board, content: "Two.", priority: 2, slug: "two" });
		await createTicket({
			board,
			content: "Blocked.",
			priority: 0,
			slug: "blocked",
			status: "open/blocked",
		});
		await createTicket({
			board,
			content: "Backlog.",
			priority: 0,
			slug: "later",
			status: "backlog",
		});

		const ids = (await listTickets(board)).map((ticket) => ticket.id);
		assert.deepEqual(ids, [
			"open/02-two.md",
			"open/10-ten.md",
			"open/blocked/00-blocked.md",
			"backlog/00-later.md",
		]);
	});

	it("allows only one in_progress ticket per checkout", async () => {
		const board = await makeBoard();
		const first = await createTicket({ board, content: "First.", slug: "first" });
		const second = await createTicket({ board, content: "Second.", slug: "second" });
		await moveTicket({ board, id: first.ticket.id, status: "in_progress" });
		const error = await expectFitError(
			moveTicket({ board, id: second.ticket.id, status: "in_progress" }),
			"IN_PROGRESS_LIMIT",
		);
		assert.deepEqual(error.candidates, ["in_progress/00-first.md"]);
	});

	it("round-trips a ticket through archive.txt", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Archive me.\n\n### Notes\n\nKeep this detail.\n",
			slug: "archive-me",
		});
		await moveTicket({ board, id: created.ticket.id, status: "closed" });
		const archived = await archiveTicket({ board, id: "closed/00-archive-me.md" });
		assert.equal(archived.recordPath, "fit/closed/00-archive-me.md");
		assert.equal((await listTickets(board)).length, 0);
		const archiveText = await readFile(join(board, "closed", "archive.txt"), "utf8");
		assert.match(archiveText, /^### fit\/closed\/00-archive-me\.md$/m);
		assert.match(archiveText, /Keep this detail\./);

		const restored = await restoreArchivedTicket({
			board,
			id: "fit/closed/00-archive-me.md",
			status: "open",
		});
		assert.equal(restored.ticket.id, "open/00-archive-me.md");
		assert.match(restored.ticket.body, /Keep this detail\./);
		assert.equal(restored.remainingRecords, 0);
		assert.equal((await listTickets(board)).length, 1);
	});

	it("preserves frontmatter while updating body text", async () => {
		const board = await makeBoard({ strict: true });
		const created = await createTicket({
			board,
			content: "Summary sentence.\n",
			slug: "frontmatter-ticket",
			project: "e2e",
			frontmatter: { owner: "alice", tags: ["one", "two"] },
		});
		const updated = await updateTicket({
			board,
			id: created.ticket.id,
			body: "### Notes\n\nAppended detail.\n",
			bodyMode: "append",
			expectedRevision: created.ticket.revision,
		});
		assert.equal(updated.ticket.frontmatter.owner, "alice");
		assert.equal(updated.ticket.frontmatter.project, "e2e");
		assert.deepEqual(updated.ticket.frontmatter.tags, ["one", "two"]);
		assert.match(updated.ticket.body, /Summary sentence\./);
		assert.match(updated.ticket.body, /Appended detail\./);

		await expectFitError(
			updateTicket({
				board,
				id: created.ticket.id,
				body: "Stale.",
				expectedRevision: created.ticket.revision,
			}),
			"STALE_TICKET",
		);
	});
});
