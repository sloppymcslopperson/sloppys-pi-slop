import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	boardIgnorePattern,
	commitWorktreePath,
	mergeGitignoreContent,
	moveBoardAside,
} from "../src/git.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "fit-git-"));
	roots.push(root);
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "System User"]);
	git(root, ["config", "user.email", "system@example.com"]);
	return root;
}

function lastAuthor(cwd: string): string {
	return git(cwd, ["log", "-1", "--format=%an <%ae>"]);
}

describe("commit identity", () => {
	it("uses [git] name and email from conf.toml", async () => {
		const root = await makeRepo();
		await writeFile(
			join(root, "conf.toml"),
			'[git]\nname = "Sloppy McSlopperson"\nemail = "sloppy@example.com"\n',
			"utf8",
		);
		await writeFile(join(root, "ticket.md"), "ticket\n", "utf8");

		assert.equal(await commitWorktreePath(root, "FIT: close ticket"), true);
		assert.equal(lastAuthor(root), "Sloppy McSlopperson <sloppy@example.com>");
	});

	it("falls back to the system identity without conf.toml", async () => {
		const root = await makeRepo();
		await writeFile(join(root, "ticket.md"), "ticket\n", "utf8");

		assert.equal(await commitWorktreePath(root, "FIT: close ticket"), true);
		assert.equal(lastAuthor(root), "System User <system@example.com>");
	});

	it("falls back to the system identity for a partial conf.toml", async () => {
		const root = await makeRepo();
		await writeFile(join(root, "conf.toml"), '[git]\nname = "Only Name"\n', "utf8");
		await writeFile(join(root, "ticket.md"), "ticket\n", "utf8");

		assert.equal(await commitWorktreePath(root, "FIT: close ticket"), true);
		assert.equal(lastAuthor(root), "System User <system@example.com>");
	});

	it("returns false when there is nothing to commit", async () => {
		const root = await makeRepo();
		await writeFile(join(root, "ticket.md"), "ticket\n", "utf8");
		await commitWorktreePath(root, "first");

		assert.equal(await commitWorktreePath(root, "second"), false);
	});
});

describe("move board aside", () => {
	async function makeBoardDir(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "fit-move-"));
		roots.push(root);
		const board = join(root, "fit");
		await mkdir(board, { recursive: true });
		await writeFile(join(board, "FIT_SPEC.md"), "# Fit Spec\n", "utf8");
		return board;
	}

	it("backup lives in the Git directory when the rename succeeds", async () => {
		const board = await makeBoardDir();
		const gitDir = join(dirname(board), ".git");
		await mkdir(gitDir, { recursive: true });

		const backup = await moveBoardAside(board, gitDir);

		assert.equal(dirname(backup), gitDir);
		assert.equal(await readFile(join(backup, "FIT_SPEC.md"), "utf8"), "# Fit Spec\n");
		await assert.rejects(access(board));
	});

	it("falls back to a sibling when the Git directory is on another filesystem", async () => {
		const board = await makeBoardDir();
		const gitDir = join(dirname(board), "git-dir");
		await mkdir(gitDir, { recursive: true });
		const attempts: string[] = [];
		const crossDevice = async (
			from: Parameters<typeof rename>[0],
			to: Parameters<typeof rename>[1],
		): Promise<void> => {
			const target = to.toString();
			attempts.push(target);
			if (dirname(target) === gitDir) {
				throw Object.assign(
					new Error("EXDEV: cross-device link not permitted"),
					{ code: "EXDEV" },
				);
			}
			await rename(from, to);
		};

		const backup = await moveBoardAside(board, gitDir, crossDevice);

		assert.equal(attempts.length, 2);
		assert.equal(dirname(backup), dirname(board));
		assert.match(backup, /\/\.fit-init-backup-/);
		assert.equal(await readFile(join(backup, "FIT_SPEC.md"), "utf8"), "# Fit Spec\n");
		await assert.rejects(access(board));
	});

	it("rethrows rename failures that are not EXDEV", async () => {
		const board = await makeBoardDir();
		const gitDir = join(dirname(board), "git-dir");
		await assert.rejects(
			moveBoardAside(board, gitDir, async () => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			}),
			/EACCES/,
		);
	});
});

describe("gitignore setup", () => {
	it("uses an anchored directory pattern", () => {
		assert.equal(boardIgnorePattern("/repo/fit"), "/fit/");
		assert.equal(boardIgnorePattern("/repo/docs/fit"), "/fit/");
		assert.equal(boardIgnorePattern("/repo/docs/fit", "/repo"), "/docs/fit/");
	});

	it("creates a gitignore when none exists", () => {
		const merged = mergeGitignoreContent(null, "/repo/fit");
		assert.equal(merged.changed, true);
		assert.equal(merged.content, "/fit/\n");
	});

	it("appends the board pattern and preserves existing rules", () => {
		const existing = "node_modules/\n*.log\n";
		const merged = mergeGitignoreContent(existing, "/repo/fit");
		assert.equal(merged.changed, true);
		assert.ok(merged.content.startsWith(existing));
		assert.match(merged.content, /^\/fit\/$/m);
	});

	it("does not duplicate an equivalent ignore rule", () => {
		for (const rule of ["/fit/", "fit/", "/fit", "fit"]) {
			const existing = `node_modules/\n${rule}\n`;
			const merged = mergeGitignoreContent(existing, "/repo/fit");
			assert.equal(merged.changed, false, rule);
			assert.equal(merged.content, existing);
		}
	});

	it("preserves CRLF line endings", () => {
		const merged = mergeGitignoreContent("node_modules/\r\n", "/repo/fit");
		assert.equal(merged.content, "node_modules/\r\n/fit/\r\n");
	});

	it("anchors nested boards relative to the repository root", () => {
		const merged = mergeGitignoreContent(null, "/repo/packages/fit", "/repo");
		assert.equal(merged.content, "/packages/fit/\n");
		const existing = "fit/\n";
		const appended = mergeGitignoreContent(existing, "/repo/packages/fit", "/repo");
		assert.equal(appended.content, "fit/\n/packages/fit/\n");
	});
});
