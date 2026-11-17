import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import {
	FitError,
	CHECK_RULES,
	DEFAULT_MAX_TICKET_NAME_CHARS,
	MAX_PRIORITY,
	archiveTicket,
	checkBoard,
	checkRuleSeverity,
	cleanupTicketNames,
	composeTicket,
	countTickets,
	createTicket,
	createTickets,
	deriveTicketName,
	deriveTitle,
	initBoard,
	listTickets,
	migrationReport,
	moveTicket,
	nextTicketToPromote,
	normalizeBodyForStrict,
	normalizeLegacyBodies,
	parseArchiveContent,
	parseFrontmatter,
	readBoard,
	readBoardMode,
	readTicket,
	recordClosedTicketsCommit,
	resolveBoard,
	restoreArchivedTicket,
	revisionOf,
	slugify,
	splitFrontmatter,
	ticketFilenameProblems,
	validateFrontmatterYaml,
	ticketFilename,
	truncateTicketName,
	updateFrontmatterRaw,
	updateTicket,
} from "../src/fit.ts";
import { AGENT_SPEC } from "../src/agent-spec.ts";
import { FIT_SPEC, FIT_SPEC_LEGACY, FIT_SPEC_VERSION } from "../src/spec.ts";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeBoard(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "fit-pi-"));
	roots.push(root);
	const board = join(root, "fit");
	await initBoard(board);
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

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("board init", () => {
	it("creates the four canonical status directories and the spec", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-init-"));
		roots.push(root);
		const board = join(root, "fit");
		const first = await initBoard(board);
		assert.deepEqual(first.created, ["open", "in_progress", "backlog", "closed"]);
		assert.equal(first.specCreated, true);
		assert.match(await readFile(first.specPath, "utf8"), /^# Fit Spec\n/);
		assert.equal(first.strict, false);
		assert.equal(first.strictCreated, false);
		assert.equal(first.agentsCreated, true);
		assert.equal(first.agentsPath, join(root, "AGENTS.md"));
		assert.match(await readFile(first.agentsPath, "utf8"), /## FIT tickets/);
		assert.equal(first.agentSpecCreated, true);
		assert.equal(first.agentSpecPath, join(root, "AGENT_SPEC.md"));
		assert.equal(await readFile(first.agentSpecPath, "utf8"), AGENT_SPEC);

		const second = await initBoard(board);
		assert.deepEqual(second.created, []);
		assert.deepEqual(second.existing, ["open", "in_progress", "backlog", "closed"]);
		assert.equal(second.specCreated, false);
		assert.equal(second.agentsCreated, false);
		assert.equal(second.agentsUpdated, false);
		assert.equal(second.agentSpecCreated, false);
		const tickets = await listTickets(board);
		assert.deepEqual(tickets, []);
	});

	it("opts in to Strict mode with a quoted version marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-strict-"));
		roots.push(root);
		const board = join(root, "fit");
		const first = await initBoard(board, { strict: true });
		assert.equal(first.strict, true);
		assert.equal(first.strictCreated, true);
		assert.equal(first.strictPath, join(board, "STRICT"));
		assert.equal(await readFile(first.strictPath, "utf8"), `"${FIT_SPEC_VERSION}"\n`);
		assert.equal((await readBoardMode(board)).mode, "strict");

		const second = await initBoard(board, { strict: true });
		assert.equal(second.strict, true);
		assert.equal(second.strictCreated, false);
	});

	it("reports an already-strict board on a basic init", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-strict-existing-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board, { strict: true });
		const result = await initBoard(board);
		assert.equal(result.strict, true);
		assert.equal(result.strictCreated, false);
	});

	it("keeps Strict mode through git worktree setup", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-strict-git-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		const board = join(root, "fit");
		const result = await initBoard(board, { git: true, strict: true });
		assert.equal(result.strict, true);
		assert.equal(result.strictCreated, true);
		assert.equal((await readBoardMode(board)).mode, "strict");
	});

	it("adds the FIT section to an existing AGENTS.md without replacing it", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-agents-"));
		roots.push(root);
		const board = join(root, "fit");
		const agentsPath = join(root, "AGENTS.md");
		await writeFile(agentsPath, "# Project rules\n\nAlways run tests.\n", "utf8");

		const result = await initBoard(board);
		assert.equal(result.agentsCreated, false);
		assert.equal(result.agentsUpdated, true);
		const content = await readFile(agentsPath, "utf8");
		assert.match(content, /^# Project rules/);
		assert.match(content, /Always run tests\./);
		assert.match(content, /## FIT tickets/);

		const second = await initBoard(board);
		assert.equal(second.agentsUpdated, false);
	});

	it("leaves Git setup alone unless requested", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-no-git-"));
		roots.push(root);
		const board = join(root, "fit");
		const result = await initBoard(board);
		assert.equal(result.gitRequested, false);
		await assert.rejects(access(join(root, ".gitignore")));
		await assert.rejects(access(join(board, ".git")));
	});

	it("creates a parent-repo fit branch worktree when requested", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-git-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		const board = join(root, "fit");
		const gitignorePath = join(root, ".gitignore");
		await writeFile(gitignorePath, "node_modules/\n", "utf8");

		const first = await initBoard(board, { git: true });
		assert.equal(first.gitRequested, true);
		assert.equal(first.gitignoreCreated, false);
		assert.equal(first.gitignoreUpdated, true);
		assert.equal(first.gitBranch, "fit");
		assert.equal(first.gitBranchCreated, true);
		assert.equal(first.gitWorktreeCreated, true);
		assert.equal(first.gitBackupPath, undefined);
		assert.match(await readFile(gitignorePath, "utf8"), /^\/fit\/$/m);
		assert.equal(git(board, ["rev-parse", "--abbrev-ref", "HEAD"]), "fit");
		assert.match(git(root, ["branch", "--list", "fit"]), /fit/);

		const second = await initBoard(board, { git: true });
		assert.equal(second.gitignoreCreated, false);
		assert.equal(second.gitignoreUpdated, false);
		assert.equal(second.gitBranchCreated, false);
		assert.equal(second.gitWorktreeCreated, false);
		assert.equal(second.gitBackupPath, undefined);
	});

	it("writes a repo-root-relative ignore rule for a nested board", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-nested-git-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		const board = join(root, "packages", "fit");

		const result = await initBoard(board, { git: true });
		assert.equal(result.gitignoreCreated, true);
		assert.match(
			await readFile(join(root, ".gitignore"), "utf8"),
			/^\/packages\/fit\/$/m,
		);
		assert.equal(git(board, ["rev-parse", "--abbrev-ref", "HEAD"]), "fit");
	});

	it("restores an existing fit branch and keeps a backup of local contents", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-git-restore-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		const board = join(root, "fit");

		await initBoard(board, { git: true });
		await writeFile(join(board, "open", "00-from-branch.md"), "From branch.\n", "utf8");
		git(board, ["add", "-A"]);
		git(board, ["commit", "-qm", "Add branch ticket"]);
		git(root, ["worktree", "remove", "--force", board]);

		const result = await initBoard(board, { git: true });
		assert.equal(result.gitBranchCreated, false);
		assert.equal(result.gitWorktreeCreated, true);
		assert.ok(result.gitBackupPath);
		assert.match(
			await readFile(join(board, "open", "00-from-branch.md"), "utf8"),
			/From branch/,
		);
		await access(result.gitBackupPath);
	});

	it("merges local tickets and asks about same-name conflicts", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-git-merge-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		const board = join(root, "fit");

		await initBoard(board, { git: true });
		await writeFile(join(board, "open", "00-local-wins.md"), "Branch local wins.\n", "utf8");
		await writeFile(join(board, "open", "01-branch-wins.md"), "Branch version.\n", "utf8");
		await writeFile(join(board, "open", "02-branch-only.md"), "Branch only.\n", "utf8");
		git(board, ["add", "-A"]);
		git(board, ["commit", "-qm", "Add branch tickets"]);
		git(root, ["worktree", "remove", "--force", board]);

		await mkdir(join(board, "open"), { recursive: true });
		await writeFile(join(board, "open", "00-local-wins.md"), "Local version.\n", "utf8");
		await writeFile(join(board, "open", "01-branch-wins.md"), "Local version.\n", "utf8");
		await writeFile(join(board, "open", "03-local-only.md"), "Local only.\n", "utf8");

		const conflicts: string[] = [];
		const result = await initBoard(board, {
			git: true,
			resolveGitConflict: async (ticket) => {
				conflicts.push(ticket);
				return ticket === "open/00-local-wins.md" ? "local" : "branch";
			},
		});

		assert.deepEqual(conflicts, ["open/00-local-wins.md", "open/01-branch-wins.md"]);
		assert.deepEqual(result.gitMergedTickets, [
			"open/00-local-wins.md",
			"open/03-local-only.md",
		]);
		assert.deepEqual(result.gitKeptBranchTickets, ["open/01-branch-wins.md"]);
		assert.match(
			await readFile(join(board, "open", "00-local-wins.md"), "utf8"),
			/Local version/,
		);
		assert.match(
			await readFile(join(board, "open", "01-branch-wins.md"), "utf8"),
			/Branch version/,
		);
		assert.match(
			await readFile(join(board, "open", "03-local-only.md"), "utf8"),
			/Local only/,
		);
		assert.ok(result.gitBackupPath);
	});

	it("rolls back when a conflict cannot be resolved", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-git-conflict-"));
		roots.push(root);
		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		const board = join(root, "fit");

		await initBoard(board, { git: true });
		await writeFile(join(board, "open", "00-shared.md"), "Branch version.\n", "utf8");
		git(board, ["add", "-A"]);
		git(board, ["commit", "-qm", "Add branch ticket"]);
		git(root, ["worktree", "remove", "--force", board]);

		await mkdir(join(board, "open"), { recursive: true });
		await writeFile(join(board, "open", "00-shared.md"), "Local version.\n", "utf8");
		await expectFitError(initBoard(board, { git: true }), "GIT_MERGE_CONFLICT");
		assert.match(
			await readFile(join(board, "open", "00-shared.md"), "utf8"),
			/Local version/,
		);
	});

	it("never overwrites an existing spec copy", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		const specPath = join(board, "FIT_SPEC.md");
		await writeFile(specPath, "# local spec notes\n", "utf8");
		const result = await initBoard(board);
		assert.equal(result.specCreated, false);
		assert.equal(await readFile(specPath, "utf8"), "# local spec notes\n");
	});

	it("never overwrites an existing AGENT_SPEC.md", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-agent-spec-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		const agentSpecPath = join(root, "AGENT_SPEC.md");
		await writeFile(agentSpecPath, "# Local agent rules\n", "utf8");

		const result = await initBoard(board);
		assert.equal(result.agentSpecCreated, false);
		assert.equal(await readFile(agentSpecPath, "utf8"), "# Local agent rules\n");
	});

	it("resolves board paths deterministically", () => {
		assert.equal(resolveBoard(undefined, "/repo"), resolve("/repo", "fit"));
		assert.equal(resolveBoard("@board", "/repo"), resolve("/repo", "board"));
		assert.equal(resolveBoard("/tmp/fit", "/repo"), resolve("/tmp/fit"));
	});
});

