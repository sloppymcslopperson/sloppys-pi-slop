import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
	agentModeBlockReason,
	bashIsReadOnly,
	bashMayMutateBoard,
	isInside,
} from "../src/guard.ts";

describe("board path containment", () => {
	const board = resolve("/repo/fit");

	it("accepts paths inside the board", () => {
		assert.equal(isInside(board, resolve("/repo/fit/open/03-x.md")), true);
		assert.equal(isInside(board, board), true);
	});

	it("rejects siblings, parents, and prefix tricks", () => {
		assert.equal(isInside(board, resolve("/repo/fit-evil/open/x.md")), false);
		assert.equal(isInside(board, resolve("/repo/other/x.md")), false);
		assert.equal(isInside(board, resolve("/repo/fit/../secret.md")), false);
	});
});

describe("shell mutation guard", () => {
	const cwd = resolve("/repo");
	const board = resolve("/repo/fit");

	it("allows read-only commands", () => {
		assert.equal(bashMayMutateBoard("git status fit/", board, cwd), false);
		assert.equal(bashMayMutateBoard("grep -R todo fit/", board, cwd), false);
		assert.equal(bashMayMutateBoard("ls fit/open", board, cwd), false);
		assert.equal(bashMayMutateBoard("rm -rf /tmp/other", board, cwd), false);
	});

	it("blocks obvious mutations that mention the board", () => {
		assert.equal(bashMayMutateBoard("rm fit/open/03-x.md", board, cwd), true);
		assert.equal(bashMayMutateBoard("mv fit/open/a.md fit/closed/a.md", board, cwd), true);
		assert.equal(bashMayMutateBoard("echo hack > fit/open/99-hack.md", board, cwd), true);
		assert.equal(bashMayMutateBoard("sed -i s/a/b/ fit/open/03-x.md", board, cwd), true);
		assert.equal(bashMayMutateBoard(`rm ${board}/open/03-x.md`, board, cwd), true);
		assert.equal(bashMayMutateBoard("cd fit && touch open/new.md", board, cwd), true);
	});

	it("does not block a mutator that never mentions the board", () => {
		assert.equal(bashMayMutateBoard("touch notes.txt", board, cwd), false);
	});
});

describe("agent-mode tool policy", () => {
	const cwd = resolve("/repo");
	const board = resolve("/repo/fit");

	it("allows reads and board tools but requires fit_* for board writes", () => {
		for (const toolName of ["read", "grep", "find", "ls", "fit_list", "fit_update"]) {
			assert.equal(agentModeBlockReason(toolName, {}, board, cwd), undefined, toolName);
		}
		assert.match(
			agentModeBlockReason("write", { path: "fit/open/00-x.md" }, board, cwd) ?? "",
			/requires fit_\* tools/,
		);
	});

	it("allows board tools and blocks direct writes, even inside the board", () => {
		assert.match(
			agentModeBlockReason("write", { path: "fit/open/00-x.md" }, board, cwd) ?? "",
			/requires fit_\* tools/,
		);
		assert.match(
			agentModeBlockReason("edit", { path: "src/index.ts" }, board, cwd) ?? "",
			/read-only outside the FIT board/,
		);
		assert.match(
			agentModeBlockReason("write", { path: "../outside.md" }, board, cwd) ?? "",
			/read-only outside the FIT board/,
		);
	});

	it("blocks fit_init and PowerShell", () => {
		assert.match(
			agentModeBlockReason("fit_init", {}, board, cwd) ?? "",
			/writes AGENTS.md/,
		);
		assert.match(
			agentModeBlockReason("powershell", {}, board, cwd) ?? "",
			/does not allow PowerShell/,
		);
	});

	it("applies the read-only shell policy", () => {
		assert.equal(
			agentModeBlockReason("bash", { command: "git status" }, board, cwd),
			undefined,
		);
		assert.match(
			agentModeBlockReason("bash", { command: "rm -rf src" }, board, cwd) ?? "",
			/read-only shell commands/,
		);
	});
});

describe("agent-mode shell allowlist", () => {
	it("allows common read-only inspection commands", () => {
		for (const command of [
			"ls -la",
			"pwd",
			"cat README.md",
			"head -20 src/index.ts",
			"grep -R todo src",
			"rg --files src",
			"find . -name '*.ts'",
			"git status --short",
			"git log --oneline -5",
			"git diff -- src/index.ts",
			"npm ls",
			"npm audit",
			"node --version",
			"cat package.json | jq .name",
		]) {
			assert.equal(bashIsReadOnly(command), true, command);
		}
	});

	it("blocks mutations and unknown commands", () => {
		for (const command of [
			"rm -rf src",
			"touch notes.txt",
			"echo hi > notes.txt",
			"cat file | tee notes.txt",
			"cat file; rm file",
			"cat file && rm file",
			"cat $(rm file)",
			"node -e 'process.exit(1)'",
			"npm install",
			"npm audit fix",
			"git commit -m x",
			"git -c core.pager=cat log",
			"git diff --output=notes.txt",
			"find . -delete",
			"find . -exec rm {} \\;",
			"rg --pre cat pattern",
			"sort -o notes.txt input.txt",
			"tree -o notes.txt",
			"date -s tomorrow",
			"sh -c 'rm file'",
		]) {
			assert.equal(bashIsReadOnly(command), false, command);
		}
	});

	it("allows read-only ketch commands", () => {
		for (const command of [
			"ketch search 'golang error handling'",
			"ketch scrape https://example.test/docs",
			"ketch docs react",
			"ketch code 'http.HandleFunc'",
			"ketch crawl https://example.test",
			"ketch tag https://example.test",
			"ketch search --json --limit 5 query",
			"ketch scrape --max-chars 4000 https://example.test",
			"ketch --help",
			"ketch help",
			"ketch --version",
			"ketch version",
		]) {
			assert.equal(bashIsReadOnly(command), true, command);
		}
	});

	it("blocks unsafe or unknown ketch commands", () => {
		for (const command of [
			"ketch",
			"ketch mcp serve",
			"ketch unknown",
			"ketch search --force-browser query",
			"ketch scrape --no-sandbox https://example.test",
			"ketch --help extra",
			"npx ketch-cli search query",
			"./ketch search query",
			"ketch search 'a; rm file'",
		]) {
			assert.equal(bashIsReadOnly(command), false, command);
		}
	});

	it("rejects empty commands and trailing pipe segments", () => {
		assert.equal(bashIsReadOnly(""), false);
		assert.equal(bashIsReadOnly("   "), false);
		assert.equal(bashIsReadOnly("cat file |"), false);
		assert.equal(bashIsReadOnly("| cat file"), false);
	});
});
