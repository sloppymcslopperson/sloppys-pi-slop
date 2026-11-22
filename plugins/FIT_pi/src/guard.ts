/**
 * Best-effort guard helpers for the built-in write/edit/bash tools.
 *
 * The FIT tools are the sanctioned mutation path for a board. These helpers are
 * intentionally conservative and unit tested; they are not a security sandbox.
 */

import { isAbsolute, relative, resolve } from "node:path";

export function isInside(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function matchPath(value: string): string {
	return value.replace(/\\/g, "/").toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect commands that both mention the board and contain an obvious mutator.
 * Shell parsing is undecidable in general, so this deliberately errs toward
 * blocking rather than guessing about complex pipelines.
 */
export function bashMayMutateBoard(
	command: string,
	board: string,
	cwd: string,
): boolean {
	const haystack = matchPath(command);
	const absolute = matchPath(resolve(board));
	const relativeBoard = matchPath(relative(cwd, board) || ".");
	const mentionsAbsolute = haystack.includes(absolute);
	const mentionsRelative =
		relativeBoard !== "." &&
		new RegExp(
			`(^|[\\s'\"=:(])${escapeRegExp(relativeBoard)}([/\\s'\";|&)]|$)`,
		).test(haystack);
	if (!mentionsAbsolute && !mentionsRelative) return false;
	return /(\brm\b|\brmdir\b|\bmv\b|\bcp\b|\binstall\b|\btouch\b|\btruncate\b|\btee\b|\bdd\b|\bsed\s+-i\b|\bperl\s+-pi\b|\bgit\s+(mv|rm|checkout|restore|clean)\b|>>?)/.test(
		haystack,
	);
}

/** Commands that only inspect files, processes, or repositories. */
const READ_ONLY_COMMANDS = new Set([
	"bat",
	"cat",
	"date",
	"df",
	"diff",
	"du",
	"echo",
	"eza",
	"file",
	"find",
	"free",
	"grep",
	"head",
	"id",
	"jq",
	"ls",
	"printf",
	"printenv",
	"ps",
	"pwd",
	"rg",
	"sort",
	"stat",
	"tail",
	"tree",
	"type",
	"uname",
	"uniq",
	"wc",
	"whereis",
	"which",
	"whoami",
]);

/** Shell syntax that can hide a second command or redirect output. */
const SHELL_BREAKERS = /[;&\r\n`]|\$\(|>>?|</;

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
	"blame",
	"describe",
	"diff",
	"grep",
	"log",
	"ls-files",
	"rev-parse",
	"show",
	"shortlog",
	"status",
	"whatchanged",
]);

const NPM_READ_ONLY_SUBCOMMANDS = new Set([
	"audit",
	"explain",
	"info",
	"list",
	"ls",
	"outdated",
	"search",
	"view",
	"why",
]);

const FIND_WRITE_FLAGS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-ok",
	"-okdir",
]);

const KETCH_READ_ONLY_SUBCOMMANDS = new Set([
	"code",
	"crawl",
	"docs",
	"help",
	"scrape",
	"search",
	"tag",
	"version",
]);

const KETCH_BLOCKED_FLAGS = new Set(["--force-browser", "--no-sandbox"]);

const EXTRA_READ_ONLY_COMMANDS = new Set([
	"bun",
	"deno",
	"git",
	"ketch",
	"node",
	"npm",
	"python",
	"python3",
]);

function isReadOnlySegment(segment: string): boolean {
	const tokens = segment.split(/\s+/).filter(Boolean);
	const command = tokens[0];
	if (
		!command ||
		command.includes("/") ||
		(!READ_ONLY_COMMANDS.has(command) && !EXTRA_READ_ONLY_COMMANDS.has(command))
	) {
		return false;
	}
	const args = tokens.slice(1);

	if (command === "find") {
		return !args.some(
			(arg) =>
				FIND_WRITE_FLAGS.has(arg) ||
				arg.startsWith("-fprint") ||
				arg.startsWith("-fls"),
		);
	}
	if (command === "rg") {
		return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	}
	if (command === "sort") {
		return !args.some(
			(arg) =>
				arg === "-o" ||
				arg === "--output" ||
				arg.startsWith("--output=") ||
				arg === "--compress-program" ||
				arg.startsWith("--compress-program="),
		);
	}
	if (command === "tree") {
		return !args.some(
			(arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="),
		);
	}
	if (command === "diff") {
		return !args.some((arg) => arg === "--output" || arg.startsWith("--output="));
	}
	if (command === "date") {
		return !args.some((arg) => arg === "-s" || arg === "--set" || arg.startsWith("--set="));
	}
	if (command === "git") {
		const subcommand = args[0];
		if (!subcommand || !GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
		return !args.some((arg) => arg === "--output" || arg.startsWith("--output="));
	}
	if (command === "npm") {
		const subcommand = args[0];
		if (!subcommand || !NPM_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
		if (subcommand === "audit" && args.slice(1).includes("fix")) return false;
		return true;
	}
	if (command === "ketch") {
		const subcommand = args[0];
		if (subcommand === "--help" || subcommand === "--version") {
			return args.length === 1;
		}
		if (!subcommand || !KETCH_READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
		return !args.some((arg) =>
			KETCH_BLOCKED_FLAGS.has(arg.split("=")[0]),
		);
	}
	if (["node", "python", "python3", "deno", "bun"].includes(command)) {
		return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
	}
	return true;
}

/**
 * Conservative read-only shell policy used by planner mode. Commands are split on
 * pipes and every segment must be an allowlisted inspection command. Chaining,
 * substitution, redirection, and unknown commands are rejected.
 */
export function bashIsReadOnly(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed || SHELL_BREAKERS.test(trimmed)) return false;
	const segments = trimmed.split("|");
	if (segments.length === 0 || segments.some((segment) => !segment.trim())) return false;
	return segments.every(isReadOnlySegment);
}

/**
 * Decide whether a tool call violates planner mode. Returns a model-facing reason
 * when the call must be blocked, or undefined when it may run.
 */
export function agentModeBlockReason(
	toolName: string,
	input: Record<string, unknown>,
	board: string,
	cwd: string,
): string | undefined {
	if (toolName === "fit_init") {
		return "Planner mode blocks fit_init because it writes AGENTS.md, AGENT_SPEC.md, and possibly .gitignore outside the FIT board. Run /fit init yourself first.";
	}

	if (toolName === "write" || toolName === "edit") {
		const rawPath = input.path;
		if (typeof rawPath !== "string") {
			return `Planner mode blocks ${toolName} without a resolvable path.`;
		}
		const target = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
		const absolute = isAbsolute(target) ? target : resolve(cwd, target);
		if (!isInside(board, absolute)) {
			return `Planner mode is read-only outside the FIT board. Use fit_* tools for ticket changes; ${toolName} was blocked for ${absolute}.`;
		}
		return `Planner mode requires fit_* tools for board changes; direct ${toolName} on ${absolute} is blocked.`;
	}

	if (toolName === "bash") {
		const command = input.command;
		if (typeof command !== "string" || !bashIsReadOnly(command)) {
			return "Planner mode only allows read-only shell commands. Use the fit_* tools for board changes, or /fit planner off to restore full access.";
		}
		return undefined;
	}

	if (toolName === "powershell") {
		return "Planner mode does not allow PowerShell. Use read-only shell commands or the fit_* tools.";
	}

	return undefined;
}