describe("spec refresh", () => {
	it("creates the spec when none exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-create-"));
		roots.push(root);
		const board = join(root, "fit");
		const result = await initBoard(board);
		assert.equal(result.specCreated, true);
		assert.equal(result.specUpdated, false);
		assert.equal(result.specPreserved, false);
	});

	it("upgrades a legacy vendored spec and keeps annotations", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-upgrade-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		const annotation = "\n## Local notes\n\nKeep this line.\n";
		await writeFile(
			join(board, "FIT_SPEC.md"),
			`${FIT_SPEC_LEGACY[0]}${annotation}`,
			"utf8",
		);

		const result = await initBoard(board, { refreshSpec: true });
		assert.equal(result.specUpdated, true);
		assert.equal(result.specCreated, false);
		const content = await readFile(join(board, "FIT_SPEC.md"), "utf8");
		assert.ok(content.startsWith(FIT_SPEC));
		assert.match(content, /Keep this line\./);
		assert.doesNotMatch(content, /# Full Fit Spec/);
	});

	it("is a no-op when the spec is already current", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-noop-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		const result = await initBoard(board, { refreshSpec: true });
		assert.equal(result.specCreated, false);
		assert.equal(result.specUpdated, false);
		assert.equal(result.specPreserved, false);
	});

	it("preserves unrecognized local content", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-preserve-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		await writeFile(join(board, "FIT_SPEC.md"), "# My own spec\n", "utf8");
		const result = await initBoard(board, { refreshSpec: true });
		assert.equal(result.specPreserved, true);
		assert.equal(result.specUpdated, false);
		assert.equal(await readFile(join(board, "FIT_SPEC.md"), "utf8"), "# My own spec\n");
	});

	it("leaves a legacy spec alone without refresh", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-spec-keep-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board);
		await writeFile(join(board, "FIT_SPEC.md"), FIT_SPEC_LEGACY[0], "utf8");
		const result = await initBoard(board);
		assert.equal(result.specUpdated, false);
		assert.equal(await readFile(join(board, "FIT_SPEC.md"), "utf8"), FIT_SPEC_LEGACY[0]);
	});
});

describe("board mode", () => {
	it("reports basic when there is no STRICT marker", async () => {
		const board = await makeBoard();
		const mode = await readBoardMode(board);
		assert.deepEqual(mode, { mode: "basic", version: null, strict: null });
	});

	it("parses the quoted version from STRICT", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), '"0.5"\n', "utf8");
		const mode = await readBoardMode(board);
		assert.equal(mode.mode, "strict");
		assert.equal(mode.version, "0.5");
		assert.equal(mode.strict, '"0.5"\n');
	});

	it("stays strict but flags an unquoted version", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), "0.5\n", "utf8");
		const mode = await readBoardMode(board);
		assert.equal(mode.mode, "strict");
		assert.equal(mode.version, null);
	});

	it("requires an exact quoted version line", async () => {
		const board = await makeBoard();
		for (const contents of [' "0.5"\n', '"0.5" \n', '"0.5"\n\n', '""\n']) {
			await writeFile(join(board, "STRICT"), contents, "utf8");
			const mode = await readBoardMode(board);
			assert.equal(mode.mode, "strict");
			assert.equal(mode.version, null, JSON.stringify(contents));
		}
	});

	it("treats a malformed STRICT marker as a check error", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), "0.5\n", "utf8");
		const result = await checkBoard(board);
		const issue = result.issues.find(
			(candidate) => candidate.code === "STRICT_MARKER_MALFORMED",
		);
		assert.equal(issue?.severity, "error");
	});

	it("warns about an unknown or newer STRICT version", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), '"9.9"\n', "utf8");
		let result = await checkBoard(board);
		assert.ok(result.issues.some((issue) => issue.code === "STRICT_VERSION_NEWER"));

		await writeFile(join(board, "STRICT"), '"future"\n', "utf8");
		result = await checkBoard(board);
		assert.ok(result.issues.some((issue) => issue.code === "STRICT_VERSION_UNKNOWN"));

		await writeFile(join(board, "STRICT"), `"${FIT_SPEC_VERSION}"\n`, "utf8");
		result = await checkBoard(board);
		assert.equal(
			result.issues.some((issue) => issue.code.startsWith("STRICT_")),
			false,
		);
	});

	it("returns mode and tickets together", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), '"0.5"', "utf8");
		await writeTicket(board, "open/00-one.md", "One.\n");
		const { mode, tickets } = await readBoard(board);
		assert.equal(mode.mode, "strict");
		assert.deepEqual(tickets.map((ticket) => ticket.id), ["open/00-one.md"]);
	});

	it("includes the mode in board checks", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), '"0.5"', "utf8");
		const result = await checkBoard(board);
		assert.equal(result.mode.mode, "strict");
		assert.equal(result.mode.version, "0.5");
	});
});

