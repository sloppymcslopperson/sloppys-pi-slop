/**
 * Pi addon: deterministic tools for FIT boards.
 *
 * Agent-facing tools use exact ticket ids and content revisions. Fuzzy matching
 * exists only in the human `/fit` command, where the user can pick a candidate.
 */

import {
	defineTool,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { Type } from "typebox";

import {
	type BoardCheckResult,
	type BoardIssue,
	type BoardMode,
	type CleanupTicketRename,
	type FrontmatterValue,
	type InitBoardResult,
	type Ticket,
	type TicketSummary,
	DEFAULT_MAX_TICKET_NAME_CHARS,
	MAX_PRIORITY,
	FIT_STATUS_ORDER,
	FitError,
	checkBoard,
	cleanupTicketNames,
	countTickets,
	createTicket,
	createTickets,
	archiveTicket,
	initBoard,
	listTickets,
	migrationReport,
	moveTicket,
	nextTicketToPromote,
	normalizeLegacyBodies,
	normalizeStatusPath,
	readBoard,
	readTicket,
	recordClosedTicketsCommit,
	resolveBoard,
	restoreArchivedTicket,
	updateTicket,
} from "./fit.ts";
import { fuzzyFind } from "./human.ts";
import { formatInProgressStatus } from "./status.ts";
import {
	AGENT_MODE_PLAN_INSTRUCTION,
	PLAN_A_LEG_GRILL_INSTRUCTION,
	PLAN_A_LEG_INSTRUCTION,
	lateAgentModeReminder,
} from "./prompt.ts";
import { agentModeBlockReason, bashMayMutateBoard, isInside } from "./guard.ts";
import {
	nextAgentMode,
	parseAgentModeAction,
	parseAutocommitToken,
	parseNogrillToken,
	parseReviewToken,
	resolveAgentMode,
	resolveNogrillDefault,
	resolveReviewDefault,
	type AgentModeAction,
} from "./config.ts";
import type { GitConflictChoice } from "./git.ts";

// ---------------------------------------------------------------------------
// Shared details and formatting
// ---------------------------------------------------------------------------

interface FitDetails {
	ok: boolean;
	board?: string;
	message?: string;
	error?: string;
	code?: string;
	hint?: string;
	candidates?: string[];
	id?: string;
	previousId?: string;
	toId?: string;
	recordPath?: string;
	archivePath?: string;
	fromRecord?: string;
	remainingRecords?: number;
	revision?: string;
	created?: boolean;
	createdCount?: number;
	existingCount?: number;
	renamed?: CleanupTicketRename[];
	skipped?: number;
	maxLength?: number;
	dryRun?: boolean;
	commitHash?: string;
	recorded?: string[];
	commitMessage?: string;
	changed?: boolean;
	specCreated?: boolean;
	specUpdated?: boolean;
	specPreserved?: boolean;
	agentSpecCreated?: boolean;
	strictCreated?: boolean;
	strict?: boolean;
	ticket?: Ticket;
	tickets?: TicketSummary[];
	counts?: Record<string, number>;
	total?: number;
	listed?: number;
	filter?: string;
	warnings?: string[];
	issues?: BoardIssue[];
	issueCount?: number;
	mode?: BoardMode["mode"];
	modeVersion?: string | null;
}

interface FitResult {
	content: Array<{ type: "text"; text: string }>;
	details: FitDetails;
	isError?: boolean;
}

const BOARD_DESCRIPTION =
	"FIT board directory. Defaults to the --fit-dir flag, FIT_BOARD env, or ./fit.";

const boardParam = Type.Optional(Type.String({ description: BOARD_DESCRIPTION }));

const frontmatterValue = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
]);

const frontmatterSchema = Type.Record(Type.String(), frontmatterValue);

const FIT_STATUS_ORDER_SET = new Set<string>(FIT_STATUS_ORDER);

function configuredReview(pi: ExtensionAPI): boolean {
	return resolveReviewDefault(pi.getFlag("fit-review"), process.env.FIT_REVIEW);
}

function configuredNogrill(pi: ExtensionAPI): boolean {
	return resolveNogrillDefault(pi.getFlag("fit-nogrill"), process.env.FIT_NOGRILL);
}

async function chooseGitConflict(
	ctx: SelectContext,
	ticket: string,
): Promise<GitConflictChoice | undefined> {
	if (!ctx.hasUI) return undefined;
	const choice = await ctx.ui.select(
		`Ticket ${ticket} exists both locally and on the fit branch. Which version should be kept?`,
		["Keep branch version", "Use local version"],
	);
	if (!choice) return undefined;
	return choice === "Use local version" ? "local" : "branch";
}

interface WorkFlags {
	review: boolean | undefined;
	nogrill: boolean | undefined;
	rest: string[];
}

interface WorkRunFlags extends WorkFlags {
	count: number | undefined;
	autocommit: boolean;
}

function duplicateFlag(command: string, flag: string, usage: string): FitError {
	return new FitError("INVALID_FLAG", `Duplicate /fit ${command} flag: ${flag}`, {
		hint: `Usage: ${usage}`,
	});
}

/**
 * Parse leading `review` and `nogrill` tokens for /fit work and /fit start.
 * Flags may appear in either order; the first unrecognized token starts the
 * command's text argument.
 */
function parseWorkFlags(args: string[], command: string, usage: string): WorkFlags {
	const parsed: WorkFlags = { review: undefined, nogrill: undefined, rest: [] };
	let parsingFlags = true;
	for (const arg of args) {
		if (parsingFlags) {
			const review = parseReviewToken(arg);
			if (review !== undefined) {
				if (parsed.review !== undefined) throw duplicateFlag(command, arg, usage);
				parsed.review = review;
				continue;
			}
			const nogrill = parseNogrillToken(arg);
			if (nogrill !== undefined) {
				if (parsed.nogrill !== undefined) throw duplicateFlag(command, arg, usage);
				parsed.nogrill = nogrill;
				continue;
			}
			parsingFlags = false;
		}
		parsed.rest.push(arg);
	}
	return parsed;
}

interface PlanLegFlags {
	nogrill: boolean | undefined;
	rest: string[];
}

/**
 * Parse leading `nogrill` tokens for /fit plan-a-leg. There is deliberately no
 * review or autocommit flag: the command only plans, it never implements.
 */
export function parsePlanLegFlags(args: string[]): PlanLegFlags {
	const parsed: PlanLegFlags = { nogrill: undefined, rest: [] };
	let parsingFlags = true;
	for (const arg of args) {
		if (parsingFlags) {
			const nogrill = parseNogrillToken(arg);
			if (nogrill !== undefined) {
				if (parsed.nogrill !== undefined) {
					throw duplicateFlag(
						"plan-a-leg",
						arg,
						"/fit plan-a-leg [nogrill] [query|text]",
					);
				}
				parsed.nogrill = nogrill;
				continue;
			}
			parsingFlags = false;
		}
		parsed.rest.push(arg);
	}
	return parsed;
}

/**
 * Parse `/fit work` run options. Unlike `/fit start`, work has no trailing text,
 * so review, nogrill, autocommit, and an optional ticket count may appear in any
 * order. Anything else is reported as an unknown flag by the caller.
 */
export function parseWorkRunFlags(args: string[]): WorkRunFlags {
	const parsed: WorkRunFlags = {
		review: undefined,
		nogrill: undefined,
		count: undefined,
		autocommit: false,
		rest: [],
	};
	for (const arg of args) {
		if (/^-?\d+$/.test(arg)) {
			if (parsed.count !== undefined) {
				throw new FitError("INVALID_FLAG", `Duplicate /fit work ticket count: ${arg}`, {
					hint: "Usage: /fit work [N] [review] [nogrill] [autocommit]",
				});
			}
			const count = Number(arg);
			if (!Number.isSafeInteger(count) || count < 1) {
				throw new FitError(
					"INVALID_ARGUMENTS",
					`Ticket count must be a positive integer, got: ${arg}`,
					{ hint: "Usage: /fit work [N] [review] [nogrill] [autocommit]" },
				);
			}
			parsed.count = count;
			continue;
		}
		const review = parseReviewToken(arg);
		if (review !== undefined) {
			if (parsed.review !== undefined) {
				throw duplicateFlag("work", arg, "/fit work [N] [review] [nogrill] [autocommit]");
			}
			parsed.review = review;
			continue;
		}
		const nogrill = parseNogrillToken(arg);
		if (nogrill !== undefined) {
			if (parsed.nogrill !== undefined) {
				throw duplicateFlag("work", arg, "/fit work [N] [review] [nogrill] [autocommit]");
			}
			parsed.nogrill = nogrill;
			continue;
		}
		const autocommit = parseAutocommitToken(arg);
		if (autocommit !== undefined) {
			if (parsed.autocommit) {
				throw duplicateFlag("work", arg, "/fit work [N] [review] [nogrill] [autocommit]");
			}
			parsed.autocommit = true;
			continue;
		}
		parsed.rest.push(arg);
	}
	return parsed;
}

/**
 * Build the fixed work queue: every in_progress ticket first, then open
 * tickets, and optionally backlog tickets when the caller confirmed a fallback.
 */
export function selectWorkQueue(
	tickets: TicketSummary[],
	count: number,
	includeBacklog = false,
): TicketSummary[] {
	const statuses = includeBacklog
		? ["in_progress", "open", "backlog"]
		: ["in_progress", "open"];
	const queue: TicketSummary[] = [];
	for (const status of statuses) {
		for (const ticket of tickets) {
			if (ticket.status === status) queue.push(ticket);
			if (queue.length >= count) return queue;
		}
	}
	return queue;
}

interface OpenFlags {
	localEdit: boolean;
	query: string;
}

function parseEditFlags(args: string[]): OpenFlags {
	let localEdit = false;
	let index = 0;
	while (index < args.length) {
		const token = args[index].toLowerCase();
		if (["local", "--local", "-l", "edit", "--edit", "-e"].includes(token)) {
			localEdit = true;
			index += 1;
			continue;
		}
		break;
	}
	return { localEdit, query: args.slice(index).join(" ") };
}

function configuredBoard(pi: ExtensionAPI): string | undefined {
	const flag = pi.getFlag("fit-dir");
	if (typeof flag === "string" && flag.trim()) return flag;
	const env = process.env.FIT_BOARD;
	if (env && env.trim()) return env;
	return undefined;
}

function makeResult(text: string, details: FitDetails): FitResult {
	return { content: [{ type: "text", text }], details };
}

function failure(error: unknown, board?: string): FitResult {
	const fit =
		error instanceof FitError
			? error
			: new FitError(
					"INTERNAL",
					error instanceof Error ? error.message : String(error),
				);
	const lines = [`${fit.code}: ${fit.message}`];
	if (fit.hint) lines.push(`Hint: ${fit.hint}`);
	if (fit.candidates?.length) {
		lines.push("Candidates:");
		for (const candidate of fit.candidates) lines.push(`- ${candidate}`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			ok: false,
			board,
			error: fit.message,
			code: fit.code,
			hint: fit.hint,
			candidates: fit.candidates,
		},
		isError: true,
	};
}

function formatCounts(counts: Record<string, number>): string {
	const keys = [
		...FIT_STATUS_ORDER,
		...Object.keys(counts).filter((key) => !FIT_STATUS_ORDER_SET.has(key)),
	];
	return keys
		.filter((key) => counts[key] !== undefined)
		.map((key) => `${key} ${counts[key] ?? 0}`)
		.join(" · ");
}

function clip(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	return `${chars.slice(0, maxChars).join("")}\n[... ${chars.length - maxChars} characters omitted]`;
}