describe("ticket creation", () => {
	it("derives a deterministic NN-slug filename", async () => {
		const board = await makeBoard();
		const result = await createTicket({
			board,
			content: "Fix typo in README.",
			priority: 3,
		});
		assert.equal(result.created, true);
		assert.equal(result.ticket.id, "open/03-fix-typo-in-readme.md");
		assert.equal(result.ticket.priority, 3);
		assert.equal(result.ticket.body, "Fix typo in README.\n");
		assert.equal(result.ticket.revision, revisionOf(result.ticket.content));

		const retry = await createTicket({
			board,
			content: "Fix typo in README.",
			priority: 3,
		});
		assert.equal(retry.created, false);
		assert.equal(retry.ticket.id, result.ticket.id);
		assert.equal((await listTickets(board)).length, 1);
	});

	it("names tickets with the first sentence, capped at 30 characters", async () => {
		const board = await makeBoard();
		const result = await createTicket({
			board,
			content:
				"One two three four five six seven eight nine. A second sentence with more words.",
		});
		assert.equal(result.ticket.id, "open/00-one-two-three-four-five-six.md");
		assert.equal(result.ticket.title, "One two three four five six seven eight nine.");
	});

	it("creates a batch of planned tickets", async () => {
		const board = await makeBoard();
		const result = await createTickets({
			board,
			tickets: [
				{ content: "First planned step.", priority: 2 },
				{
					content: "Second planned step.",
					status: "backlog",
					slug: "second-step",
					frontmatter: { owner: "alice" },
				},
			],
		});
		assert.deepEqual(
			result.tickets.map((ticket) => ticket.ticket.id),
			["open/02-first-planned-step.md", "backlog/00-second-step.md"],
		);
		assert.equal(result.tickets[1].ticket.frontmatter.owner, "alice");
		assert.equal((await listTickets(board)).length, 2);
	});

	it("validates every batch item before writing anything", async () => {
		const board = await makeBoard();
		await expectFitError(
			createTickets({
				board,
				tickets: [{ content: "Valid." }, { content: "Invalid.", priority: 1000 }],
			}),
			"INVALID_PRIORITY",
		);
		assert.equal((await listTickets(board)).length, 0);
	});

	it("rejects an empty batch", async () => {
		const board = await makeBoard();
		await expectFitError(
			createTickets({ board, tickets: [] }),
			"NOTHING_TO_CREATE",
		);
	});

	it("enforces short-name uniqueness across the whole board", async () => {
		const board = await makeBoard();
		await createTicket({
			board,
			content: "First project.",
			slug: "shared-name",
			status: "open/project-x",
		});
		const error = await expectFitError(
			createTicket({
				board,
				content: "Second project.",
				slug: "shared-name",
				status: "backlog",
			}),
			"NAME_TAKEN",
		);
		assert.match(error.hint ?? "", /shared-name-2/);
		assert.equal((await listTickets(board)).length, 1);

		const other = await createTicket({
			board,
			content: "Different.",
			slug: "other-name",
			status: "open/project-y",
		});
		await expectFitError(
			updateTicket({ board, id: other.ticket.id, slug: "shared-name" }),
			"NAME_TAKEN",
		);
		await expectFitError(
			moveTicket({ board, id: other.ticket.id, status: "closed", slug: "shared-name" }),
			"NAME_TAKEN",
		);
	});

	it("fails with NAME_TAKEN instead of silently suffixing a collision", async () => {
		const board = await makeBoard();
		const first = await createTicket({
			board,
			content: "First body.",
			slug: "same-name",
			priority: 1,
		});
		const error = await expectFitError(
			createTicket({
				board,
				content: "Second body.",
				slug: "same-name",
				priority: 1,
			}),
			"NAME_TAKEN",
		);
		assert.match(error.hint ?? "", /01-same-name-2/);
		assert.equal(first.ticket.id, "open/01-same-name.md");
		assert.equal((await listTickets(board)).length, 1);
	});

	it("normalizes status aliases and supports project subdirectories", async () => {
		const board = await makeBoard();
		const result = await createTicket({
			board,
			content: "Nested ticket.",
			status: "open/Project One",
		});
		assert.equal(result.ticket.id, "open/Project One/00-nested-ticket.md");
	});

	it("rejects creation outside open/backlog", async () => {
		const board = await makeBoard();
		await expectFitError(
			createTicket({ board, content: "x", status: "closed" }),
			"INVALID_INITIAL_STATUS",
		);
	});

	it("rejects invalid priorities and status paths", async () => {
		const board = await makeBoard();
		await expectFitError(
			createTicket({ board, content: "x", priority: -1 }),
			"INVALID_PRIORITY",
		);
		await expectFitError(
			createTicket({ board, content: "x", priority: 100 }),
			"INVALID_PRIORITY",
		);
		await expectFitError(
			createTicket({ board, content: "x", status: "../escape" }),
			"INVALID_STATUS",
		);
	});

	it("truncates derived and explicit names to 30 characters at word boundaries", async () => {
		const board = await makeBoard();
		const derived = await createTicket({
			board,
			content: "Fix every single broken link in the documentation today.",
		});
		assert.ok(Array.from(derived.ticket.shortName).length <= 30);
		assert.ok(!derived.ticket.shortName.endsWith("-"));
		assert.equal(derived.warnings.length, 0);

		const explicit = await createTicket({
			board,
			content: "Body.",
			slug: "this-is-a-deliberately-long-explicit-ticket-slug-name",
		});
		assert.ok(Array.from(explicit.ticket.shortName).length <= 30);
		assert.equal(explicit.warnings.length, 1);
		assert.match(explicit.warnings[0], /truncated to 30 characters/);
		assert.equal(slugify("one-two-three-four-five-six-seven-eight"), "one-two-three-four-five-six");
	});

	it("enforces two-digit priorities from 00 to 99", async () => {
		const board = await makeBoard();
		const zero = await createTicket({ board, content: "Highest priority.", priority: 0 });
		assert.equal(zero.ticket.id, "open/00-highest-priority.md");
		const max = await createTicket({ board, content: "Lowest priority.", priority: 99 });
		assert.equal(max.ticket.id, "open/99-lowest-priority.md");
		assert.equal(ticketFilename(1, "one"), "01-one.md");
		assert.throws(() => ticketFilename(100, "too-high"), /between 0 and 99/);
	});

	it("serializes and parses common frontmatter values", async () => {
		const board = await makeBoard();
		const result = await createTicket({
			board,
			content: "Body.",
			frontmatter: {
				owner: "alice",
				note: "a: b",
				count: 2,
				ok: true,
				empty: null,
				tags: ["one", "two"],
			},
		});
		assert.equal(result.ticket.frontmatter.owner, "alice");
		assert.equal(result.ticket.frontmatter.note, "a: b");
		assert.equal(result.ticket.frontmatter.count, 2);
		assert.equal(result.ticket.frontmatter.ok, true);
		assert.equal(result.ticket.frontmatter.empty, null);
		assert.deepEqual(result.ticket.frontmatter.tags, ["one", "two"]);
	});

	it("warns about legacy body shapes but still creates the ticket", async () => {
		const board = await makeBoard();
		const result = await createTicket({
			board,
			content: "One. Two. Three. Four.\n\n## Old heading\n\nProse.\n",
		});
		assert.ok(result.warnings.length >= 1);
		assert.match(result.warnings.join(" "), /summary has 4 sentences/);
		assert.match(result.warnings.join(" "), /level-1 or level-2 heading/);
	});
});

describe("listing and lookup", () => {
	it("orders by status, then board-relative path", async () => {
		const board = await makeBoard();
		const open10 = await createTicket({ board, content: "Ten.", priority: 10 });
		const open2 = await createTicket({ board, content: "Two.", priority: 2 });
		const backlog = await createTicket({
			board,
			content: "Later.",
			priority: 1,
			status: "backlog",
		});
		await moveTicket({ board, id: open10.ticket.id, status: "in_progress" });
		const ids = (await listTickets(board)).map((ticket) => ticket.id);
		assert.deepEqual(ids, [
			"in_progress/10-ten.md",
			open2.ticket.id,
			backlog.ticket.id,
		]);
		const counts = countTickets(await listTickets(board)).counts;
		assert.deepEqual(counts, { open: 1, in_progress: 1, backlog: 1, closed: 0 });
	});

	it("orders direct files before sub-statuses, then sub-status names recursively", async () => {
		const board = await makeBoard();
		const ids = [
			"open/zeta/00-y.md",
			"open/blocked/deep/00-z.md",
			"open/blocked/01-a.md",
			"open/blocked/00-b.md",
			"open/alpha/00-x.md",
			"open/00-direct.md",
		];
		for (const id of ids) await writeTicket(board, id, "Body.\n");
		assert.deepEqual(
			(await listTickets(board)).map((ticket) => ticket.id),
			[
				"open/00-direct.md",
				"open/alpha/00-x.md",
				"open/blocked/00-b.md",
				"open/blocked/01-a.md",
				"open/blocked/deep/00-z.md",
				"open/zeta/00-y.md",
			],
		);
	});

	it("splits priority from short name and derives the display name", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Fix the README typo.",
			slug: "fix-readme-typo",
			priority: 7,
		});
		assert.equal(created.ticket.name, "07-fix-readme-typo");
		assert.equal(created.ticket.shortName, "fix-readme-typo");
		assert.equal(created.ticket.displayName, "Fix Readme Typo");
		assert.equal(created.ticket.priority, 7);
		assert.equal(created.ticket.id, "open/07-fix-readme-typo.md");

		await writeTicket(board, "open/no-priority.md", "Legacy.\n");
		const legacy = await readTicket(board, "open/no-priority.md");
		assert.equal(legacy.priority, null);
		assert.equal(legacy.shortName, "no-priority");
		assert.equal(legacy.displayName, "No Priority");
	});

	it("promotes open tickets before backlog tickets", async () => {
		const board = await makeBoard();
		const backlog = await createTicket({
			board,
			content: "Backlog work.",
			status: "backlog",
		});
		assert.equal(nextTicketToPromote(await listTickets(board))?.id, backlog.ticket.id);

		const open = await createTicket({ board, content: "Open work." });
		assert.equal(nextTicketToPromote(await listTickets(board))?.id, open.ticket.id);
	});

	it("accepts a unique bare filename but rejects ambiguity", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Unique name.",
			slug: "unique",
		});
		const byName = await readTicket(board, "00-unique.md");
		assert.equal(byName.id, created.ticket.id);

		await writeTicket(board, "open/00-dup.md", "Duplicate name.\n");
		await writeTicket(board, "closed/00-dup.md", "Duplicate name.\n");
		const error = await expectFitError(
			readTicket(board, "00-dup.md"),
			"AMBIGUOUS_TICKET",
		);
		assert.deepEqual(error.candidates, ["open/00-dup.md", "closed/00-dup.md"]);

		const byShortName = await readTicket(board, "unique");
		assert.equal(byShortName.id, created.ticket.id);
		const byShortNameWithExt = await readTicket(board, "unique.md");
		assert.equal(byShortNameWithExt.id, created.ticket.id);
		await expectFitError(readTicket(board, "dup"), "AMBIGUOUS_TICKET");
	});

	it("rejects path traversal and Markdown outside status directories", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/00-x.md", "x\n");
		await writeFile(join(board, "FIT_SPEC.md"), "# spec\n");
		await expectFitError(readTicket(board, "../outside.md"), "INVALID_ID");
		await expectFitError(
			readTicket(board, join(board, "FIT_SPEC.md")),
			"NOT_A_TICKET",
		);
	});

	it("rejects a ticket outside the canonical statuses in Strict mode", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "STRICT"), '"0.5"\n');
		await writeTicket(board, "notes/00-x.md", "Body.\n");
		await expectFitError(readTicket(board, "00-x.md"), "NOT_A_TICKET");
	});

	it("ignores root-level Markdown when listing", async () => {
		const board = await makeBoard();
		await writeFile(join(board, "FIT_SPEC.md"), "# spec\n");
		await createTicket({ board, content: "A ticket." });
		const tickets = await listTickets(board);
		assert.equal(tickets.length, 1);
		assert.equal(tickets[0].id, "open/00-a-ticket.md");
	});
});

describe("moving tickets", () => {
	it("preserves project subdirectories on top-level status moves", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Project work.",
			status: "open/project-x",
			priority: 5,
		});
		const moved = await moveTicket({
			board,
			id: created.ticket.id,
			status: "closed",
		});
		assert.equal(moved.toId, "closed/project-x/05-project-work.md");
		assert.equal(moved.changed, true);
	});

	it("is idempotent when already in the target status", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Stay." });
		const moved = await moveTicket({
			board,
			id: created.ticket.id,
			status: "open",
		});
		assert.equal(moved.changed, false);
		assert.equal(moved.toId, created.ticket.id);
	});

	it("does not silently suffix a ticket that would collide in the target directory", async () => {
		const board = await makeBoard();
		const first = await createTicket({
			board,
			content: "First.",
			slug: "clash",
			priority: 1,
		});
		await moveTicket({ board, id: first.ticket.id, status: "closed" });
		const second = await createTicket({
			board,
			content: "Second.",
			slug: "clash-two",
			priority: 1,
		});
		const error = await expectFitError(
			moveTicket({
				board,
				id: second.ticket.id,
				status: "closed",
				slug: "clash",
			}),
			"NAME_TAKEN",
		);
		assert.match(error.hint ?? "", /01-clash-2/);
		assert.equal(
			(await readTicket(board, "closed/01-clash.md")).body,
			"First.\n",
		);
		assert.equal(second.ticket.id, "open/01-clash-two.md");
	});

	it("allows Basic extra status directories and sorts them after canonical ones", async () => {
		const board = await makeBoard();
		const open = await createTicket({ board, content: "Open.", slug: "open-ticket" });
		const backlog = await createTicket({
			board,
			content: "Backlog.",
			slug: "backlog-ticket",
			status: "backlog",
		});
		const closed = await createTicket({ board, content: "Closed.", slug: "closed-ticket" });
		await moveTicket({ board, id: closed.ticket.id, status: "closed" });
		const zebra = await createTicket({ board, content: "Zebra.", slug: "zebra-ticket" });
		await moveTicket({ board, id: zebra.ticket.id, status: "zebra" });
		const archive = await createTicket({ board, content: "Archive.", slug: "archive-ticket" });
		const moved = await moveTicket({ board, id: archive.ticket.id, status: "archive" });
		assert.equal(moved.toId, "archive/00-archive-ticket.md");
		assert.equal((await readTicket(board, moved.toId)).status, "archive");

		const statuses = (await listTickets(board)).map((ticket) => ticket.status);
		assert.deepEqual(statuses, ["open", "backlog", "closed", "archive", "zebra"]);
		assert.equal(open.ticket.status, "open");
		assert.equal(backlog.ticket.status, "backlog");
	});

	it("still rejects extra status directories in Strict mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-"));
		roots.push(root);
		const board = join(root, "fit");
		await initBoard(board, { strict: true });
		const created = await createTicket({ board, content: "Strict." });
		await expectFitError(
			moveTicket({ board, id: created.ticket.id, status: "archive" }),
			"INVALID_STATUS",
		);
		assert.equal((await readTicket(board, created.ticket.id)).status, "open");
	});

	it("does not write completed when the board is tracked inline", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Inline close." });
		const moved = await moveTicket({
			board,
			id: created.ticket.id,
			status: "closed",
		});
		assert.equal(moved.ticket.frontmatter.completed, undefined);
	});

	it("allows at most one in_progress ticket including sub-statuses", async () => {
		const board = await makeBoard();
		const first = await createTicket({ board, content: "First.", slug: "first" });
		await moveTicket({ board, id: first.ticket.id, status: "in_progress/review" });
		const second = await createTicket({ board, content: "Second.", slug: "second" });

		const error = await expectFitError(
			moveTicket({ board, id: second.ticket.id, status: "in_progress" }),
			"IN_PROGRESS_LIMIT",
		);
		assert.deepEqual(error.candidates, ["in_progress/review/00-first.md"]);
		await expectFitError(
			moveTicket({ board, id: second.ticket.id, status: "in_progress/deep" }),
			"IN_PROGRESS_LIMIT",
		);

		const movedWithin = await moveTicket({
			board,
			id: "in_progress/review/00-first.md",
			status: "in_progress/other",
		});
		assert.equal(movedWithin.changed, true);
	});

	it("rejects stale revisions", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Original." });
		await updateTicket({
			board,
			id: created.ticket.id,
			body: "Changed.",
		});
		await expectFitError(
			moveTicket({
				board,
				id: created.ticket.id,
				status: "closed",
				expectedRevision: created.ticket.revision,
			}),
			"STALE_TICKET",
		);
	});
});

describe("name cleanup", () => {
	it("truncates long ticket names at a hyphen boundary", async () => {
		const board = await makeBoard();
		const stem =
			"01-this-is-a-very-long-ticket-name-that-keeps-going-and-going-and-going-and-going";
		await writeTicket(board, `open/${stem}.md`, "Body.\n");

		const result = await cleanupTicketNames(board);
		assert.equal(result.renamed.length, 1);
		assert.equal(result.maxLength, DEFAULT_MAX_TICKET_NAME_CHARS);
		const nextStem = result.renamed[0].toId.split("/").pop()?.replace(/\.md$/, "");
		assert.equal(nextStem, truncateTicketName(stem, DEFAULT_MAX_TICKET_NAME_CHARS));
		assert.ok(Array.from(nextStem ?? "").length <= DEFAULT_MAX_TICKET_NAME_CHARS);
		assert.match(nextStem ?? "", /^01-/);
		assert.equal(await readFile(join(board, ...result.renamed[0].toId.split("/")), "utf8"), "Body.\n");
		assert.equal((await listTickets(board)).length, 1);
	});

	it("accepts a custom maximum length", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/03-one-two-three-four-five-six.md", "Body.\n");
		const result = await cleanupTicketNames(board, { maxLength: 14 });
		assert.equal(result.maxLength, 14);
		assert.equal(result.renamed[0].toId, "open/03-one-two.md");
		assert.equal(truncateTicketName("03-one-two-three-four", 14), "03-one-two");
	});

	it("previews without modifying the board when dryRun is set", async () => {
		const board = await makeBoard();
		const id = "open/01-aaaaaaaa-bbbbbbbb-cccccccc-dddddddd.md";
		await writeTicket(board, id, "Body.\n");
		const result = await cleanupTicketNames(board, { maxLength: 20, dryRun: true });
		assert.equal(result.dryRun, true);
		assert.equal(result.renamed.length, 1);
		await access(join(board, ...id.split("/")));
		assert.equal((await listTickets(board)).length, 1);
	});

	it("keeps collisions as suffixes instead of overwriting", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/01-aaaa-bbbb-cccc-dddd.md", "First.\n");
		await writeTicket(board, "open/01-aaaa-bbbb-cccc-eeee.md", "Second.\n");
		const result = await cleanupTicketNames(board, { maxLength: 13 });
		assert.deepEqual(
			result.renamed.map((rename) => rename.toId),
			["open/01-aaaa-bbbb.md", "open/01-aaaa-bbbb-2.md"],
		);
		assert.equal((await listTickets(board)).length, 2);
	});

	it("leaves names that are already short enough alone", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/04-short-name.md", "Body.\n");
		const result = await cleanupTicketNames(board, { maxLength: 40 });
		assert.equal(result.renamed.length, 0);
		assert.equal(result.skipped, 1);
	});

	it("rejects invalid maximum lengths", async () => {
		const board = await makeBoard();
		await expectFitError(
			cleanupTicketNames(board, { maxLength: 4 }),
			"INVALID_MAX_LENGTH",
		);
	});
});