const LIST_ID_COLUMN_MAX = 64;
const LIST_TITLE_MAX = 120;

function ticketTitle(ticket: TicketSummary): string {
	return ticket.title || ticket.displayName || "(no body)";
}

function ticketLabel(ticket: TicketSummary): string {
	return `${ticket.id}  ${ticketTitle(ticket)}`;
}

/** Shorten a single-line value without breaking its row. */
function truncateText(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

/** Wrap a single-line value on word boundaries, splitting long words. */
function wrapText(value: string, maxChars: number): string[] {
	const max = Math.max(1, maxChars);
	const words = value.split(" ").filter(Boolean);
	const lines: string[] = [];
	let line = "";

	for (const word of words) {
		const chars = Array.from(word);
		if (line && Array.from(line).length + 1 + chars.length <= max) {
			line += ` ${word}`;
			continue;
		}
		if (line) {
			lines.push(line);
			line = "";
		}
		while (chars.length > max) {
			lines.push(chars.splice(0, max).join(""));
		}
		line = chars.join("");
	}

	if (line) lines.push(line);
	return lines.length ? lines : [""];
}

function formatTicketLine(
	ticket: TicketSummary,
	idWidth: number,
	stacked: boolean,
	width?: number,
): string {
	const project = ticket.project ? `  [${ticket.project}]` : "";
	const title = `${truncateText(ticketTitle(ticket), LIST_TITLE_MAX)}${project}`;
	if (stacked) {
		const titleLines =
			width && width > 0 ? wrapText(title, Math.max(1, width - 6)) : [title];
		return [`  ${ticket.id}`, ...titleLines.map((line) => `      ${line}`)].join("\n");
	}
	if (idWidth <= 0 || ticket.id.length > idWidth) {
		return `  ${ticket.id}\n      ${title}`;
	}
	return `  ${ticket.id.padEnd(idWidth)}  ${title}`;
}

interface FormatListOptions {
	/** Filter text to echo in the header, when one is in effect. */
	filter?: string;
	/** Maximum number of rows; only used to explain truncation. */
	limit?: number;
	/** Show the FIT-only agent-mode state in the header. */
	agentMode?: boolean;
	/** Always put the title on its own line below the ticket id. */
	stacked?: boolean;
	/** Available render width; stacked titles wrap to fit inside it. */
	width?: number;
}

/** Render a human-readable grouped board listing. */
export function formatList(
	board: string,
	mode: BoardMode,
	all: TicketSummary[],
	listed: TicketSummary[],
	counts: Record<string, number>,
	options: FormatListOptions = {},
): string {
	const modeLabel =
		mode.mode === "strict"
			? `strict${mode.version ? ` ${mode.version}` : ""}`
			: "basic";
	const lines = [
		`FIT board: ${board}`,
		`Mode: ${modeLabel}`,
		`Tickets: ${all.length} total · ${formatCounts(counts)}`,
	];
	if (options.filter) lines.push(`Filter: ${options.filter}`);
	if (options.agentMode) lines.push("Agent mode: on (FIT-only)");

	if (listed.length === 0) {
		lines.push("", all.length === 0 ? "No tickets yet." : "No tickets match this view.");
	} else {
		const idWidth = Math.min(
			LIST_ID_COLUMN_MAX,
			Math.max(...listed.map((ticket) => ticket.id.length)),
		);
		const groups = new Map<string, TicketSummary[]>();
		for (const ticket of listed) {
			const group = groups.get(ticket.status);
			if (group) group.push(ticket);
			else groups.set(ticket.status, [ticket]);
		}

		for (const [status, tickets] of groups) {
			const noun = tickets.length === 1 ? "ticket" : "tickets";
			const heading = `${status}/  ${tickets.length} ${noun}`;
			lines.push("", heading, "─".repeat(Array.from(heading).length));
			for (const ticket of tickets) {
				lines.push(
					formatTicketLine(ticket, idWidth, options.stacked === true, options.width),
				);
			}
		}
	}

	if (all.length > listed.length) {
		const shown = `Showing ${listed.length} of ${all.length} tickets`;
		const hint =
			options.limit && listed.length >= options.limit ? `, limit ${options.limit}` : "";
		lines.push("", `[${shown}${hint}; adjust the filter or limit to see more.]`);
	}
	return lines.join("\n");
}

function formatShow(ticket: Ticket): string {
	const lines = [
		`${ticket.id}`,
		`revision: ${ticket.revision}`,
		`status: ${ticket.status}${ticket.subdir ? ` (subdir: ${ticket.subdir})` : ""}`,
		`name: ${ticket.shortName}`,
		`displayName: ${ticket.displayName}`,
		`project: ${ticket.project ?? "none"}`,
		`priority: ${ticket.priority ?? "none"}`,
		`title: ${ticket.title || "(empty)"}`,
		"",
		"frontmatter:",
		ticket.frontmatterRaw?.trim() ? clip(ticket.frontmatterRaw, 4000) : "(none)",
		"",
		"body:",
		ticket.body.trim() ? clip(ticket.body.trimEnd(), 8000) : "(empty)",
	];
	return lines.join("\n");
}

function formatWarnings(warnings: string[] | undefined): string {
	if (!warnings?.length) return "";
	return `\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function formatCleanupResult(
	board: string,
	result: { renamed: CleanupTicketRename[]; skipped: number; maxLength: number; dryRun: boolean },
): string {
	const lines = [
		`FIT board: ${board}`,
		`${result.dryRun ? "Would rename" : "Renamed"} ${result.renamed.length} ticket(s); ${result.skipped} already within ${result.maxLength} characters.`,
	];
	for (const rename of result.renamed) {
		lines.push(`${result.dryRun ? "~" : "+"} ${rename.fromId} -> ${rename.toId}`);
	}
	return lines.join("\n");
}

function formatInitResult(result: InitBoardResult): string {
	const lines = [`FIT board: ${result.board}`];
	if (result.created.length) lines.push(`created: ${result.created.join(", ")}`);
	if (result.existing.length) {
		lines.push(`already existed: ${result.existing.join(", ")}`);
	}
	lines.push(
		result.specCreated
			? `spec: created ${result.specPath}`
			: result.specUpdated
				? `spec: refreshed ${result.specPath}`
				: result.specPreserved
					? `spec: kept local content at ${result.specPath}`
					: `spec: already up to date at ${result.specPath}`,
	);
	lines.push(
		result.strict
			? result.strictCreated
				? `mode: strict, marker created at ${result.strictPath}`
				: `mode: strict, marker already present at ${result.strictPath}`
			: `mode: basic`,
	);
	lines.push(
		result.agentsCreated
			? `agents: created ${result.agentsPath}`
			: result.agentsUpdated
				? `agents: updated ${result.agentsPath}`
				: `agents: already present at ${result.agentsPath}`,
	);
	lines.push(
		result.agentSpecCreated
			? `agent spec: created ${result.agentSpecPath}`
			: `agent spec: already present at ${result.agentSpecPath}`,
	);
	if (result.gitRequested) {
		lines.push(
			result.gitignoreCreated
				? `gitignore: created ${result.gitignorePath}`
				: result.gitignoreUpdated
					? `gitignore: updated ${result.gitignorePath}`
					: `gitignore: already ignores the board at ${result.gitignorePath}`,
		);
		lines.push(
			result.gitBranchCreated
				? `git: created branch ${result.gitBranch}`
				: `git: using existing branch ${result.gitBranch}`,
		);
		lines.push(
			result.gitWorktreeCreated
				? `git: checked out ${result.gitBranch} at ${result.board}`
				: `git: worktree already on ${result.gitBranch} at ${result.board}`,
		);
		if (result.gitMergedTickets.length > 0) {
			lines.push(`git: merged ${result.gitMergedTickets.length} local ticket(s) into ${result.gitBranch}`);
		}
		if (result.gitKeptBranchTickets.length > 0) {
			lines.push(`git: kept the ${result.gitBranch} version of ${result.gitKeptBranchTickets.length} conflicting ticket(s)`);
		}
		if (result.gitBackupPath) {
			lines.push(`git: previous board contents saved at ${result.gitBackupPath}`);
		}
	}
	return lines.join("\n");
}

function formatCheckResult(
	board: string,
	result: BoardCheckResult,
	limit = 200,
): { text: string; errors: BoardIssue[]; warnings: BoardIssue[] } {
	const errors = result.issues.filter((issue) => issue.severity === "error");
	const warnings = result.issues.filter((issue) => issue.severity === "warning");
	const modeLabel =
		result.mode.mode === "strict"
			? `strict${result.mode.version ? ` ${result.mode.version}` : ""}`
			: "basic";
	const lines = [
		`FIT board: ${board}`,
		`Mode: ${modeLabel}`,
		`Tickets: ${result.total} (${formatCounts(result.counts)})`,
		`Issues: ${errors.length} error(s), ${warnings.length} warning(s)`,
	];
	if (result.issues.length === 0) {
		lines.push("Board is clean.");
	} else {
		for (const issue of result.issues.slice(0, limit)) {
			lines.push(
				`[${issue.severity}] ${issue.code}${issue.id ? ` ${issue.id}` : ""}: ${issue.message}`,
			);
		}
		if (result.issues.length > limit) {
			lines.push(`[${result.issues.length - limit} more issues omitted]`);
		}
	}
	return { text: lines.join("\n"), errors, warnings };
}

function formatMigrationReport(
	board: string,
	report: Awaited<ReturnType<typeof migrationReport>>,
): string {
	const lines = [
		`FIT board: ${board}`,
		`Mode: ${report.mode.mode}${report.mode.version ? ` ${report.mode.version}` : ""}`,
		`Tickets: ${report.total}`,
		`Migration actions: ${report.actions.length} (dry run; nothing changed)`,
	];
	for (const action of report.actions) {
		lines.push(`[${action.kind}] ${action.id}: ${action.message}`);
		if (action.suggestedId) lines.push(`  -> ${action.suggestedId}`);
	}
	return lines.join("\n");
}

function formatNormalizeBodiesResult(
	board: string,
	result: { changed: Array<{ id: string }>; dryRun: boolean },
): string {
	const lines = [
		`FIT board: ${board}`,
		`${result.dryRun ? "Would normalize" : "Normalized"} ${result.changed.length} legacy bod${result.changed.length === 1 ? "y" : "ies"}.`,
	];
	for (const item of result.changed) lines.push(`+ ${item.id}`);
	return lines.join("\n");
}

function renderResult(
	result: { details?: unknown },
	expanded: boolean,
	theme: any,
): Text {
	const details = result.details as FitDetails | undefined;
	if (!details) return new Text("", 0, 0);
	if (details.error) {
		let text = theme.fg("error", `✗ ${details.code ?? "error"}: ${details.error}`);
		if (details.hint) text += `\n${theme.fg("dim", details.hint)}`;
		if (expanded && details.candidates?.length) {
			text += `\n${theme.fg("dim", details.candidates.join("\n"))}`;
		}
		return new Text(text, 0, 0);
	}
	let text = theme.fg("success", details.message ?? "ok");
	if (details.warnings?.length) {
		text += `\n${theme.fg("warning", `${details.warnings.length} warning(s)`)}`;
		if (expanded) {
			for (const warning of details.warnings) {
				text += `\n  ${theme.fg("dim", warning)}`;
			}
		}
	}
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function renderToolResult(
	result: { details?: unknown },
	options: { expanded: boolean },
	theme: any,
): Text {
	return renderResult(result, options.expanded, theme);
}

/** Resolve the board once, then convert thrown FitErrors into tool results. */
async function runBoardTool(
	pi: ExtensionAPI,
	params: { board?: string },
	ctx: { cwd: string },
	action: (board: string) => Promise<FitResult>,
): Promise<FitResult> {
	const board = resolveBoard(params.board ?? configuredBoard(pi), ctx.cwd);
	try {
		return await action(board);
	} catch (error) {
		return failure(error, board);
	}
}

function runningInVsCodeTerminal(): boolean {
	const term = process.env.TERM_PROGRAM?.trim().toLowerCase();
	return (
		term === "vscode" ||
		Boolean(process.env.VSCODE_PID) ||
		Boolean(process.env.VSCODE_IPC_HOOK_CLI)
	);
}

interface LaunchOptions {
	label: string;
	hint: string;
	windowsVerbatimArguments?: boolean;
}

function launchDetached(
	command: string,
	args: string[],
	options: LaunchOptions,
): Promise<void> {
	const windows = process.platform === "win32";
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			detached: !windows,
			stdio: "ignore",
			windowsHide: true,
			windowsVerbatimArguments: options.windowsVerbatimArguments,
		});
		let settled = false;
		const fail = (message: string) => {
			if (settled) return;
			settled = true;
			reject(new FitError("EDITOR_LAUNCH_FAILED", message, { hint: options.hint }));
		};

		child.once("error", (error) => {
			fail(`Could not launch ${options.label}: ${error.message}`);
		});

		if (windows) {
			child.once("close", (code) => {
				if (settled) return;
				if (code === 0) {
					settled = true;
					resolve();
					return;
				}
				fail(`${options.label} exited with status ${code ?? "unknown"}.`);
			});
		} else {
			child.once("spawn", () => {
				if (settled) return;
				settled = true;
				child.unref();
				resolve();
			});
		}
	});
}

function openInVscode(filePath: string): Promise<void> {
	const windows = process.platform === "win32";
	return launchDetached(
		windows ? (process.env.ComSpec ?? "cmd.exe") : "code",
		windows
			? ["/d", "/c", "code", "--reuse-window", `"${filePath}"`]
			: ["--reuse-window", filePath],
		{
			label: "VS Code",
			hint: "Ensure the 'code' command is on PATH (VS Code: Shell Command: Install 'code' command in PATH).",
			windowsVerbatimArguments: windows,
		},
	);
}

function openInDefaultEditor(filePath: string): Promise<void> {
	const platform = process.platform;
	if (platform === "win32") {
		return launchDetached(
			process.env.ComSpec ?? "cmd.exe",
			["/d", "/c", "start", '""', `"${filePath}"`],
			{
				label: "the default editor",
				hint: "Associate .md files with a text editor, or run /fit edit inside VS Code.",
				windowsVerbatimArguments: true,
			},
		);
	}
	if (platform === "darwin") {
		return launchDetached("open", [filePath], {
			label: "the default editor",
			hint: "Check that a default application is configured for .md files.",
		});
	}
	return launchDetached("xdg-open", [filePath], {
		label: "the default editor",
		hint: "Install xdg-open or configure a default application for .md files.",
	});
}

const TICKET_EDIT_GUARDRAIL =
	"Use fit_update for body/frontmatter changes; do not edit ticket files directly with write/edit/bash.";

const GRILLED_INSTRUCTION =
	"This ticket already has frontmatter grilled: true, so clarifying questions were answered previously. Review the recorded answers, frontmatter, and body, then decide: if every detail needed is clear, accept what is there and start work; if a detail is still missing or new, grill the user only about those specific gaps in rounds until resolved, and leave grilled: true in place. Do not re-ask questions that are already answered. If the work turns out larger than the ticket anticipated, stop and offer to split it into follow-up tickets with fit_new_batch.";

const SCOPE_CHECK_INSTRUCTION =
	"Before starting, grill the user like the 'grill me' skill: list every unclear detail - goal, scope, acceptance criteria, files, expected behavior, edge cases, tests, and constraints - and ask focused questions in rounds until nothing is unresolved. Do not begin work or make assumptions while a detail is unclear; if the user cannot answer, state the assumption and get confirmation first. Then record that grilling is done by setting frontmatter grilled: true with fit_update, keeping any answers or assumptions in the frontmatter or body. If the work turns out larger than the ticket anticipated, stop and offer to split it into follow-up tickets with fit_new_batch.";

function grillingDone(ticket: Ticket): boolean {
	const value = ticket.frontmatter.grilled;
	if (value === true) return true;
	return (
		typeof value === "string" &&
		["true", "yes", "done", "1"].includes(value.trim().toLowerCase())
	);
}

function scopeInstruction(ticket: Ticket): string {
	return grillingDone(ticket) ? GRILLED_INSTRUCTION : SCOPE_CHECK_INSTRUCTION;
}

function finishInstruction(review: boolean, planOnly = false): string {
	const finish = review
		? "Review mode is ON. Do not move this ticket to closed. When the work is done, re-read it with fit_show, update the body/frontmatter with a short summary if useful, and leave it in in_progress for human review. Ask the user to review it and let a human close it."
		: "When finished, re-read it with fit_show, then call fit_move with status \"closed\" and the latest expectedRevision.";
	if (!planOnly) return finish;
	return `Do not move or close this ticket while planning. After the user turns agent mode off and confirms, execute the plan. ${finish}`;
}

function buildTicketPrompt(
	ticket: Ticket,
	heading: string[],
	review: boolean,
	lead: string,
	grill: boolean,
	planOnly = false,
): string {
	const lines = [...heading, "", formatShow(ticket), ""];
	if (grill) lines.push(scopeInstruction(ticket), "");
	if (planOnly) lines.push(AGENT_MODE_PLAN_INSTRUCTION, "");
	lines.push(`${lead} ${finishInstruction(review, planOnly)} ${TICKET_EDIT_GUARDRAIL}`);
	return lines.join("\n");
}

function buildWorkMessage(
	ticket: Ticket,
	promotedFrom: string | undefined,
	review: boolean,
	grill: boolean,
	planOnly = false,
	promotedBy = "The /fit work command",
): string {
	const heading = [`Work on FIT ticket ${ticket.id} (revision ${ticket.revision}).`];
	if (promotedFrom) {
		heading.push(`${promotedBy} promoted ${promotedFrom} -> ${ticket.id}.`);
	}
	return buildTicketPrompt(
		ticket,
		heading,
		review,
		planOnly
			? "Keep it in in_progress while you plan, then stop."
			: "Keep it in in_progress while you work.",
		grill,
		planOnly,
	);
}

/** Build the prompt for a `/fit plan-a-leg` split. */
export function buildPlanLegMessage(
	ticket: Ticket,
	board: string,
	legStatus: string,
	grill: boolean,
	createdFromText: boolean,
	createdId?: string,
): string {
	const heading = [
		`Plan a leg of work for FIT ticket ${ticket.id} (revision ${ticket.revision}).`,
	];
	if (createdFromText) {
		heading.push(
			`The /fit plan-a-leg command created ${createdId ?? ticket.id} as the umbrella.`,
		);
	}
	const lines = [
		...heading,
		"",
		formatShow(ticket),
		"",
		`Board: ${board}`,
		`Leg destination: ${legStatus}`,
		`Umbrella id for parent frontmatter: ${ticket.id}`,
		"",
	];
	if (grill) lines.push(scopeInstruction(ticket), "", PLAN_A_LEG_GRILL_INSTRUCTION, "");
	lines.push(
		PLAN_A_LEG_INSTRUCTION,
		"",
		"Do not implement anything. The user will turn agent mode off and run /fit work N when ready.",
		TICKET_EDIT_GUARDRAIL,
	);
	return lines.join("\n");
}

export const BATCH_GRILL_INSTRUCTION = [
	"Before doing any implementation, collect every ticket in the queue with fit_show and grill the user immediately about every ticket that is not already marked grilled: true.",
	"List every unclear detail - goal, scope, acceptance criteria, files, expected behavior, edge cases, tests, and constraints - and ask focused questions in rounds until nothing is unresolved.",
	"Do not wait until a ticket is promoted to in_progress to grill it. Grill the whole queue now.",
	"Record answers and assumptions in each affected ticket with fit_update and set grilled: true on every ticket you grill.",
	"For tickets already marked grilled, do not re-ask answered questions; only ask about genuine new gaps.",
	"If the user cancels any setup or grilling question, stop immediately and wait for them to provide more context. Do not assume an answer or continue.",
	"Do not begin implementation until every un-grilled ticket in the queue has been grilled and recorded.",
].join(" ");

export const BATCH_AUTONOMY_INSTRUCTION = [
	"Work through this fixed queue in order without asking for confirmation between tickets.",
	"Keep the current ticket in in_progress while you work.",
	"After finishing a ticket, post one short progress note, close it with fit_move using the latest expectedRevision, then promote the next queue ticket to in_progress with fit_move and continue automatically.",
	"Do not add tickets to this run; the queue is the snapshot listed above.",
	"If a ticket hits a significant issue that would expand scope beyond the grilled answers, halt the batch and ask the user; offer to grill them, create follow-up tickets with fit_new_batch, or stop entirely.",
	"If the requested count could not be filled, work what is available and report the shortfall at the end.",
].join(" ");

export const AUTOCOMMIT_INSTRUCTION = [
	"Autocommit is on for this run.",
	"For each ticket, once its work is verified and before closing it, identify only the files changed for this ticket plus parent-repository work files; never stage unrelated dirty files.",
	"Stage those paths explicitly, check git status and the staged diff, then commit with message `FIT: close <short-name>`.",
	"If there are no parent-repository changes for the ticket, skip the commit and say so; do not record a commit hash for a commit that was not made.",
	"If the commit fails or the repository is in a bad state, halt the batch, leave the ticket in in_progress, and give a short message describing the problem and suggested resolution steps.",
	"After closing the ticket, only if you made a commit, get the new parent commit hash with `git rev-parse HEAD`, set frontmatter commit with fit_update, then commit the board worktree with a short FIT message so the board stays clean.",
	"On an inline board, use the parent repository for the board cleanup commit instead of a separate board worktree.",
].join(" ");

function batchFinishInstruction(review: boolean, autocommit: boolean): string {
	if (review) return finishInstruction(true);
	const commit = autocommit
		? "After the ticket work is verified, do the autocommit steps above first. "
		: "";
	return `${commit}For each ticket: re-read it with fit_show, then call fit_move with status "closed" and the latest expectedRevision. After the last ticket, report the closed count and any shortfall or halted item.`;
}

/** Build the prompt for an autonomous multi-ticket `/fit work` run. */
export function buildRunMessage(
	tickets: Ticket[],
	requestedCount: number,
	board: string,
	review: boolean,
	grill: boolean,
	autocommit: boolean,
): string {
	const label = tickets.length === 1 ? "ticket" : "tickets";
	const lines = [
		`Work autonomously through ${tickets.length} FIT ${label} from a fixed queue of ${requestedCount}.`,
		`Board: ${board}`,
		"",
		"Queue (in order):",
	];
	for (const [index, ticket] of tickets.entries()) {
		lines.push(
			`${index + 1}. ${ticket.id} (revision ${ticket.revision}) - ${ticket.title || ticket.displayName}`,
		);
	}
	lines.push(
		"",
		"These revisions are a snapshot from before grilling. Re-read each ticket with fit_show before moving or closing it.",
	);
	if (tickets.length < requestedCount) {
		lines.push(
			``,
			`Only ${tickets.length} of ${requestedCount} requested tickets could be queued. Work the available queue and report the shortfall.`,
		);
	}
	lines.push("");
	if (review) {
		lines.push(
			"Work the single queued ticket and keep it in in_progress while you work. Do not close it; leave it for human review.",
		);
	} else {
		lines.push(BATCH_AUTONOMY_INSTRUCTION);
	}
	if (grill) lines.push("", BATCH_GRILL_INSTRUCTION);
	if (autocommit) lines.push("", AUTOCOMMIT_INSTRUCTION);
	lines.push("", batchFinishInstruction(review, autocommit), TICKET_EDIT_GUARDRAIL);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("fit-dir", {
		type: "string",
		description: "FIT board directory (default: ./fit)",
	});
	pi.registerFlag("fit-guard", {
		type: "boolean",
		default: true,
		description:
			"Block built-in write/edit and obvious shell mutations of FIT board files (default: true)",
	});
	pi.registerFlag("fit-review", {
		type: "boolean",
		description:
			"Default /fit work and /fit start to review mode (default: false; env: FIT_REVIEW)",
	});
	pi.registerFlag("fit-nogrill", {
		type: "boolean",
		description:
			"Omit the clarifying-questions guidance from /fit work and /fit start prompts (default: false; env: FIT_NOGRILL)",
	});
	pi.registerFlag("fit-agent", {
		type: "boolean",
		description:
			"Agent mode: read-only outside the FIT board; board changes use fit_* tools and shell commands must be read-only (env: FIT_AGENT)",
	});

	// Agent mode narrows the agent to read-only work outside the board and
	// requires the fit_* tools for board changes. The FIT guard below still
	// applies when agent mode is off.
	//
	// The FIT tools are the only sanctioned mutation path for the board. Block
	// the two built-in tools that could otherwise corrupt a ticket silently.
	pi.on("tool_call", async (event, ctx) => {
		const board = resolveBoard(configuredBoard(pi), ctx.cwd);

		if (agentModeEnabled(pi)) {
			const reason = agentModeBlockReason(
				event.toolName,
				event.input as Record<string, unknown>,
				board,
				ctx.cwd,
			);
			if (reason) return { block: true, reason };
		}

		if (!guardEnabled(pi)) return undefined;
		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = event.input.path;
			if (typeof rawPath !== "string") return undefined;
			const target = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
			const absolute = isAbsolute(target) ? target : `${ctx.cwd}/${target}`;
			if (isInside(board, absolute)) {
				return {
					block: true,
					reason: `Direct ${event.toolName} on FIT board files is blocked. Use fit_new, fit_new_batch, fit_update, fit_move, or fit_cleanup so writes stay atomic, non-overwriting, and revision-checked.`,
				};
			}
		}

		if (event.toolName === "bash" && typeof event.input.command === "string") {
			if (bashMayMutateBoard(event.input.command, board, ctx.cwd)) {
				return {
					block: true,
					reason:
						"Shell command appears to mutate FIT board files. Use the fit_* tools instead, or pass --fit-guard=false if you really intend to bypass the guard.",
				};
			}
		}

		return undefined;
	});

	pi.on("session_start", async (event, ctx) => {
		applyAgentModeUi(pi, ctx);
		await refreshInProgressStatus(pi, ctx);
		if (
			agentModeEnabled(pi) &&
			(event.reason === "startup" || event.reason === "reload")
		) {
			ctx.ui.notify(
				"Agent mode is on: read-only outside the FIT board. Use fit_* tools for board changes.",
				"warning",
			);
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		await refreshInProgressStatus(pi, ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await refreshInProgressStatus(pi, ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!agentModeEnabled(pi)) return undefined;
		const board = resolveBoard(configuredBoard(pi), ctx.cwd);
		return {
			message: {
				customType: "fit-agent-mode",
				content: `Agent mode is active: read-only outside the FIT board. Use fit_* tools for board changes and only read-only shell commands. Board: ${board}`,
				display: true,
			},
		};
	});

	const initTool = defineTool({
		name: "fit_init",
		label: "FIT: init board",
		description:
			"Create a FIT board directory with the canonical open, in_progress, backlog, and closed status directories, FIT_SPEC.md at the board root, plus AGENTS.md and AGENT_SPEC.md beside the board. Set strict=true to write the quoted STRICT marker; refreshSpec upgrades a known vendored FIT_SPEC.md while keeping annotations. Plain init keeps the board inline with the parent working tree; git=true also ignores the board in the parent .gitignore and checks it out as a linked worktree on the parent repo's 'fit' branch, so closes commit on that branch. A board in its own repository is detected automatically. Existing local tickets are merged and same-path conflicts prompt for branch or local. Idempotent; unmarked AGENTS.md content and an existing AGENT_SPEC.md are preserved.",
		promptSnippet: "Initialize a FIT board and add FIT_SPEC.md, AGENT_SPEC.md, and AGENTS.md.",
		promptGuidelines: [
			"Use fit_init only when a FIT board does not exist; it never deletes or overwrites tickets, never overwrites AGENT_SPEC.md, and only updates its marked block in AGENTS.md.",
		],
		parameters: Type.Object({
			board: boardParam,
			git: Type.Optional(
				Type.Boolean({
					description:
						"Also ignore the board in the parent .gitignore and check it out as a linked worktree on the parent repo's 'fit' branch.",
				}),
			),
			strict: Type.Optional(
				Type.Boolean({
					description:
						'Opt in to Strict mode by writing STRICT containing the quoted spec version (e.g. "0.5").',
				}),
			),
			refreshSpec: Type.Optional(
				Type.Boolean({
					description:
						"Refresh a known vendored FIT_SPEC.md to the current version, preserving any appended local annotations.",
				}),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					initBoard(board, {
						git: params.git,
						strict: params.strict,
						refreshSpec: params.refreshSpec,
						resolveGitConflict: (ticket) => chooseGitConflict(ctx, ticket),
					}),
				);
				return makeResult(formatInitResult(result), {
					ok: true,
					board,
					message: `FIT board ready: ${board}`,
					created: result.created.length > 0,
					specCreated: result.specCreated,
					specUpdated: result.specUpdated,
					specPreserved: result.specPreserved,
					agentSpecCreated: result.agentSpecCreated,
					strictCreated: result.strictCreated,
					strict: result.strict,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const listTool = defineTool({
		name: "fit_list",
		label: "FIT: list tickets",
		description:
			"List FIT tickets with exact ids, deterministic order, and status counts. Order is status (in_progress, open, backlog, closed), then sub-status directories by name, then filename ascending, recursively. Read-only.",
		promptSnippet: "List FIT tickets with exact ids and status counts.",
		promptGuidelines: [
			"Use fit_list to discover exact FIT ticket ids; never guess or fuzzy-match an id in a mutation.",
		],
		parameters: Type.Object({
			board: boardParam,
			status: Type.Optional(
				Type.String({
					description:
						"Filter by status subtree, for example open or open/project-x. Canonical statuses: open, in_progress, backlog, closed.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 1000,
					description: "Maximum tickets to show (default 100).",
				}),
			),
		}),
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const { mode, tickets: all } = await readBoard(board);
				const { counts } = countTickets(all);
				const filter = params.status?.trim();
				let filtered = all;
				if (filter) {
					const normalized = normalizeStatusPath(filter, {
						allowExtra: mode.mode === "basic",
					});
					const [status, ...rest] = normalized.split("/");
					const subdir = rest.join("/");
					filtered = all.filter(
						(ticket) =>
							ticket.status === status &&
							(subdir === "" ||
								ticket.subdir === subdir ||
								ticket.subdir.startsWith(`${subdir}/`)),
					);
				}
				const limit = params.limit ?? 100;
				const listed = filtered.slice(0, limit);
				const text = formatList(board, mode, all, listed, counts, {
					filter: filter || undefined,
					limit,
					agentMode: agentModeEnabled(pi),
				});
				return makeResult(text, {
					ok: true,
					board,
					message: `${all.length} ticket(s)`,
					tickets: listed,
					counts,
					total: all.length,
					listed: listed.length,
					filter,
					mode: mode.mode,
					modeVersion: mode.version,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const showTool = defineTool({
		name: "fit_show",
		label: "FIT: show ticket",
		description:
			"Read one FIT ticket by exact id (for example open/03-fix-typo.md). A bare filename or unique short name works when unique. Returns content, parsed frontmatter, body, and a revision hash for safe mutations.",
		promptSnippet: "Read a FIT ticket and its revision.",
		promptGuidelines: [
			"Use fit_show before fit_update or fit_move, then pass the returned revision as expectedRevision to detect concurrent changes.",
			"fit_show accepts exact ids, unique bare filenames, or unique short names; it never guesses between multiple matches.",
		],
		parameters: Type.Object({
			board: boardParam,
			id: Type.String({
				description: "Exact board-relative ticket id, e.g. open/03-fix-typo.md.",
			}),
		}),
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const ticket = await readTicket(board, params.id);
				return makeResult(formatShow(ticket), {
					ok: true,
					board,
					message: ticket.id,
					id: ticket.id,
					revision: ticket.revision,
					ticket,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const newTool = defineTool({
		name: "fit_new",
		label: "FIT: new ticket",
		description:
			"Create a FIT ticket in open or backlog. Never overwrites a file; a name collision fails with NAME_TAKEN and a suggested free name. Repeating an identical create is a no-op. Keep a 1-3 sentence summary, then use ### headers; other body shapes return warnings.",
		promptSnippet: "Create a FIT ticket in open or backlog.",
		promptGuidelines: [
			"Use fit_new with a 1-3 sentence summary plus ### sections and a short hyphenated slug; put extra structured data in frontmatter.",
			"Use fit_new_batch when recording a planned list of tickets at once.",
			"Do not create ticket files with write or bash; fit_new enforces naming, status, and no-overwrite rules.",
		],
		parameters: Type.Object({
			board: boardParam,
			content: Type.String({
				description:
					"Ticket body: a 1-3 sentence summary, then everything else under ### headers.",
			}),
			slug: Type.Optional(
				Type.String({
					description:
						"Filename name part. Defaults to the first 7 words of the first sentence of content. Lowercased and hyphenated.",
				}),
			),
			title: Type.Optional(
				Type.String({ description: "Alias for slug when no slug is supplied." }),
			),
			priority: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: MAX_PRIORITY,
					description: "Two-digit filename priority; defaults to 0.",
				}),
			),
			status: Type.Optional(
				Type.String({
					description:
						"Initial status path starting with open or backlog; defaults to open. Example: open/project-x.",
				}),
			),
			project: Type.Optional(
				Type.String({ description: "Frontmatter project name." }),
			),
			frontmatter: Type.Optional(frontmatterSchema),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					createTicket({
						board,
						content: params.content,
						slug: params.slug,
						title: params.title,
						priority: params.priority,
						status: params.status,
						project: params.project,
						frontmatter: params.frontmatter as
							| Record<string, FrontmatterValue>
							| undefined,
					}),
				);
				const action = result.created ? "Created" : "Ticket already existed";
				const text = `${action}: ${result.ticket.id} (revision ${result.ticket.revision})\nBoard: ${board}${formatWarnings(result.warnings)}`;
				return makeResult(text, {
					ok: true,
					board,
					message: `${action}: ${result.ticket.id}`,
					id: result.ticket.id,
					revision: result.ticket.revision,
					created: result.created,
					ticket: result.ticket,
					warnings: result.warnings,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const batchTool = defineTool({
		name: "fit_new_batch",
		label: "FIT: new tickets (batch)",
		description:
			"Create several FIT tickets from a JSON list of ticket-like objects in one call. Each item accepts content, slug/title, priority, status, and frontmatter, like fit_new. Defaults to open; new tickets must target open or backlog. Never overwrites; collisions fail with NAME_TAKEN. Identical items are idempotent.",
		promptSnippet: "Create a planned list of FIT tickets in one call.",
		promptGuidelines: [
			"Use fit_new_batch when you have planned a course of action and need to record multiple tickets at once.",
			"Each item is validated before any ticket is written; use fit_new for a single ticket.",
		],
		parameters: Type.Object({
			board: boardParam,
			tickets: Type.Array(
				Type.Object({
					content: Type.String({
						description:
							"Ticket body: a 1-3 sentence summary, then everything else under ### headers.",
					}),
					slug: Type.Optional(
						Type.String({
							description:
								"Filename name part. Defaults to the first 7 words of the first sentence of content. Lowercased and hyphenated.",
						}),
					),
					title: Type.Optional(
						Type.String({ description: "Alias for slug when no slug is supplied." }),
					),
					priority: Type.Optional(
						Type.Integer({
							minimum: 0,
							maximum: MAX_PRIORITY,
							description: "Two-digit filename priority; defaults to 0.",
						}),
					),
					status: Type.Optional(
						Type.String({
							description:
								"Initial status path starting with open or backlog; defaults to open. Example: open/project-x.",
						}),
					),
					project: Type.Optional(
						Type.String({ description: "Frontmatter project name." }),
					),
					frontmatter: Type.Optional(frontmatterSchema),
				}),
				{ description: "JSON list of ticket-like objects to create." },
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					createTickets({
						board,
						tickets: params.tickets.map((ticket) => ({
							...ticket,
							frontmatter: ticket.frontmatter as
								| Record<string, FrontmatterValue>
								| undefined,
						})),
					}),
				);
				const createdCount = result.tickets.filter((ticket) => ticket.created).length;
				const existingCount = result.tickets.length - createdCount;
				const lines = [
					`FIT board: ${board}`,
					`Created ${createdCount} ticket(s); ${existingCount} already existed.`,
				];
				for (const ticket of result.tickets) {
					lines.push(
						`${ticket.created ? "+" : "="} ${ticket.ticket.id} (revision ${ticket.ticket.revision})`,
					);
				}
				return makeResult(`${lines.join("\n")}${formatWarnings(result.warnings)}`, {
					ok: true,
					board,
					message: `Created ${createdCount} ticket(s)${existingCount ? `, ${existingCount} already existed` : ""}`,
					created: createdCount > 0,
					createdCount,
					existingCount,
					tickets: result.tickets.map((ticket) => ticket.ticket),
					warnings: result.warnings,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const updateTool = defineTool({
		name: "fit_update",
		label: "FIT: update ticket",
		description:
			"Update a FIT ticket body or top-level frontmatter fields without touching unrelated YAML. Body changes keep a 1-3 sentence summary and ### sections. Never deletes a ticket or overwrites another file. Pass expectedRevision from fit_show to fail safely if the ticket changed.",
		promptSnippet: "Update a FIT ticket body/frontmatter safely.",
		promptGuidelines: [
			"Use fit_update instead of edit on ticket files; it preserves unknown frontmatter YAML and refuses stale writes.",
			"Pass expectedRevision from fit_show when updating a ticket you read earlier.",
		],
		parameters: Type.Object({
			board: boardParam,
			id: Type.String({ description: "Exact board-relative ticket id." }),
			body: Type.Optional(Type.String({ description: "New ticket body, or text to append." })),
			bodyMode: Type.Optional(
				Type.Union([Type.Literal("replace"), Type.Literal("append")], {
					description: "replace (default) or append.",
				}),
			),
			set: Type.Optional(
				frontmatterSchema,
			),
			unset: Type.Optional(
				Type.Array(Type.String(), {
					description: "Top-level frontmatter keys to remove.",
				}),
			),
			project: Type.Optional(
				Type.String({ description: "Set the frontmatter project name." }),
			),
			priority: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: MAX_PRIORITY,
					description: "Rename the ticket with this priority (00-99).",
				}),
			),
			slug: Type.Optional(
				Type.String({ description: "Rename the ticket with this name part." }),
			),
			expectedRevision: Type.Optional(
				Type.String({
					description:
						"Revision from fit_show. The update fails if the ticket no longer matches.",
				}),
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					updateTicket({
						board,
						id: params.id,
						body: params.body,
						bodyMode: params.bodyMode,
						set: params.set as Record<string, FrontmatterValue> | undefined,
						unset: params.unset,
						project: params.project,
						priority: params.priority,
						slug: params.slug,
						expectedRevision: params.expectedRevision,
					}),
				);
				const renamed =
					result.previousId !== result.ticket.id
						? `\nRenamed: ${result.previousId} -> ${result.ticket.id}`
						: "";
				const text = result.changed
					? `Updated ${result.ticket.id} (revision ${result.ticket.revision})${renamed}${formatWarnings(result.warnings)}`
					: `No change: ${result.ticket.id} (revision ${result.ticket.revision})`;
				return makeResult(text, {
					ok: true,
					board,
					message: result.changed ? `Updated ${result.ticket.id}` : `No change: ${result.ticket.id}`,
					id: result.ticket.id,
					previousId: result.previousId,
					revision: result.ticket.revision,
					changed: result.changed,
					ticket: result.ticket,
					warnings: result.warnings,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const moveTool = defineTool({
		name: "fit_move",
		label: "FIT: move ticket",
		description:
			"Move a FIT ticket to another status directory. A top-level status keeps the ticket's project subdirectory; an explicit subtree such as closed/project-x wins. Basic boards allow extra top-level statuses, while Strict boards allow only the canonical four. Closing a non-inline board writes completed and commits the board branch. Never overwrites; collisions fail with NAME_TAKEN. Idempotent and revision-checked.",
		promptSnippet: "Move a FIT ticket between status directories.",
		promptGuidelines: [
			"Use fit_move rather than renaming or moving ticket files with bash.",
			"FIT lifecycle: open/backlog -> in_progress while working -> closed when finished.",
		],
		parameters: Type.Object({
			board: boardParam,
			id: Type.String({ description: "Exact board-relative ticket id." }),
			status: Type.String({
				description:
					"Target status path: open, in_progress, backlog, closed, or a subtree such as closed/project-x.",
			}),
			priority: Type.Optional(
				Type.Integer({ minimum: 0, maximum: MAX_PRIORITY, description: "Also set the two-digit priority (00-99) in the filename." }),
			),
			slug: Type.Optional(
				Type.String({ description: "Also rename the ticket's short-name part." }),
			),
			expectedRevision: Type.Optional(
				Type.String({
					description:
						"Revision from fit_show. The move fails if the ticket no longer matches.",
				}),
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					moveTicket({
						board,
						id: params.id,
						status: params.status,
						priority: params.priority,
						slug: params.slug,
						expectedRevision: params.expectedRevision,
					}),
				);
				const text = result.changed
					? `Moved ${result.fromId} -> ${result.toId} (revision ${result.ticket.revision})`
					: `Already at ${result.toId} (revision ${result.ticket.revision})`;
				return makeResult(text, {
					ok: true,
					board,
					message: result.changed
						? `Moved ${result.fromId} -> ${result.toId}`
						: `Already at ${result.toId}`,
					id: result.toId,
					previousId: result.fromId,
					toId: result.toId,
					revision: result.ticket.revision,
					changed: result.changed,
					ticket: result.ticket,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const cleanupTool = defineTool({
		name: "fit_cleanup",
		label: "FIT: clean ticket filenames",
		description:
			"Truncate excessively long FIT ticket filenames. Only the filename changes; status, subdirectory, priority, frontmatter, and body are preserved. Existing names are never overwritten, collisions get suffixes, and dryRun previews the renames. Default maximum stem length is 30 characters (excluding .md).",
		promptSnippet: "Truncate excessively long FIT ticket filenames.",
		promptGuidelines: [
			"Use fit_cleanup when ticket filenames are too long; pass maxLength to override the default 30-character stem limit.",
			"Use dryRun: true first if you want to preview renames before changing the board.",
		],
		parameters: Type.Object({
			board: boardParam,
			maxLength: Type.Optional(
				Type.Integer({
					minimum: 8,
					maximum: 255,
					description: `Maximum filename stem length excluding .md (default ${DEFAULT_MAX_TICKET_NAME_CHARS}).`,
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({ description: "Preview renames without modifying the board." }),
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					cleanupTicketNames(board, {
						maxLength: params.maxLength,
						dryRun: params.dryRun,
					}),
				);
				const action = result.dryRun ? "Would rename" : "Renamed";
				return makeResult(formatCleanupResult(board, result), {
					ok: true,
					board,
					message: `${action} ${result.renamed.length} ticket(s)`,
					changed: !result.dryRun && result.renamed.length > 0,
					renamed: result.renamed,
					skipped: result.skipped,
					maxLength: result.maxLength,
					dryRun: result.dryRun,
				});
			});
		},
		renderResult: renderToolResult,
	});

	const archiveTool = defineTool({
		name: "fit_archive",
		label: "FIT: archive ticket",
		description:
			"Append a closed ticket to closed/archive.txt as a fenced archive record, then remove the ticket file. Archived tickets are excluded from name uniqueness. Revision-checked and non-overwriting.",
		promptSnippet: "Archive a closed FIT ticket.",
		promptGuidelines: [
			"Use fit_archive only for closed tickets; it appends to closed/archive.txt and removes the ticket file.",
		],
		parameters: Type.Object({
			board: boardParam,
			id: Type.String({ description: "Exact board-relative ticket id, e.g. closed/03-fix-typo.md." }),
			expectedRevision: Type.Optional(
				Type.String({
					description:
						"Revision from fit_show. The archive fails if the ticket no longer matches.",
				}),
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					archiveTicket({
						board,
						id: params.id,
						expectedRevision: params.expectedRevision,
					}),
				);
				return makeResult(
					`Archived ${result.archivedId} as ${result.recordPath} in ${result.archivePath}`,
					{
						ok: true,
						board,
						message: `Archived ${result.archivedId}`,
						id: result.archivedId,
						revision: result.revision,
						recordPath: result.recordPath,
						archivePath: result.archivePath,
					},
				);
			});
		},
		renderResult: renderToolResult,
	});

	const restoreTool = defineTool({
		name: "fit_restore",
		label: "FIT: restore archived ticket",
		description:
			"Restore one fenced record from closed/archive.txt into a new ticket under a status directory (default open), then remove the record. Rejects name collisions with active tickets.",
		promptSnippet: "Restore an archived FIT ticket.",
		promptGuidelines: [
			"Use fit_restore with an archived record path; it recreates the ticket and removes the archive record.",
		],
		parameters: Type.Object({
			board: boardParam,
			id: Type.String({
				description:
					"Archived record path, with or without the board prefix, e.g. fit/closed/03-fix-typo.md.",
			}),
			status: Type.Optional(
				Type.String({ description: "Destination status path; defaults to open." }),
			),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await withFileMutationQueue(board, () =>
					restoreArchivedTicket({ board, id: params.id, status: params.status }),
				);
				return makeResult(
					`Restored ${result.fromRecord} -> ${result.ticket.id} (revision ${result.ticket.revision}); ${result.remainingRecords} record(s) remain.`,
					{
						ok: true,
						board,
						message: `Restored ${result.ticket.id}`,
						id: result.ticket.id,
						revision: result.ticket.revision,
						fromRecord: result.fromRecord,
						remainingRecords: result.remainingRecords,
					},
				);
			});
		},
		renderResult: renderToolResult,
	});

	const checkTool = defineTool({
		name: "fit_check",
		label: "FIT: check board",
		description:
			"Validate a FIT board without modifying it. Basic rules always run; Strict rules run only with a STRICT marker. Covers status dirs, ticket placement, filename format and safety, priority 00-99, short-name uniqueness and length, body shape, frontmatter, single in_progress, archive records, and stray root Markdown. Read-only.",
		promptSnippet: "Validate FIT board integrity and conventions.",
		promptGuidelines: [
			"Use fit_check after bulk changes or when a board looks inconsistent; it reports issues but never fixes them automatically.",
		],
		parameters: Type.Object({ board: boardParam }),
		annotations: { readOnlyHint: true, idempotentHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return runBoardTool(pi, params, ctx, async (board) => {
				const result = await checkBoard(board);
				const { text, errors, warnings } = formatCheckResult(board, result);
				return makeResult(text, {
					ok: true,
					board,
					message:
						result.issues.length === 0
							? "Board is clean"
							: `${errors.length} error(s), ${warnings.length} warning(s)`,
					total: result.total,
					counts: result.counts,
					issues: result.issues.slice(0, 200),
					issueCount: result.issues.length,
					mode: result.mode.mode,
					modeVersion: result.mode.version,
				});
			});
		},
		renderResult: renderToolResult,
	});

	pi.registerTool(initTool);
	pi.registerTool(listTool);
	pi.registerTool(showTool);
	pi.registerTool(newTool);
	pi.registerTool(batchTool);
	pi.registerTool(updateTool);
	pi.registerTool(moveTool);
	pi.registerTool(cleanupTool);
	pi.registerTool(archiveTool);
	pi.registerTool(restoreTool);
	pi.registerTool(checkTool);

	// -------------------------------------------------------------------------
	// Human command: fuzzy matching is allowed here only.
	// -------------------------------------------------------------------------

	pi.registerCommand("fit", {
		description:
			"Browse/edit a FIT board. Run /fit help for sub-commands and arguments. Run /fit check for a literal fit check. Human-only fuzzy lookup: /fit agent [on|off|status], /fit init, /fit show [text], /fit edit [local] [query], /fit archive [text], /fit close [text], /fit move <text> <status>, /fit priority <text> <0-99>, /fit work [N] [review] [nogrill] [autocommit], /fit new|add <status> <priority> <text>, /fit start [review] [nogrill] <text>, /fit plan-a-leg [nogrill] [query|text], /fit check, /fit check cleanup [max] [dry-run], /fit git, /fit list [status]",
		handler: async (args, ctx) => {
			const board = resolveBoard(configuredBoard(pi), ctx.cwd);
			const input = args.trim();
			const [command = "list", ...rest] = input.split(/\s+/).filter(Boolean);
			try {
				if (
					command === "help" ||
					command === "--help" ||
					command === "-h" ||
					command === "?"
				) {
					ctx.ui.notify(fitHelp(board), "info");
					return;
				}

				if (command === "init") {
					let git = false;
					let strict = false;
					let refreshSpec = false;
					for (const raw of rest) {
						const arg = raw.toLowerCase();
						if (["git", "--git", "true"].includes(arg)) {
							git = true;
						} else if (["strict", "--strict"].includes(arg)) {
							strict = true;
						} else if (["refresh", "--refresh", "upgrade"].includes(arg)) {
							refreshSpec = true;
						} else {
							throw new FitError(
								"INVALID_ARGUMENTS",
								"Usage: /fit init [strict] [refresh] [git]",
							);
						}
					}
					const result = await withFileMutationQueue(board, () =>
						initBoard(board, {
							git,
							strict,
							refreshSpec,
							resolveGitConflict: (ticket) => chooseGitConflict(ctx, ticket),
						}),
					);
					ctx.ui.notify(formatInitResult(result), "info");
					return;
				}

				if (command === "agent" || command === "mode") {
					if (rest.length > 1) {
						throw new FitError(
							"INVALID_ARGUMENTS",
							`Unknown /fit agent argument: ${rest.slice(1).join(" ")}`,
							{ hint: "Usage: /fit agent [on|off|status]" },
						);
					}
					const action = parseAgentModeAction(rest[0]);
					if (!action) {
						throw new FitError(
							"INVALID_ARGUMENTS",
							`Unknown /fit agent action: ${rest[0]}`,
							{ hint: "Usage: /fit agent [on|off|status]" },
						);
					}
					applyAgentModeAction(pi, ctx, action);
					return;
				}

				if (command === "list" || command === "ls" || input === "") {
					const { mode, tickets: all } = await readBoard(board);
					const { counts } = countTickets(all);
					const filter = rest.join(" ");
					const filtered = filter
						? all.filter((ticket) => ticket.id.startsWith(filter))
						: all;
					const limit = 100;
					const listed = filtered.slice(0, limit);
					const columns = process.stdout.columns;
					ctx.ui.notify(
						formatList(board, mode, all, listed, counts, {
							filter: filter || undefined,
							limit,
							agentMode: agentModeEnabled(pi),
							stacked: true,
							// Status output is rendered with one column of padding on each side.
							width: columns ? Math.max(1, columns - 2) : undefined,
						}),
						"info",
					);
					return;
				}

				if (command === "check") {
					const subcommand = rest[0]?.toLowerCase();
					if (subcommand === "cleanup" || subcommand === "clean") {
						let maxLength: number | undefined;
						let dryRun = false;
						for (const arg of rest.slice(1)) {
							if (["dry-run", "--dry-run", "preview"].includes(arg.toLowerCase())) {
								dryRun = true;
							} else if (/^\d+$/.test(arg)) {
								maxLength = Number(arg);
							} else {
								throw new FitError(
									"INVALID_ARGUMENTS",
									`Unknown /fit check cleanup argument: ${arg}`,
									{ hint: "Usage: /fit check cleanup [max-length] [dry-run]" },
								);
							}
						}
						const result = await withFileMutationQueue(board, () =>
							cleanupTicketNames(board, { maxLength, dryRun }),
						);
						ctx.ui.notify(formatCleanupResult(board, result), "info");
						return;
					}
					if (subcommand === "normalize" || subcommand === "bodies") {
						const dryRun = rest
							.slice(1)
							.some((arg) => ["dry-run", "--dry-run", "preview"].includes(arg.toLowerCase()));
						const result = await withFileMutationQueue(board, () =>
							normalizeLegacyBodies(board, { dryRun }),
						);
						ctx.ui.notify(formatNormalizeBodiesResult(board, result), "info");
						return;
					}
					if (subcommand === "migrate" || subcommand === "migration") {
						if (rest.length > 1) {
							throw new FitError(
								"INVALID_ARGUMENTS",
								`Unknown /fit check ${subcommand} argument: ${rest.slice(1).join(" ")}`,
								{ hint: `Usage: /fit check ${subcommand}` },
							);
						}
						const report = await migrationReport(board);
						ctx.ui.notify(
							formatMigrationReport(board, report),
							report.actions.length ? "warning" : "info",
						);
						return;
					}
					if (rest.length > 0) {
						throw new FitError(
							"INVALID_ARGUMENTS",
							`Unknown /fit check argument: ${rest.join(" ")}`,
							{ hint: "Usage: /fit check [cleanup [max-length] [dry-run]] | migrate | normalize [dry-run]" },
						);
					}
					const result = await checkBoard(board);
					const { text, errors } = formatCheckResult(board, result, 50);
					ctx.ui.notify(text, errors.length ? "error" : "info");
					return;
				}

				if (command === "git") {
					if (rest.length > 0) {
						throw new FitError("INVALID_ARGUMENTS", "Usage: /fit git");
					}
					const result = await withFileMutationQueue(board, () =>
						recordClosedTicketsCommit(board),
					);
					const lines = [
						`FIT board: ${board}`,
						`Parent commit: ${result.commitHash || "(unknown)"}`,
						`Recorded: ${result.recorded.length} ticket(s); ${result.skipped} already had a commit hash.`,
					];
					for (const id of result.recorded) lines.push(`+ ${id}`);
					if (result.inline) {
						lines.push(
							"Board commit: inline; close moves belong to the parent work commit",
						);
					} else {
						lines.push(
							result.committed
								? `Board commit: ${result.commitMessage}`
								: "Board commit: not needed",
						);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (command === "show") {
					const query = rest.join(" ");
					if (!query) {
						const all = await listTickets(board);
						const inProgress = inProgressTickets(all);
						if (inProgress.length === 0) {
							ctx.ui.notify("No ticket is in in_progress.", "warning");
							return;
						}
						if (inProgress.length > 1) {
							ctx.ui.notify(
								`in_progress has ${inProgress.length} tickets, not exactly one:\n${inProgress.map((ticket) => ticket.id).join("\n")}`,
								"warning",
							);
							return;
						}
						const ticket = await readTicket(board, inProgress[0].id);
						ctx.ui.notify(formatShow(ticket), "info");
						return;
					}
					const all = await listTickets(board);
					const selected = await pickTicket(ctx, all, query);
					if (!selected) return;
					const ticket = await readTicket(board, selected.id);
					ctx.ui.notify(formatShow(ticket), "info");
					return;
				}

				if (command === "edit" || command === "open" || command === "code" || command === "vscode") {
					const flags = parseEditFlags(rest);
					const all = await listTickets(board);
					let selected: TicketSummary | undefined;
					if (flags.query) {
						selected = await pickTicket(ctx, all, flags.query);
					} else {
						const inProgress = inProgressTickets(all);
						if (inProgress.length === 0) {
							throw new FitError(
								"NO_IN_PROGRESS",
								"No ticket is in in_progress to open.",
								{ hint: "Pass a query to open a specific ticket, e.g. /fit edit typo." },
							);
						}
						selected = await selectTicket(
							ctx,
							inProgress,
							"Multiple in_progress tickets. Pick one to open:",
							"Multiple in_progress tickets",
						);
					}
					if (!selected) return;

					if (flags.localEdit) {
						if (!ctx.hasUI) {
							throw new FitError(
								"NO_UI",
								"/fit edit local needs an interactive UI to open the multiline editor.",
							);
						}
						const ticket = await readTicket(board, selected.id);
						const edited = await ctx.ui.editor(
							`Edit ${ticket.id} (body). Frontmatter is preserved:`,
							ticket.body,
						);
						if (edited === undefined) {
							ctx.ui.notify("Edit cancelled.", "info");
							return;
						}
						const result = await withFileMutationQueue(board, () =>
							updateTicket({
								board,
								id: ticket.id,
								body: edited,
								bodyMode: "replace",
								expectedRevision: ticket.revision,
							}),
						);
						ctx.ui.notify(
							result.changed
								? `Updated ${result.ticket.id} (revision ${result.ticket.revision})`
								: `No change: ${result.ticket.id}`,
							"info",
						);
						return;
					}

					const vscode = runningInVsCodeTerminal();
					if (vscode) {
						await openInVscode(selected.path);
					} else {
						await openInDefaultEditor(selected.path);
					}
					ctx.ui.notify(
						`Opened ${selected.id} in ${vscode ? "VS Code" : "your default editor"}.`,
						"info",
					);
					return;
				}

				if (command === "archive" || command === "arch") {
					const all = await listTickets(board);
					const closed = all.filter((ticket) => ticket.status === "closed");
					const query = rest.join(" ");
					const selected = query
						? await pickTicket(ctx, closed, query)
						: await selectTicket(
								ctx,
								closed,
								"Select a closed ticket to archive:",
								"Multiple closed tickets",
							);
					if (!selected) return;
					if (!ctx.hasUI) {
						ctx.ui.notify(
							"Archive needs an interactive confirmation.",
							"warning",
						);
						return;
					}
					const confirmation = await ctx.ui.select(
						`Archive ${selected.id}?`,
						["Archive", "Cancel"],
					);
					if (confirmation !== "Archive") return;
					const ticket = await readTicket(board, selected.id);
					const result = await withFileMutationQueue(board, () =>
						archiveTicket({
							board,
							id: ticket.id,
							expectedRevision: ticket.revision,
						}),
					);
					ctx.ui.notify(
						`Archived ${result.archivedId} as ${result.recordPath}`,
						"info",
					);
					return;
				}

				if (command === "close") {
					const all = await listTickets(board);
					const query = rest.join(" ");
					let selected: TicketSummary | undefined;
					if (query) {
						// With a query, match any ticket, mirroring the CLI's close <name>.
						selected = await pickTicket(ctx, all, query);
					} else {
						const inProgress = inProgressTickets(all);
						if (inProgress.length === 0) {
							throw new FitError(
								"NO_IN_PROGRESS",
								"No ticket is in in_progress.",
								{ hint: "Pass a query to close a specific ticket, e.g. /fit close typo." },
							);
						}
						selected = await selectTicket(
							ctx,
							inProgress,
							"Select an in_progress ticket to close:",
							"Multiple in_progress tickets",
						);
					}
					if (!selected) return;

					const ticket = await readTicket(board, selected.id);
					const result = await withFileMutationQueue(board, () =>
						moveTicket({
							board,
							id: ticket.id,
							status: "closed",
							expectedRevision: ticket.revision,
						}),
					);
					ctx.ui.notify(
						result.changed
							? `Closed ${result.fromId} -> ${result.toId}`
							: `Already closed: ${result.toId}`,
						"info",
					);
					return;
				}

				if (command === "move" || command === "mv") {
					const query = rest.slice(0, -1).join(" ");
					const status = rest[rest.length - 1];
					if (!query || !status) {
						throw new FitError(
							"MISSING_ARGUMENTS",
							"Usage: /fit move <text> <status>",
						);
					}
					const all = await listTickets(board);
					const selected = await pickTicket(ctx, all, query);
					if (!selected) return;
					const result = await withFileMutationQueue(board, () =>
						moveTicket({ board, id: selected.id, status }),
					);
					ctx.ui.notify(
						result.changed
							? `Moved ${result.fromId} -> ${result.toId}`
							: `Already at ${result.toId}`,
						"info",
					);
					return;
				}

				if (command === "priority" || command === "pri") {
					const query = rest.slice(0, -1).join(" ");
					const rawPriority = rest[rest.length - 1];
					if (!query || rawPriority === undefined) {
						throw new FitError(
							"MISSING_ARGUMENTS",
							"Usage: /fit priority <text> <0-99>",
						);
					}
					const priority = Number(rawPriority);
					if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
						throw new FitError(
							"INVALID_PRIORITY",
							`Priority must be an integer between 0 and ${MAX_PRIORITY}, got: ${rawPriority}`,
						);
					}
					const all = await listTickets(board);
					const selected = await pickTicket(ctx, all, query);
					if (!selected) return;
					const result = await withFileMutationQueue(board, () =>
						updateTicket({ board, id: selected.id, priority }),
					);
					ctx.ui.notify(
						result.changed
							? `Priority updated: ${result.previousId} -> ${result.ticket.id}`
							: `Priority unchanged: ${result.ticket.id}`,
						"info",
					);
					return;
				}

				if (command === "work" || command === "w") {
					const runFlags = parseWorkRunFlags(rest);
					if (runFlags.rest.length > 0) {
						throw new FitError(
							"INVALID_FLAG",
							`Unknown /fit work flag: ${runFlags.rest.join(" ")}`,
							{ hint: "Usage: /fit work [N] [review] [nogrill] [autocommit]" },
						);
					}
					const review = runFlags.review ?? configuredReview(pi);
					const grill = !(runFlags.nogrill ?? configuredNogrill(pi));
					const planOnly = agentModeEnabled(pi);
					const requested = runFlags.count ?? (runFlags.autocommit ? 1 : undefined);

					if (requested !== undefined) {
						if (review && requested > 1) {
							throw new FitError(
								"INVALID_ARGUMENTS",
								"Review mode cannot run a multi-ticket batch because each ticket must close before the next can start.",
								{ hint: "Use /fit work <N> without review, or /fit work review for one ticket." },
							);
						}
						if (review && runFlags.autocommit) {
							throw new FitError(
								"INVALID_ARGUMENTS",
								"Autocommit cannot be combined with review mode because the ticket stays in_progress and no commit hash can be recorded.",
								{ hint: "Remove review or remove autocommit." },
							);
						}
						if (planOnly) {
							throw new FitError(
								"INVALID_ARGUMENTS",
								"Agent mode is plan-only and cannot run /fit work with an explicit ticket count or autocommit.",
								{ hint: "Turn agent mode off, or use plain /fit work for one ticket." },
							);
						}

						const all = await listTickets(board);
						let queue = selectWorkQueue(all, requested);
						if (queue.length === 0) {
							const backlog = all.filter((ticket) => ticket.status === "backlog");
							if (backlog.length > 0) {
								if (!ctx.hasUI) {
									ctx.ui.notify(
										"No in_progress or open tickets. Filling the batch from backlog needs an interactive confirmation.",
										"warning",
									);
									return;
								}
								const choice = await ctx.ui.select(
									"No in_progress or open tickets. Fill the batch from backlog?",
									["Fill from backlog", "Cancel"],
								);
								if (choice !== "Fill from backlog") return;
								queue = selectWorkQueue(all, requested, true);
							}
						}
						if (queue.length === 0) {
							throw new FitError(
								"NO_WORK",
								"No in_progress, open, or confirmed backlog ticket to work.",
								{ hint: "Create one with /fit new or /fit start." },
							);
						}

						let promotedFrom: string | undefined;
						let promotedTo: string | undefined;
						if (queue[0].status !== "in_progress") {
							const moved = await withFileMutationQueue(board, () =>
								moveTicket({
									board,
									id: queue[0].id,
									status: "in_progress",
								}),
							);
							promotedFrom = moved.fromId;
							promotedTo = moved.toId;
						}

						const tickets: Ticket[] = [];
						for (const summary of queue) {
							const id = summary.id === promotedFrom ? promotedTo! : summary.id;
							tickets.push(await readTicket(board, id));
						}

						const message = buildRunMessage(
							tickets,
							requested,
							board,
							review,
							grill,
							runFlags.autocommit,
						);
						const details = [
							`${tickets.length}${tickets.length < requested ? ` of ${requested}` : ""} ticket(s)`,
							runFlags.autocommit ? "autocommit" : "",
							review ? "review required" : "",
						].filter(Boolean);
						ctx.ui.notify(
							`${promotedFrom ? `Promoted ${promotedFrom} -> ${promotedTo}; ` : ""}telling the agent to work ${details.join(", ")}.`,
							tickets.length < requested ? "warning" : "info",
						);
						pi.sendUserMessage(message);
						return;
					}

					const all = await listTickets(board);
					const inProgress = inProgressTickets(all);
					let ticket: Ticket;
					let promotedFrom: string | undefined;

					if (inProgress.length === 0) {
						const selected = nextTicketToPromote(all);
						if (!selected) {
							throw new FitError(
								"NO_WORK",
								"No in_progress ticket and no open or backlog ticket to promote.",
								{ hint: "Create one with /fit new or /fit start." },
							);
						}

						// Backlog is deliberately deferred work, so pulling it into
						// in_progress needs an explicit human confirmation. Open tickets
						// keep the existing promote-and-work behavior.
						if (selected.status === "backlog") {
							if (!ctx.hasUI) {
								ctx.ui.notify(
									`Pulling ${selected.id} from backlog needs an interactive confirmation.`,
									"warning",
								);
								return;
							}
							const choice = await ctx.ui.select(
								`No ticket is in progress. Pull ${selected.id} from backlog into in_progress?`,
								["Pull and work", "Cancel"],
							);
							if (choice !== "Pull and work") return;
						}

						const moved = await withFileMutationQueue(board, () =>
							moveTicket({
								board,
								id: selected.id,
								status: "in_progress",
							}),
						);
						promotedFrom = moved.fromId;
						ticket = await readTicket(board, moved.toId);
					} else {
						const selected = await selectTicket(
							ctx,
							inProgress,
							"Multiple in_progress tickets. Pick one:",
							"Multiple in_progress tickets",
						);
						if (!selected) return;
						ticket = await readTicket(board, selected.id);
					}

					const message = buildWorkMessage(
						ticket,
						promotedFrom,
						review,
						grill,
						planOnly,
					);
					ctx.ui.notify(
						promotedFrom
							? `Promoted ${promotedFrom} -> ${ticket.id}; telling the agent to ${planOnly ? "plan it" : "work on it"}${review ? " (review required)" : ""}.`
							: `Telling the agent to ${planOnly ? "plan" : "work on"} ${ticket.id}${review ? " (review required)" : ""}.`,
						"info",
					);
					pi.sendUserMessage(message);
					return;
				}

				if (command === "plan-a-leg") {
					const flags = parsePlanLegFlags(rest);
					const content = flags.rest.join(" ");
					const grill = !(flags.nogrill ?? configuredNogrill(pi));
					const all = await listTickets(board);
					let ticket: Ticket;
					let createdFromText = false;
					let createdId: string | undefined;

					if (content) {
						const candidates = all.filter((item) => item.status !== "closed");
						const matches = fuzzyFind(candidates, content);
						let selected: TicketSummary | undefined;
						if (matches.length > 0) {
							selected = await selectTicket(
								ctx,
								matches,
								"Text matches existing tickets. Pick the umbrella:",
								"Multiple matches",
							);
							if (!selected) return;
							if (!ctx.hasUI) {
								ctx.ui.notify(
									`Text matches ${selected.id}. Run /fit plan-a-leg with no text to use the current ticket, or rerun interactively to choose between that ticket and a new one.`,
									"warning",
								);
								return;
							}
							const choice = await ctx.ui.select(
								`Use ${selected.id} as the umbrella, or create a new ticket from "${content}"?`,
								["Use it", "Create new", "Cancel"],
							);
							if (choice === "Create new") selected = undefined;
							if (choice !== "Use it" && choice !== "Create new") return;
						}

						if (selected) {
							ticket = await readTicket(board, selected.id);
						} else {
							const created = await withFileMutationQueue(board, () =>
								createTicket({ board, content }),
							);
							createdFromText = true;
							createdId = created.ticket.id;
							ticket = await readTicket(board, created.ticket.id);
						}
					} else {
						const inProgress = inProgressTickets(all);
						if (inProgress.length === 0) {
							throw new FitError(
								"NO_IN_PROGRESS",
								"No ticket is in_progress. Pass text to plan a new leg or match an existing ticket.",
								{ hint: "Usage: /fit plan-a-leg [nogrill] [query|text]" },
							);
						}
						const selected = await selectTicket(
							ctx,
							inProgress,
							"Multiple in_progress tickets. Pick the umbrella:",
							"Multiple in_progress tickets",
						);
						if (!selected) return;
						ticket = await readTicket(board, selected.id);
					}

					// This command is deliberately more than agent mode: it turns
					// the mode on and then owns the leg-splitting prompt.
					setAgentMode(true);
					applyAgentModeUi(pi, ctx);

					const legStatus = `open${ticket.subdir ? `/${ticket.subdir}` : ""}`;
					ctx.ui.notify(
						`${createdFromText ? `Created ${ticket.id}; ` : ""}Agent mode is on; planning a leg from ${ticket.id} into ${legStatus} tickets.`,
						"warning",
					);
					pi.sendUserMessage(
						buildPlanLegMessage(
							ticket,
							board,
							legStatus,
							grill,
							createdFromText,
							createdId,
						),
					);
					return;
				}

				if (command === "start") {
					const flags = parseWorkFlags(
						rest,
						"start",
						"/fit start [review] [nogrill] <text>",
					);
					const content = flags.rest.join(" ");
					const review = flags.review ?? configuredReview(pi);
					const grill = !(flags.nogrill ?? configuredNogrill(pi));
					if (!content) {
						throw new FitError(
							"MISSING_CONTENT",
							"Usage: /fit start [review] [nogrill] <text>",
						);
					}
					const started = await withFileMutationQueue(board, async () => {
						const created = await createTicket({ board, content });
						const moved = await moveTicket({
							board,
							id: created.ticket.id,
							status: "in_progress",
							expectedRevision: created.ticket.revision,
						});
						return { created, moved };
					});
					const ticket = await readTicket(board, started.moved.toId);
					const planOnly = agentModeEnabled(pi);
					ctx.ui.notify(
						`Created ${started.created.ticket.id} -> ${ticket.id}; telling the agent to ${planOnly ? "plan it" : "work on it"}${review ? " (review required)" : ""}.`,
						"info",
					);
					pi.sendUserMessage(
						buildWorkMessage(
							ticket,
							started.created.ticket.id,
							review,
							grill,
							planOnly,
							"The /fit start command",
						),
					);
					return;
				}

				if (command === "new" || command === "add") {
					const status = rest[0] ?? "open";
					const priority = Number(rest[1] ?? 0);
					const content = rest.slice(2).join(" ");
					if (!content) {
						throw new FitError(
							"MISSING_CONTENT",
							"Usage: /fit new [status] [priority] <text>",
						);
					}
					const result = await withFileMutationQueue(board, () =>
						createTicket({ board, status, priority, content }),
					);
					ctx.ui.notify(
						`${result.created ? "Created" : "Already existed"}: ${result.ticket.id}`,
						"info",
					);
					return;
				}

				throw new FitError("UNKNOWN_COMMAND", `Unknown /fit command: ${command}`, {
					hint: "Run /fit help to see all sub-commands and arguments.",
				});
			} catch (error) {
				if (error instanceof FitError) {
					const lines = [error.message];
					if (error.hint) lines.push(`Hint: ${error.hint}`);
					if (error.candidates?.length) lines.push(error.candidates.join("\n"));
					ctx.ui.notify(lines.join("\n"), "error");
				} else {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			} finally {
				await refreshInProgressStatus(pi, ctx);
			}
		},
	});

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Toggle FIT agent mode",
		handler: async (ctx) => {
			applyAgentModeAction(pi, ctx, "toggle");
		},
	});
}

function fitHelp(board: string): string {
	return [
		"FIT /fit help",
		`Board: ${board}`,
		"",
		"Commands:",
		"  /fit, /fit list [prefix]             Counts and tickets; prefix filters ids.",
		"",
		"  /fit agent [on|off|status]           Toggle read-only agent mode; only board changes via fit_* are allowed.",
		"",
		"  Ctrl+Shift+A                         Toggle agent mode without typing /fit agent.",
		"",
		"  /fit show [query]                    Show a ticket; no query shows the current one.",
		"",
		"  /fit edit [local] [query]            Open in default editor or VS Code.",
		"      local edits in Pi instead. Aliases: open, code, vscode",
		"",
		"  /fit archive [query]                 Archive a closed ticket after confirmation.",
		"",
		"  /fit close [query]                   Close the current ticket, or match any ticket.",
		"",
		"  /fit move <query> <status>           Move within status/sub-status. Alias: mv",
		"",
		"  /fit priority <query> <0-99>        Change filename priority. Alias: pri",
		"",
		"  /fit work [N] [review] [nogrill] [autocommit]  Work on current ticket, or run N tickets autonomously. Alias: w",
		"      N: fixed queue of in_progress then open tickets; asks to fill from backlog only when empty.",
		"      N>1 rejects review and agent mode. autocommit commits each ticket before closing it.",
		"",
		"  /fit new [status] [priority] <text>  Create a ticket with priority 00-99. Alias: add",
		"",
		"  /fit start [review] [nogrill] <text> Create, start, and hand off to the agent.",
		"",
		"  /fit plan-a-leg [nogrill] [query|text]  Turn on agent mode; split a ticket into 2-7 open tickets plus a final review ticket, then stop.",
		"      No text uses the current ticket. Text matches an existing ticket, or creates a new umbrella when none matches.",
		"",
		"  /fit check [cleanup|migrate|normalize] [args] Validate; cleanup names, report migration, normalize bodies.",
		"",
		"  /fit init [strict] [refresh] [git]   Create board/specs/AGENTS.md; git uses a fit-branch worktree.",
		"",
		"  /fit git                             Record parent commit on closed tickets, commit.",
		"",
		"  /fit help                            This message. Aliases: --help, -h, ?",
		"",
		"Flags: review stops for human review; nogrill skips clarifying questions; autocommit commits each ticket.",
		"Defaults: --fit-review/FIT_REVIEW, --fit-nogrill/FIT_NOGRILL, --fit-agent/FIT_AGENT.",
		"Statuses: open, in_progress, backlog, closed.",
		"Queries are fuzzy for humans; agents use exact-id fit_* tools.",
	].join("\n");
}

function guardEnabled(pi: ExtensionAPI): boolean {
	const env = process.env.FIT_GUARD?.trim().toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	return pi.getFlag("fit-guard") !== false;
}

let agentModeOverride: boolean | undefined;
let agentModeFooterActive = false;

function agentModeEnabled(pi: ExtensionAPI): boolean {
	return (
		agentModeOverride ??
		resolveAgentMode(pi.getFlag("fit-agent"), process.env.FIT_AGENT)
	);
}

function setAgentMode(enabled: boolean): void {
	agentModeOverride = enabled;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sanitizeFooterText(text: string): string {
	return stripAnsi(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function setAgentModeFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const session = ctx.sessionManager;
				const home = process.env.HOME ?? process.env.USERPROFILE;
				let pwd = session.getCwd();
				if (
					home &&
					(pwd === home || pwd.startsWith(`${home}/`) || pwd.startsWith(`${home}\\`))
				) {
					pwd = `~${pwd.slice(home.length)}`;
				}
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = session.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				let input = 0;
				let output = 0;
				let cost = 0;
				for (const entry of session.getEntries()) {
					if (entry.type !== "message" || entry.message.role !== "assistant") {
						continue;
					}
					const usage = (entry.message as {
						usage?: { input?: number; output?: number; cost?: { total?: number } };
					}).usage;
					if (!usage) continue;
					input += usage.input ?? 0;
					output += usage.output ?? 0;
					cost += usage.cost?.total ?? 0;
				}

				const leftParts: string[] = [];
				if (input) leftParts.push(`↑${formatTokenCount(input)}`);
				if (output) leftParts.push(`↓${formatTokenCount(output)}`);
				if (cost) leftParts.push(`$${cost.toFixed(3)}`);
				const contextUsage = ctx.getContextUsage();
				if (contextUsage) {
					const percent =
						contextUsage.percent === null || contextUsage.percent === undefined
							? "?"
							: `${contextUsage.percent.toFixed(1)}%`;
					leftParts.push(`${percent}/${formatTokenCount(contextUsage.contextWindow)}`);
				}
				const left = leftParts.join(" ");
				const model = ctx.model?.id ?? "no-model";
				const thinking =
					ctx.model?.reasoning && ctx.thinkingLevel
						? ` • ${ctx.thinkingLevel}`
						: "";
				const right = `${model}${thinking}`;
				const padding = " ".repeat(
					Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
				);
				const lines = [pwd, `${left}${padding}${right}`];

				const statuses = Array.from(footerData.getExtensionStatuses().values())
					.map(sanitizeFooterText)
					.filter(Boolean);
				if (statuses.length > 0) lines.push(statuses.join(" "));

				return lines.map((line) =>
					truncateToWidth(theme.fg("warning", stripAnsi(line)), width),
				);
			},
		};
	});
	agentModeFooterActive = true;
}

function applyAgentModeUi(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (agentModeEnabled(pi)) {
		ctx.ui.setStatus("fit-agent", "agent: FIT-only mode (ctrl+shift+a)");
		if (ctx.mode === "tui") setAgentModeFooter(ctx);
		return;
	}

	ctx.ui.setStatus("fit-agent", undefined);
	if (agentModeFooterActive) {
		ctx.ui.setFooter(undefined);
		agentModeFooterActive = false;
	}
}

const IN_PROGRESS_STATUS_KEY = "fit-in-progress";
let inProgressStatusGeneration = 0;

/**
 * Re-read the cwd board and update the footer indicator. The generation guard
 * keeps overlapping refreshes from applying an older read last.
 */
async function refreshInProgressStatus(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const generation = ++inProgressStatusGeneration;
	const board = resolveBoard(configuredBoard(pi), ctx.cwd);
	let text: string | undefined;
	try {
		const { mode, tickets } = await readBoard(board);
		text = formatInProgressStatus(mode, tickets);
	} catch {
		text = undefined;
	}
	if (generation !== inProgressStatusGeneration) return;
	ctx.ui.setStatus(
		IN_PROGRESS_STATUS_KEY,
		text ? ctx.ui.theme.fg("dim", text) : undefined,
	);
}

function applyAgentModeAction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	action: AgentModeAction,
): boolean {
	const previous = agentModeEnabled(pi);
	const enabled = nextAgentMode(previous, action);
	if (action !== "status") setAgentMode(enabled);
	applyAgentModeUi(pi, ctx);
	const board = resolveBoard(configuredBoard(pi), ctx.cwd);
	ctx.ui.notify(
		enabled
			? `Agent mode is on. Mutations are limited to the FIT board through fit_* tools; shell commands must be read-only.\nBoard: ${board}`
			: "Agent mode is off. Normal tool access restored.",
		enabled ? "warning" : "info",
	);
	const reminder = lateAgentModeReminder(previous, enabled, action);
	if (reminder) pi.sendUserMessage(reminder);
	return enabled;
}

type NotifyLevel = "info" | "warning" | "error";

interface SelectContext {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[]): Promise<string | undefined>;
		notify(message: string, level: NotifyLevel): void;
	};
}

function inProgressTickets(tickets: TicketSummary[]): TicketSummary[] {
	return tickets.filter((ticket) => ticket.status === "in_progress");
}

/**
 * Choose from an already-selected candidate list. A single candidate is
 * returned directly; ambiguity is shown as a picker instead of guessed.
 */
async function selectTicket(
	ctx: SelectContext,
	tickets: TicketSummary[],
	title: string,
	multipleMessage = "Multiple tickets",
): Promise<TicketSummary | undefined> {
	if (tickets.length === 0) return undefined;
	if (tickets.length === 1) return tickets[0];
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`${multipleMessage}:\n${tickets.map((ticket) => ticket.id).join("\n")}`,
			"warning",
		);
		return undefined;
	}
	const byLabel = new Map(tickets.map((ticket) => [ticketLabel(ticket), ticket]));
	const choice = await ctx.ui.select(title, [...byLabel.keys()]);
	return choice ? byLabel.get(choice) : undefined;
}

/**
 * Fuzzy lookup for the human command only. Agents never reach this function.
 * Ties are resolved by deterministic ordering, and ambiguity is presented to the
 * user as a picker rather than silently choosing.
 */
async function pickTicket(
	ctx: SelectContext,
	tickets: TicketSummary[],
	query: string,
): Promise<TicketSummary | undefined> {
	const matches = fuzzyFind(tickets, query);
	if (matches.length === 0) {
		ctx.ui.notify(`No ticket matches "${query}".`, "warning");
		return undefined;
	}
	return selectTicket(ctx, matches, "Select a ticket:", "Multiple matches");
}