describe("archiving tickets", () => {
	it("appends a fenced record, then removes the closed ticket", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Archive me.",
			priority: 3,
			slug: "archive-me",
		});
		await moveTicket({ board, id: created.ticket.id, status: "closed" });
		const closed = await readTicket(board, "closed/03-archive-me.md");

		const result = await archiveTicket({
			board,
			id: closed.id,
			expectedRevision: closed.revision,
		});
		assert.equal(result.recordPath, "fit/closed/03-archive-me.md");
		await expectFitError(readTicket(board, closed.id), "TICKET_NOT_FOUND");

		const archive = await readFile(join(board, "closed", "archive.txt"), "utf8");
		assert.match(archive, /^### fit\/closed\/03-archive-me\.md$/m);
		assert.match(archive, /```\nArchive me\.\n```/);
		const parsed = parseArchiveContent(archive);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.records.length, 1);
		assert.equal(parsed.records[0].path, "fit/closed/03-archive-me.md");
		assert.equal(parsed.records[0].body, closed.content);
	});

	it("rejects open tickets and stale revisions", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Not closed." });
		await expectFitError(
			archiveTicket({ board, id: created.ticket.id }),
			"NOT_CLOSED",
		);
		await moveTicket({ board, id: created.ticket.id, status: "closed" });
		await expectFitError(
			archiveTicket({
				board,
				id: "closed/00-not-closed.md",
				expectedRevision: "stale",
			}),
			"STALE_TICKET",
		);
	});

	it("restores a record into a status directory and removes it", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Roundtrip.",
			priority: 4,
			slug: "roundtrip",
		});
		await moveTicket({ board, id: created.ticket.id, status: "closed" });
		const closed = await readTicket(board, "closed/04-roundtrip.md");
		await archiveTicket({ board, id: closed.id });

		const restored = await restoreArchivedTicket({
			board,
			id: "closed/04-roundtrip.md",
			status: "open",
		});
		assert.equal(restored.ticket.id, "open/04-roundtrip.md");
		assert.equal(restored.ticket.content, closed.content);
		assert.equal(restored.remainingRecords, 0);
		await assert.rejects(access(join(board, "closed", "archive.txt")));
	});

	it("validates name uniqueness and removes only the restored record", async () => {
		const board = await makeBoard();
		const first = await createTicket({
			board,
			content: "First archived.",
			slug: "first-record",
		});
		const second = await createTicket({
			board,
			content: "Second archived.",
			slug: "second-record",
		});
		await moveTicket({ board, id: first.ticket.id, status: "closed" });
		await moveTicket({ board, id: second.ticket.id, status: "closed" });
		await archiveTicket({ board, id: "closed/00-first-record.md" });
		await archiveTicket({ board, id: "closed/00-second-record.md" });

		const restored = await restoreArchivedTicket({
			board,
			id: "fit/closed/00-first-record.md",
			status: "backlog",
		});
		assert.equal(restored.ticket.id, "backlog/00-first-record.md");
		assert.equal(restored.remainingRecords, 1);
		const remaining = await readFile(join(board, "closed", "archive.txt"), "utf8");
		assert.match(remaining, /00-second-record\.md/);
		assert.doesNotMatch(remaining, /00-first-record\.md/);

		await moveTicket({ board, id: restored.ticket.id, status: "closed" });
		await archiveTicket({ board, id: "closed/00-first-record.md" });
		await createTicket({
			board,
			content: "Collision.",
			slug: "first-record",
		});
		await expectFitError(
			restoreArchivedTicket({ board, id: "closed/00-first-record.md" }),
			"NAME_TAKEN",
		);
	});
});

describe("updating tickets", () => {
	it("is a no-op when the body is unchanged", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Same body." });
		const result = await updateTicket({
			board,
			id: created.ticket.id,
			body: "Same body.",
		});
		assert.equal(result.changed, false);
		assert.equal(result.ticket.revision, created.ticket.revision);
	});

	it("appends body text and renames without losing content", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "First line.",
			priority: 1,
			slug: "start",
		});
		const updated = await updateTicket({
			board,
			id: created.ticket.id,
			body: "Second line.",
			bodyMode: "append",
			priority: 7,
			slug: "renamed",
		});
		assert.equal(updated.changed, true);
		assert.equal(updated.ticket.id, "open/07-renamed.md");
		assert.equal(updated.previousId, "open/01-start.md");
		assert.match(updated.ticket.body, /First line\.\n\nSecond line\./);
		await expectFitError(readTicket(board, created.ticket.id), "TICKET_NOT_FOUND");
	});

	it("supports a first-class project field in frontmatter and listings", async () => {
		const board = await makeBoard();
		const created = await createTicket({
			board,
			content: "Project work.",
			slug: "project-work",
			project: "alpha",
		});
		assert.equal(created.ticket.frontmatter.project, "alpha");
		assert.equal(created.ticket.project, "alpha");
		assert.equal((await listTickets(board))[0].project, "alpha");

		const updated = await updateTicket({
			board,
			id: created.ticket.id,
			project: "beta",
		});
		assert.equal(updated.ticket.frontmatter.project, "beta");
		assert.equal(updated.ticket.project, "beta");

		const result = await checkBoard(board);
		assert.equal(
			result.issues.some(
				(issue) =>
					issue.code === "STRUCTURAL_FRONTMATTER" &&
					issue.message.includes("project"),
			),
			false,
		);
	});

	it("rejects a rename that collides instead of suffixing", async () => {
		const board = await makeBoard();
		await createTicket({ board, content: "Other.", slug: "taken", priority: 1 });
		const created = await createTicket({
			board,
			content: "Original.",
			slug: "mine",
			priority: 2,
		});
		await expectFitError(
			updateTicket({ board, id: created.ticket.id, slug: "taken", priority: 1 }),
			"NAME_TAKEN",
		);
		assert.equal((await readTicket(board, created.ticket.id)).body, "Original.\n");
	});

	it("preserves unrelated frontmatter YAML and comments", async () => {
		const board = await makeBoard();
		const path = await writeTicket(
			board,
			"open/00-meta.md",
			[
				"---",
				"owner: alice",
				"# keep this comment",
				"meta:",
				"  nested: true",
				"tags:",
				"  - one",
				"  - two",
				"---",
				"Body.",
				"",
			].join("\n"),
		);
		const updated = await updateTicket({
			board,
			id: "open/00-meta.md",
			set: { owner: "bob", reviewed: true },
			unset: ["tags"],
		});
		const raw = await readFile(path, "utf8");
		assert.match(raw, /# keep this comment/);
		assert.match(raw, /meta:\n {2}nested: true/);
		assert.match(raw, /owner: bob/);
		assert.match(raw, /reviewed: true/);
		assert.doesNotMatch(raw, /tags:/);
		assert.equal(updated.ticket.frontmatter.owner, "bob");
		assert.equal(updated.ticket.frontmatter.reviewed, true);
	});

	it("rejects stale revisions", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Original." });
		await updateTicket({ board, id: created.ticket.id, body: "Changed once." });
		await expectFitError(
			updateTicket({
				board,
				id: created.ticket.id,
				body: "Changed twice.",
				expectedRevision: created.ticket.revision,
			}),
			"STALE_TICKET",
		);
	});

	it("requires an actual requested change", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Body." });
		await expectFitError(
			updateTicket({ board, id: created.ticket.id }),
			"NOTHING_TO_UPDATE",
		);
	});
});

describe("recording closed ticket commits", () => {
	async function makeParentRepo(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-git-"));
		roots.push(root);
		await writeFile(join(root, "work.txt"), "work\n", "utf8");
		git(root, ["init", "-q"]);
		git(root, ["add", "-A"]);
		git(root, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-q",
			"-m",
			"initial",
		]);
		return root;
	}

	it("records the parent commit on closed tickets and commits the board", async () => {
		const root = await makeParentRepo();
		const parentHead = git(root, ["rev-parse", "HEAD"]);
		const board = join(root, "fit");
		await initBoard(board, { git: true });
		await writeTicket(board, "closed/00-record-me.md", "---\nowner: alice\n---\n\nBody.\n");
		await writeTicket(board, "closed/01-already-recorded.md", "---\ncommit: abc123\n---\n\nBody.\n");

		const result = await recordClosedTicketsCommit(board);
		assert.equal(result.commitHash, parentHead);
		assert.deepEqual(result.recorded, ["closed/00-record-me.md"]);
		assert.equal(result.skipped, 1);
		assert.equal(result.committed, true);
		assert.equal(result.commitMessage, "FIT: close record-me");

		const ticket = await readTicket(board, "closed/00-record-me.md");
		assert.equal(ticket.frontmatter.commit, parentHead);
		assert.equal(ticket.frontmatter.owner, "alice");
		assert.equal(git(root, ["rev-parse", "HEAD"]), parentHead);
		assert.match(git(board, ["log", "-1", "--pretty=%s"]), /^FIT: close record-me$/);

		const retry = await recordClosedTicketsCommit(board);
		assert.equal(retry.recorded.length, 0);
		assert.equal(retry.skipped, 2);
		assert.equal(retry.committed, false);
	});

	it("writes completed on close when the board is separate", async () => {
		const root = await makeParentRepo();
		const board = join(root, "fit");
		await initBoard(board, { git: true });
		const created = await createTicket({ board, content: "Finish this.", slug: "finish" });
		const moved = await moveTicket({
			board,
			id: created.ticket.id,
			status: "closed",
		});
		assert.match(
			String(moved.ticket.frontmatter.completed),
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);

		await writeTicket(
			board,
			"open/01-keep-completed.md",
			"---\ncompleted: 2020-01-02\n---\n\nBody.\n",
		);
		const kept = await moveTicket({
			board,
			id: "open/01-keep-completed.md",
			status: "closed",
		});
		assert.equal(kept.ticket.frontmatter.completed, "2020-01-02");
	});

	it("commits a close on the board branch for separate boards", async () => {
		const root = await makeParentRepo();
		const parentHead = git(root, ["rev-parse", "HEAD"]);
		const board = join(root, "fit");
		await initBoard(board, { git: true });
		const created = await createTicket({ board, content: "Finish this.", slug: "finish" });
		const moved = await moveTicket({
			board,
			id: created.ticket.id,
			status: "closed",
		});
		assert.equal(moved.committed, true);
		assert.match(git(board, ["log", "-1", "--pretty=%s"]), /^FIT: close finish$/);
		assert.equal(git(root, ["rev-parse", "HEAD"]), parentHead);
		assert.ok(moved.ticket.frontmatter.completed);

		const again = await moveTicket({
			board,
			id: moved.toId,
			status: "closed",
		});
		assert.equal(again.changed, false);
		assert.equal(again.committed, false);
	});

	it("leaves close moves inline for the parent work commit", async () => {
		const board = await makeBoard();
		const root = dirname(board);
		git(root, ["init", "-q"]);
		git(root, ["add", "-A"]);
		git(root, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-q",
			"-m",
			"initial",
		]);
		const created = await createTicket({ board, content: "Inline close.", slug: "inline" });
		const moved = await moveTicket({ board, id: created.ticket.id, status: "closed" });
		assert.equal(moved.changed, true);
		assert.equal(moved.committed, false);
		assert.equal(moved.ticket.frontmatter.completed, undefined);

		const result = await recordClosedTicketsCommit(board);
		assert.equal(result.inline, true);
		assert.deepEqual(result.recorded, []);
		assert.equal(result.committed, false);
	});

	it("does not treat inline boards as a layout error", async () => {
		const board = await makeBoard();
		const root = dirname(board);
		git(root, ["init", "-q"]);
		git(root, ["add", "-A"]);
		git(root, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-q",
			"-m",
			"initial",
		]);
		await writeTicket(board, "closed/00-record-me.md", "Body.\n");

		const result = await recordClosedTicketsCommit(board);
		assert.equal(result.inline, true);
		assert.equal(result.skipped, 1);
	});
});

describe("migration report", () => {
	it("reports priorities, long names, duplicates, and legacy bodies without changing files", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/123-three.md", "Body.\n");
		await writeTicket(board, `open/00-${"a".repeat(31)}.md`, "Body.\n");
		await writeTicket(board, "open/00-dup.md", "Body.\n");
		await writeTicket(board, "backlog/00-dup.md", "Body.\n");
		await writeTicket(
			board,
			"open/00-legacy-body.md",
			"Summary sentence.\n\n## Old section\n\nProse.\n",
		);
		await writeTicket(board, "open/00-clean.md", "Summary.\n\n### Notes\n\nDetail.\n");

		const before = (await listTickets(board)).map((ticket) => ticket.id);
		const report = await migrationReport(board);
		assert.equal(report.dryRun, true);
		assert.equal(report.mode.mode, "basic");
		assert.equal(report.total, before.length);

		const priority = report.actions.find((action) => action.kind === "priority");
		assert.equal(priority?.id, "open/123-three.md");
		assert.equal(priority?.suggestedId, "open/12-three.md");

		const shortName = report.actions.find(
			(action) => action.kind === "short-name",
		);
		assert.equal(shortName?.id, `open/00-${"a".repeat(31)}.md`);
		assert.ok(
			Array.from(shortName?.suggestedShortName ?? "").length < 30,
		);

		const duplicates = report.actions.filter(
			(action) => action.kind === "duplicate-name",
		);
		assert.equal(duplicates.length, 2);
		assert.ok(duplicates.some((action) => action.suggestedId === "backlog/00-dup-2.md"));

		const body = report.actions.find((action) => action.kind === "body");
		assert.equal(body?.id, "open/00-legacy-body.md");
		assert.match(body?.message ?? "", /level-1 or level-2 heading/);
		assert.equal(
			report.actions.some((action) => action.id === "open/00-clean.md"),
			false,
		);

		const after = (await listTickets(board)).map((ticket) => ticket.id);
		assert.deepEqual(after, before);
	});

	it("flags summaries longer than three sentences and stray prose", async () => {
		const board = await makeBoard();
		await writeTicket(
			board,
			"open/00-too-many.md",
			"One. Two. Three. Four.\n",
		);
		await writeTicket(
			board,
			"open/01-stray.md",
			"Summary.\n\nStray paragraph.\n",
		);
		const report = await migrationReport(board);
		const bodies = report.actions.filter((action) => action.kind === "body");
		assert.equal(bodies.length, 2);
		assert.match(bodies[0].message, /summary has 4 sentences/);
		assert.match(bodies[1].message, /outside a level-3 section/);
	});
});

describe("body normalization", () => {
	it("keeps a three-sentence summary and groups the rest under level-3 headers", () => {
		assert.equal(
			normalizeBodyForStrict("One. Two. Three. Four.\n"),
			"One. Two. Three.\n\n### Notes\n\nFour.",
		);
		assert.equal(
			normalizeBodyForStrict("Summary.\n\n## Old heading\n\nProse.\n"),
			"Summary.\n\n### Old heading\n\nProse.",
		);
		assert.equal(
			normalizeBodyForStrict("Summary.\n\nStray paragraph.\n"),
			"Summary.\n\n### Notes\n\nStray paragraph.",
		);
	});

	it("supports a dry run and preserves frontmatter on write", async () => {
		const board = await makeBoard();
		const id = "open/00-legacy.md";
		await writeTicket(
			board,
			id,
			"---\nowner: alice\n---\n\nOne. Two. Three. Four.\n\n## Old\n\nProse.\n",
		);
		const before = await readFile(join(board, ...id.split("/")), "utf8");

		const preview = await normalizeLegacyBodies(board, { dryRun: true });
		assert.equal(preview.dryRun, true);
		assert.equal(preview.changed.length, 1);
		assert.equal(await readFile(join(board, ...id.split("/")), "utf8"), before);

		const written = await normalizeLegacyBodies(board);
		assert.equal(written.changed.length, 1);
		const ticket = await readTicket(board, id);
		assert.equal(ticket.frontmatter.owner, "alice");
		assert.equal(
			ticket.body.trim(),
			"One. Two. Three.\n\n### Notes\n\nFour.\n\n### Old\n\nProse.",
		);
		assert.deepEqual(await normalizeLegacyBodies(board), {
			changed: [],
			dryRun: false,
		});
	});

	it("reports body structure and summary length in checks", async () => {
		const board = await makeBoard();
		await writeTicket(
			board,
			"open/00-bad-shape.md",
			"One. Two. Three. Four.\n\n## Old\n",
		);
		const basic = await checkBoard(board);
		assert.equal(
			basic.issues.find((issue) => issue.code === "TICKET_BODY_SECTIONS")
				?.severity,
			"warning",
		);
		assert.equal(
			basic.issues.find((issue) => issue.code === "TICKET_SUMMARY_LENGTH")
				?.severity,
			"warning",
		);

		await writeFile(join(board, "STRICT"), `"${FIT_SPEC_VERSION}"\n`);
		const strict = await checkBoard(board);
		assert.equal(
			strict.issues.find((issue) => issue.code === "TICKET_BODY_SECTIONS")
				?.severity,
			"error",
		);
		assert.equal(
			strict.issues.find((issue) => issue.code === "TICKET_SUMMARY_LENGTH")
				?.severity,
			"warning",
		);

		await normalizeLegacyBodies(board);
		const after = await checkBoard(board);
		assert.equal(
			after.issues.some((issue) =>
				["TICKET_BODY_SECTIONS", "TICKET_SUMMARY_LENGTH"].includes(issue.code),
			),
			false,
		);
	});
});

describe("board checks", () => {
	it("defines a unique, mode-aware rule registry", () => {
		const ids = CHECK_RULES.map((rule) => rule.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const rule of CHECK_RULES) {
			assert.ok(Object.keys(rule.severity).length > 0, rule.id);
			for (const value of Object.values(rule.severity)) {
				assert.ok(value === "error" || value === "warning", rule.id);
			}
		}
		assert.equal(checkRuleSeverity("MISSING_STATUS_DIR", "basic"), "error");
		assert.equal(checkRuleSeverity("STRICT_BOARD_NAME", "basic"), undefined);
		assert.equal(checkRuleSeverity("STRICT_BOARD_NAME", "strict"), "error");
		assert.equal(checkRuleSeverity("MISSING_PRIORITY", "basic"), "warning");
		assert.equal(checkRuleSeverity("MISSING_PRIORITY", "strict"), "error");
	});

	it("runs Basic rules always and Strict rules only in Strict mode", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/00-open.md", "Body.\n");
		await mkdir(join(board, "archive"));

		const basic = await checkBoard(board);
		assert.equal(basic.mode.mode, "basic");
		assert.equal(
			basic.issues.some((issue) => issue.code === "STRICT_EXTRA_STATUS"),
			false,
		);

		await writeFile(join(board, "STRICT"), `"${FIT_SPEC_VERSION}"\n`);
		const strict = await checkBoard(board);
		assert.equal(strict.mode.mode, "strict");
		assert.equal(strict.mode.version, FIT_SPEC_VERSION);
		assert.ok(
			strict.issues.some(
				(issue) =>
					issue.code === "STRICT_EXTRA_STATUS" && issue.severity === "error",
			),
		);
	});

	it("reports issues without modifying files", async () => {
		const board = await makeBoard();
		await createTicket({ board, content: "x".repeat(300) });
		await writeTicket(board, "open/Bad Name.md", "Body.\n");
		await writeFile(join(board, "NOTES.md"), "# notes\n");
		const result = await checkBoard(board);
		const codes = result.issues.map((issue) => issue.code);
		assert.ok(codes.includes("TICKET_FILENAME_FORMAT"));
		assert.ok(codes.includes("ROOT_MARKDOWN"));
		assert.equal(
			result.issues.some((issue) => issue.severity === "error"),
			false,
		);
	});

	it("reports missing status directories as errors", async () => {
		const board = await makeBoard();
		await rm(join(board, "closed"), { recursive: true, force: true });
		const result = await checkBoard(board);
		assert.ok(
			result.issues.some(
				(issue) =>
					issue.code === "MISSING_STATUS_DIR" && issue.severity === "error",
			),
		);
	});

	it("reports missing and non-two-digit priorities separately", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/123-three-digits.md", "Body.\n");
		await writeTicket(board, "open/7-one-digit.md", "Body.\n");
		await writeTicket(board, "open/no-priority.md", "Body.\n");
		await writeTicket(board, "open/03-good.md", "Body.\n");

		const tickets = await listTickets(board);
		assert.equal(tickets.find((ticket) => ticket.filename === "123-three-digits.md")?.priority, null);
		assert.equal(tickets.find((ticket) => ticket.filename === "7-one-digit.md")?.priority, null);
		assert.equal(tickets.find((ticket) => ticket.filename === "no-priority.md")?.priority, null);
		assert.equal(tickets.find((ticket) => ticket.filename === "03-good.md")?.priority, 3);

		const result = await checkBoard(board);
		const noPriority = result.issues.filter((issue) => issue.code === "MISSING_PRIORITY");
		const nonTwoDigit = result.issues.filter(
			(issue) => issue.code === "NON_TWO_DIGIT_PRIORITY",
		);
		assert.equal(noPriority.length, 1);
		assert.equal(noPriority[0].id, "open/no-priority.md");
		assert.equal(nonTwoDigit.length, 2);
		assert.deepEqual(
			nonTwoDigit.map((issue) => issue.id).sort(),
			["open/123-three-digits.md", "open/7-one-digit.md"],
		);
	});

	it("applies strict name checks as warnings in Basic and errors in Strict", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/00-good.md", "Body.\n");
		await writeTicket(board, "open/00-Bad.md", "Body.\n");
		await writeTicket(board, "open/00-under_score.md", "Body.\n");
		await writeTicket(board, "open/con.md", "Body.\n");
		await writeTicket(board, "open/00-trailing..md", "Body.\n");
		await writeTicket(board, "backlog/00-Bad.md", "Body.\n");
		await writeTicket(
			board,
			`closed/00-${"a".repeat(30)}.md`,
			"Body.\n",
		);

		const basic = await checkBoard(board);
		const basicName = basic.issues.filter((issue) =>
			[
				"TICKET_FILENAME_FORMAT",
				"TICKET_FILENAME_SAFE",
				"TICKET_NAME_UNIQUE",
				"TICKET_SHORT_NAME_LENGTH",
			].includes(issue.code),
		);
		assert.ok(basicName.length > 0);
		assert.ok(basicName.every((issue) => issue.severity === "warning"));
		assert.ok(
			basic.issues.some(
				(issue) =>
					issue.code === "TICKET_FILENAME_SAFE" && issue.id === "open/con.md",
			),
		);
		assert.ok(
			basic.issues.some(
				(issue) =>
					issue.code === "TICKET_NAME_UNIQUE" &&
					issue.message.includes("Bad"),
			),
		);

		await writeFile(join(board, "STRICT"), `"${FIT_SPEC_VERSION}"\n`);
		const strict = await checkBoard(board);
		const strictName = strict.issues.filter((issue) =>
			[
				"TICKET_FILENAME_FORMAT",
				"TICKET_FILENAME_SAFE",
				"TICKET_NAME_UNIQUE",
				"TICKET_SHORT_NAME_LENGTH",
			].includes(issue.code),
		);
		assert.ok(strictName.length > 0);
		assert.ok(
			strictName
				.filter((issue) => issue.code !== "TICKET_SHORT_NAME_LENGTH")
				.every((issue) => issue.severity === "error"),
		);
		assert.equal(
			strictName.find((issue) => issue.code === "TICKET_SHORT_NAME_LENGTH")
				?.severity,
			"warning",
		);
		assert.equal(
			strict.issues.some((issue) =>
				["LONG_BODY", "EMPTY_BODY", "FILENAME_CONVENTION", "DUPLICATE_FILENAME"].includes(
					issue.code,
				),
			),
			false,
		);
	});

	it("enforces URL- and OS-safe filenames in Strict mode and warns in Basic", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/00-ok-name.md", "Body.\n");
		await writeTicket(board, "open/00-Upper.md", "Body.\n");
		await writeTicket(board, "open/00-hash#tag.md", "Body.\n");
		await writeTicket(board, "open/con.md", "Body.\n");
		await writeTicket(board, "open/00-trailing..md", "Body.\n");
		await writeTicket(board, "open/00-space name.md", "Body.\n");

		const basic = await checkBoard(board);
		const basicSafe = basic.issues.filter(
			(issue) => issue.code === "TICKET_FILENAME_SAFE",
		);
		assert.ok(basicSafe.length >= 4);
		assert.ok(basicSafe.every((issue) => issue.severity === "warning"));
		assert.equal(
			basicSafe.some((issue) => issue.id === "open/00-ok-name.md"),
			false,
		);

		await writeFile(join(board, "STRICT"), `"${FIT_SPEC_VERSION}"\n`);
		const strict = await checkBoard(board);
		const safe = strict.issues.filter(
			(issue) => issue.code === "TICKET_FILENAME_SAFE",
		);
		assert.ok(safe.every((issue) => issue.severity === "error"));
		const byId = new Map(safe.map((issue) => [issue.id, issue.message]));
		assert.match(byId.get("open/00-hash#tag.md") ?? "", /URL-illegal/);
		assert.match(byId.get("open/con.md") ?? "", /reserved Windows/);
		assert.match(byId.get("open/00-trailing..md") ?? "", /trailing|ends with a dot/);
		assert.match(byId.get("open/00-space name.md") ?? "", /URL-illegal/);
		assert.equal(byId.has("open/00-ok-name.md"), false);

		assert.match(
			ticketFilenameProblems("00-colon:name.md").join(" "),
			/illegal on Windows or macOS/,
		);
		assert.match(
			ticketFilenameProblems("00-star*.md").join(" "),
			/illegal on Windows or macOS/,
		);
		assert.match(
			ticketFilenameProblems("00-back\\slash.md").join(" "),
			/illegal on Windows or macOS/,
		);

		const upper = strict.issues.filter(
			(issue) =>
				issue.code === "TICKET_FILENAME_FORMAT" && issue.id === "open/00-Upper.md",
		);
		assert.equal(upper.length, 1);
	});

	it("treats extra top-level status directories as valid in Basic mode", async () => {
		const board = await makeBoard();
		await writeTicket(board, "open/00-open.md", "Body.\n");
		await writeTicket(board, "archive/00-archived.md", "Body.\n");
		const result = await checkBoard(board);
		assert.equal(
			result.issues.some((issue) => issue.code === "NON_CANONICAL_STATUS"),
			false,
		);
		assert.equal(
			result.issues.some((issue) => issue.code === "STRICT_EXTRA_STATUS"),
			false,
		);
		assert.equal(result.issues.some((issue) => issue.severity === "error"), false);
	});

	it("enforces Strict board name, location, statuses, and file whitelist", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-pi-strict-"));
		roots.push(root);
		await mkdir(join(root, ".git"));
		const board = join(root, "nested", "notfit");
		await initBoard(board, { strict: true });
		await writeTicket(board, "open/00-open.md", "Body.\n");
		await writeTicket(board, "archive/00-extra.md", "Body.\n");
		await writeTicket(board, "open/notes.txt", "Not a ticket.\n");
		await writeTicket(board, "open/diagram.png", "image");
		await writeTicket(board, "closed/archive.txt", "");

		const result = await checkBoard(board);
		const codes = new Set(result.issues.map((issue) => issue.code));
		assert.ok(codes.has("STRICT_BOARD_NAME"));
		assert.ok(codes.has("STRICT_BOARD_LOCATION"));
		assert.ok(codes.has("STRICT_EXTRA_STATUS"));
		assert.ok(codes.has("STRICT_STATUS_FILE"));
		assert.ok(codes.has("NON_CANONICAL_STATUS"));
		assert.equal(
			result.issues.some(
				(issue) =>
					issue.code === "STRICT_STATUS_FILE" &&
					(issue.id === "open/diagram.png" || issue.id === "closed/archive.txt"),
			),
			false,
		);
	});

	it("skips archive.txt as a ticket and validates archive records", async () => {
		const board = await makeBoard();
		const created = await createTicket({ board, content: "Archive body.", slug: "archive-body" });
		await moveTicket({ board, id: created.ticket.id, status: "closed" });
		await archiveTicket({ board, id: "closed/00-archive-body.md" });

		let result = await checkBoard(board);
		assert.equal(result.total, 0);
		assert.equal(
			result.issues.some((issue) => issue.code === "ARCHIVE_RECORD_INVALID"),
			false,
		);

		await writeTicket(
			board,
			"closed/archive.txt",
			[
				"### closed/00-no-board-prefix.md",
				"```",
				"Body.",
				"```",
				"",
				"### fit/closed/01-missing-fence.md",
				"Body.",
				"",
			].join("\n"),
		);
		result = await checkBoard(board);
		const archiveIssues = result.issues.filter(
			(issue) => issue.code === "ARCHIVE_RECORD_INVALID",
		);
		assert.ok(archiveIssues.length >= 2);
		assert.ok(archiveIssues.every((issue) => issue.id === "closed/archive.txt"));
		assert.equal(result.total, 0);
	});

	it("reports invalid YAML and only warns for an exact unclosed delimiter", async () => {
		const board = await makeBoard();
		await writeTicket(
			board,
			"open/00-invalid.md",
			"---\nnot yaml\n---\nBody.\n",
		);
		await writeTicket(
			board,
			"open/01-unclosed.md",
			"---\nowner: alice\nBody.\n",
		);
		await writeTicket(
			board,
			"open/02-spaced.md",
			" ---\nowner: alice\n---\nBody.\n",
		);
		const result = await checkBoard(board);
		assert.deepEqual(
			result.issues
				.filter((issue) => issue.code === "INVALID_YAML")
				.map((issue) => issue.id),
			["open/00-invalid.md"],
		);
		assert.deepEqual(
			result.issues
				.filter((issue) => issue.code === "UNCLOSED_FRONTMATTER")
				.map((issue) => issue.id),
			["open/01-unclosed.md"],
		);
	});

	it("validates defined frontmatter keys and flags structural duplicates", async () => {
		const board = await makeBoard();
		await writeTicket(
			board,
			"open/00-invalid-meta.md",
			[
				"---",
				"completed: 2025-02-30",
				"commit: not-a-hash",
				"project: [one, two]",
				"status: open",
				"name: bogus-name",
				"---",
				"Body.",
				"",
			].join("\n"),
		);
		await writeTicket(
			board,
			"open/01-valid-meta.md",
			[
				"---",
				"completed: 2025-01-02T03:04:05Z",
				"commit: abc1234",
				"project: fit-0.5",
				"---",
				"Body.",
				"",
			].join("\n"),
		);

		const result = await checkBoard(board);
		const invalid = result.issues.filter(
			(issue) => issue.code === "INVALID_FRONTMATTER_VALUE",
		);
		assert.deepEqual(
			invalid.map((issue) => issue.message.match(/"([^"]+)"/)?.[1]).sort(),
			["commit", "completed", "project"],
		);
		const structural = result.issues.filter(
			(issue) => issue.code === "STRUCTURAL_FRONTMATTER",
		);
		assert.deepEqual(
			structural.map((issue) => issue.message.match(/"([^"]+)"/)?.[1]).sort(),
			["name", "status"],
		);
		assert.equal(
			result.issues.some(
				(issue) =>
					issue.id === "open/01-valid-meta.md" &&
					["INVALID_FRONTMATTER_VALUE", "STRUCTURAL_FRONTMATTER"].includes(issue.code),
			),
			false,
		);
	});
});

describe("frontmatter helpers", () => {
	it("splits frontmatter and treats unclosed frontmatter as body", () => {
		assert.deepEqual(splitFrontmatter("---\na: 1\n---\nBody\n"), {
			raw: "a: 1",
			body: "Body\n",
		});
		assert.deepEqual(splitFrontmatter("---\na: 1\nBody\n"), {
			raw: null,
			body: "---\na: 1\nBody\n",
		});
		assert.deepEqual(splitFrontmatter(" ---\na: 1\n---\nBody\n"), {
			raw: null,
			body: " ---\na: 1\n---\nBody\n",
		});
		assert.deepEqual(splitFrontmatter("---\na: 1\n ---\nBody\n"), {
			raw: null,
			body: "---\na: 1\n ---\nBody\n",
		});
	});

	it("validates the supported YAML subset", () => {
		assert.deepEqual(
			validateFrontmatterYaml([
				"name: alice",
				"# comment",
				"tags: [one, two]",
				"items:",
				"  - first",
				"meta:",
				"  nested: true",
			].join("\n")),
			[],
		);
		assert.equal(validateFrontmatterYaml("not yaml").length, 1);
		assert.match(validateFrontmatterYaml("\tname: alice")[0], /tabs/);
		assert.match(validateFrontmatterYaml("tags: [one, two")[0], /unterminated/);
	});

	it("parses scalars, inline arrays, and block lists", () => {
		const parsed = parseFrontmatter(
			[
				"name: alice",
				"count: 2",
				"ok: true",
				"nothing: null",
				"tags: [one, two]",
				"items:",
				"  - first",
				"  - second",
			].join("\n"),
		);
		assert.deepEqual(parsed, {
			name: "alice",
			count: 2,
			ok: true,
			nothing: null,
			tags: ["one", "two"],
			items: ["first", "second"],
		});
	});

	it("replaces a key without leaving its old continuation lines", () => {
		const raw = updateFrontmatterRaw(
			"tags:\n  - old\n  - stale\nowner: alice",
			{ tags: ["new"] },
			[],
		);
		assert.equal(raw, "tags: [new]\nowner: alice");
	});

	it("composes frontmatter and body deterministically", () => {
		assert.equal(
			composeTicket("a: 1", "Body.\n"),
			"---\na: 1\n---\n\nBody.\n",
		);
		assert.equal(composeTicket(null, "Body."), "Body.\n");
	});
});

describe("naming helpers", () => {
	it("pins the v0.5 limits", () => {
		assert.equal(FIT_SPEC_VERSION, "0.5");
		assert.equal(MAX_PRIORITY, 99);
		assert.equal(DEFAULT_MAX_TICKET_NAME_CHARS, 30);
	});

	it("slugifies and derives titles", () => {
		assert.equal(slugify("  Fix: the README!  "), "fix-the-readme");
		assert.equal(slugify(""), "ticket");
		assert.equal(deriveTitle("## Fix typo.\nMore."), "Fix typo.");
		assert.equal(deriveTitle("Title without period"), "Title without period");
		assert.equal(
			deriveTicketName("One two three four five six seven eight nine. More."),
			"One two three four five six seven",
		);
		assert.equal(deriveTicketName("Short title."), "Short title.");
	});
});
