#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	FIT_STATUS_ORDER,
	FitError,
	archiveTicket,
	checkBoard,
	cleanupTicketNames,
	countTickets,
	createTicket,
	initBoard,
	listTickets,
	migrationReport,
	moveTicket,
	nextTicketToPromote,
	normalizeLegacyBodies,
	readBoardMode,
	readTicket,
	recordClosedTicketsCommit,
	resolveBoard,
	resolveTicketPath,
	restoreArchivedTicket,
	suggestTicketFilename,
	updateTicket,
	type BoardCheckResult,
	type BoardMode,
	type FrontmatterValue,
	type Ticket,
	type TicketSummary,
} from "./fit.ts";
import {
	type CliValues,
	UsageError,
	parseCliArgs,
	parseListLimit,
	parseNameMaxLength,
	parseNewPositionals,
	parsePriority,
	parseSetAssignments,
	rejectExtraPositionals,
	requirePositionals,
} from "./cli-args.ts";

interface CliOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface CommandResult {
	text: string;
	json: Record<string, unknown>;
	exitCode?: number;
}

const HELP = `pi-fit - work with a FIT board without Pi

Usage:
  pi-fit [--board <path>] <command> [arguments] [options]
  pi-fit <command> --help

Global options:
  -b, --board <path>       Board directory (default: FIT_BOARD or ./fit)
      --json               Machine-readable envelope on stdout
  -h, --help               Show this help
  -v, --version            Show the package version

Commands:
  list                     List tickets
      [--status <status>] [--prefix <text>] [--limit N] [--all]
  show [id]                Show a ticket; no id uses the current in-progress ticket
  new|add [status] [priority] <text>
                           Create a ticket; defaults to open 0
      [--slug <name>] [--title <text>] [--project <name>]
      [--body <text>|--body-file <path|->] [--set key=value ...]
  update <id>              Update a ticket
      [--body <text>|--body-file <path|->]
      [--append <text>|--append-file <path|->]
      [--set key=value ...] [--unset key ...]
      [--priority N] [--slug <name>] [--expected-revision <rev>]
  move|mv <id> <status>    Move a ticket
      [--priority N] [--slug <name>] [--expected-revision <rev>]
  close [id]               Move a ticket to closed; no id uses the current in-progress ticket
  priority <id> <0-99>     Change a ticket's filename priority
  archive <id>             Archive a closed ticket
      [--expected-revision <rev>]
  restore <record>         Restore an archive record
      [--status <status>]
  check                    Validate the board
  check cleanup [max]      Truncate long ticket names [--dry-run]
  check migrate            Report Strict migration actions
  check normalize          Normalize legacy bodies [--dry-run]
  init                     Create/update the board scaffold
      [--strict] [--refresh] [--git]
  git                      Record parent commits on closed tickets and commit the board
  mode                     Print board mode/version
  next                     Print the next open ticket, falling back to backlog
  path <id>                Print a ticket's absolute path
  name [status] [priority] <text>
                           Print the free filename "new" would use
  help                     Show this help
  version                  Show the package version

Lookup accepts an exact board-relative id, a bare filename, or a unique short
name. Ambiguous names fail with candidates; there is no fuzzy matching.

Exit codes: 0 success, 1 FIT/operational error, 2 usage error.
Errors are written to stderr, including JSON error envelopes.`;

async function packageVersion(): Promise<string> {
	try {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof packageJson.version === "string" ? packageJson.version : "unknown";
	} catch {
		return "unknown";
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readBodyFile(path: string): Promise<string> {
	return path === "-" ? readStdin() : readFile(resolve(path), "utf8");
}

async function bodySource(
	values: CliValues,
	append: boolean,
): Promise<string | undefined> {
	const inline = append ? values.append : values.body;
	const file = append ? values["append-file"] : values["body-file"];
	const flag = append ? "--append" : "--body";
	const fileFlag = append ? "--append-file" : "--body-file";
	if (inline !== undefined && file !== undefined) {
		throw new UsageError(`${flag} and ${fileFlag} cannot be combined.`);
	}
	if (file !== undefined) return readBodyFile(file);
	return inline;
}

function formatCounts(counts: Record<string, number>): string {
	const keys = [
		...FIT_STATUS_ORDER,
		...Object.keys(counts).filter(
			(key) => !(FIT_STATUS_ORDER as readonly string[]).includes(key),
		),
	];
	return keys
		.filter((key) => counts[key] !== undefined)
		.map((key) => `${key} ${counts[key] ?? 0}`)
		.join(" · ");
}

function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

function formatTicket(ticket: Ticket): string {
	return [
		ticket.id,
		`revision: ${ticket.revision}`,
		`status: ${ticket.status}${ticket.subdir ? ` (subdir: ${ticket.subdir})` : ""}`,
		`name: ${ticket.shortName}`,
		`displayName: ${ticket.displayName}`,
		`project: ${ticket.project ?? "none"}`,
		`priority: ${ticket.priority ?? "none"}`,
		`title: ${ticket.title || "(empty)"}`,
		"",
		"frontmatter:",
		ticket.frontmatterRaw?.trim() ? ticket.frontmatterRaw.trimEnd() : "(none)",
		"",
		"body:",
		ticket.body.trim() ? ticket.body.trimEnd() : "(empty)",
	].join("\n");
}

function formatList(
	board: string,
	mode: BoardMode,
	all: TicketSummary[],
	listed: TicketSummary[],
	counts: Record<string, number>,
	filters: string[],
	limit: number | undefined,
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
	if (filters.length > 0) lines.push(`Filter: ${filters.join(" ")}`);
	if (listed.length === 0) {
		lines.push("", all.length === 0 ? "No tickets yet." : "No tickets match this view.");
		return lines.join("\n");
	}

	const groups = new Map<string, TicketSummary[]>();
	for (const ticket of listed) {
		const group = groups.get(ticket.status);
		if (group) group.push(ticket);
		else groups.set(ticket.status, [ticket]);
	}
	const idWidth = Math.min(
		64,
		Math.max(...listed.map((ticket) => ticket.id.length)),
	);
	for (const [status, tickets] of groups) {
		lines.push(
			"",
			`${status}/  ${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}`,
			"─".repeat(status.length + 4),
		);
		for (const ticket of tickets) {
			const title = oneLine(ticket.title || ticket.displayName || "(no body)");
			const project = ticket.project ? `  [${ticket.project}]` : "";
			lines.push(`  ${ticket.id.padEnd(idWidth)}  ${title}${project}`);
		}
	}
	if (listed.length < all.length) {
		const hint = limit && listed.length >= limit ? `, limit ${limit}` : "";
		lines.push("", `[Showing ${listed.length} of ${all.length} tickets${hint}; use --all for more.]`);
	}
	return lines.join("\n");
}

function formatCheck(result: BoardCheckResult): string {
	const errors = result.issues.filter((issue) => issue.severity === "error").length;
	const warnings = result.issues.length - errors;
	const lines = [
		`FIT board: ${result.board}`,
		`Mode: ${result.mode.mode}${result.mode.version ? ` ${result.mode.version}` : ""}`,
		`Tickets: ${result.total} (${formatCounts(result.counts)})`,
		`Issues: ${errors} error(s), ${warnings} warning(s)`,
	];
	for (const issue of result.issues) {
		const id = issue.id ? ` ${issue.id}` : "";
		lines.push(`${issue.severity} ${issue.code}${id}: ${issue.message}`);
	}
	if (result.issues.length === 0) lines.push("Board is clean.");
	return lines.join("\n");
}

function formatInit(result: Awaited<ReturnType<typeof initBoard>>): string {
	const lines = [`FIT board: ${result.board}`];
	if (result.created.length) lines.push(`created: ${result.created.join(", ")}`);
	if (result.existing.length) lines.push(`already existed: ${result.existing.join(", ")}`);
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
			? `mode: strict${result.strictCreated ? " (marker created)" : ""}`
			: "mode: basic",
	);
	lines.push(
		result.agentsCreated
			? `agents: created ${result.agentsPath}`
			: result.agentsUpdated
				? `agents: updated ${result.agentsPath}`
				: `agents: already present at ${result.agentsPath}`,
	);
	if (result.gitRequested) {
		lines.push(
			`git: ${result.gitBranchCreated ? "created" : "using"} branch ${result.gitBranch}`,
			result.gitWorktreeCreated
				? `git: checked out ${result.gitBranch} at ${result.board}`
				: `git: worktree already on ${result.gitBranch} at ${result.board}`,
		);
		if (result.gitMergedTickets.length > 0) {
			lines.push(`git: merged ${result.gitMergedTickets.length} local ticket(s)`);
		}
		if (result.gitKeptBranchTickets.length > 0) {
			lines.push(`git: kept ${result.gitKeptBranchTickets.length} branch ticket(s)`);
		}
		if (result.gitBackupPath) lines.push(`git: local backup at ${result.gitBackupPath}`);
	}
	return lines.join("\n");
}

function formatCleanup(
	result: Awaited<ReturnType<typeof cleanupTicketNames>>,
): string {
	const lines = [
		`${result.dryRun ? "Would rename" : "Renamed"} ${result.renamed.length} ticket(s); ${result.skipped} already within ${result.maxLength} characters.`,
	];
	for (const rename of result.renamed) {
		lines.push(`${result.dryRun ? "~" : "+"} ${rename.fromId} -> ${rename.toId}`);
	}
	return lines.join("\n");
}

function formatMigration(
	result: Awaited<ReturnType<typeof migrationReport>>,
): string {
	const lines = [
		`FIT board: ${result.board}`,
		`Mode: ${result.mode.mode}${result.mode.version ? ` ${result.mode.version}` : ""}`,
		`Tickets: ${result.total}`,
		`Migration actions: ${result.actions.length}`,
	];
	for (const action of result.actions) {
		lines.push(`${action.kind} ${action.id}: ${action.message}`);
	}
	return lines.join("\n");
}

function formatNormalize(
	result: Awaited<ReturnType<typeof normalizeLegacyBodies>>,
): string {
	const lines = [
		`${result.dryRun ? "Would normalize" : "Normalized"} ${result.changed.length} ticket(s).`,
	];
	for (const change of result.changed) lines.push(`+ ${change.id}`);
	return lines.join("\n");
}

function formatGit(
	result: Awaited<ReturnType<typeof recordClosedTicketsCommit>>,
): string {
	const lines = [
		`Parent commit: ${result.commitHash || "(none)"}`,
		`Recorded: ${result.recorded.length}`,
		`Skipped: ${result.skipped}`,
		`Committed: ${result.committed ? result.commitMessage : "no"}`,
	];
	if (result.inline) lines.push("Board is inline with the parent worktree; close moves belong to the work commit.");
	return lines.join("\n");
}

async function currentInProgress(board: string): Promise<TicketSummary> {
	const inProgress = (await listTickets(board)).filter(
		(ticket) => ticket.status === "in_progress",
	);
	if (inProgress.length === 0) {
		throw new FitError("NO_IN_PROGRESS", "No ticket is in in_progress.", {
			hint: "Pass an explicit ticket id, or move a ticket to in_progress first.",
		});
	}
	if (inProgress.length > 1) {
		throw new FitError(
			"MULTIPLE_IN_PROGRESS",
			`in_progress has ${inProgress.length} tickets, not exactly one.`,
			{ candidates: inProgress.map((ticket) => ticket.id) },
		);
	}
	return inProgress[0];
}

function setFields(values: CliValues): Record<string, FrontmatterValue> | undefined {
	return parseSetAssignments(values.set);
}

async function runCommand(
	command: string,
	args: string[],
	values: CliValues,
	board: string,
): Promise<CommandResult> {
	switch (command) {
		case "list": {
			rejectExtraPositionals(args, "pi-fit list [--status <status>] [--prefix <text>] [--limit N] [--all]");
			const mode = await readBoardMode(board);
			const all = await listTickets(board, mode);
			const { counts } = countTickets(all);
			const status = values.status?.trim();
			const prefix = values.prefix?.trim();
			const filtered = all.filter(
				(ticket) =>
					(!status ||
						ticket.status === status ||
						ticket.id.startsWith(`${status.replace(/\/+$/, "")}/`)) &&
					(!prefix || ticket.id.startsWith(prefix)),
			);
			const limit = parseListLimit(values.limit, values.all === true);
			const textLimit = limit ?? (values.all ? undefined : 100);
			const textTickets = textLimit ? filtered.slice(0, textLimit) : filtered;
			const jsonTickets = limit ? filtered.slice(0, limit) : filtered;
			const filters = [
				status ? `status=${status}` : "",
				prefix ? `prefix=${prefix}` : "",
			].filter(Boolean);
			return {
				text: formatList(board, mode, all, textTickets, counts, filters, textLimit),
				json: {
					mode,
					total: all.length,
					counts,
					matched: filtered.length,
					tickets: jsonTickets,
				},
			};
		}

		case "show": {
			if (args.length > 1) throw new UsageError("Too many arguments.", "Usage: pi-fit show [id]");
			const id = args[0] ?? (await currentInProgress(board)).id;
			const ticket = await readTicket(board, id);
			return { text: formatTicket(ticket), json: { ticket } };
		}

		case "new":
		case "add": {
			const body = await bodySource(values, false);
			const parsed = parseNewPositionals(args);
			if (body !== undefined && parsed.text) {
				throw new UsageError(
					"Pass ticket text either positionally or with --body/--body-file, not both.",
				);
			}
			const content = body ?? parsed.text;
			const result = await createTicket({
				board,
				content,
				status: parsed.status,
				priority: parsed.priority,
				slug: values.slug,
				title: values.title,
				project: values.project,
				frontmatter: setFields(values),
			});
			const lines = [
				`${result.created ? "Created" : "Already existed"}: ${result.ticket.id}`,
			];
			for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
			return {
				text: lines.join("\n"),
				json: {
					ticket: result.ticket,
					created: result.created,
					warnings: result.warnings,
					mode: result.mode,
				},
			};
		}

		case "update": {
			const [id] = requirePositionals(args, ["id"], "pi-fit update <id> [options]");
			rejectExtraPositionals(
				args.slice(1),
				"pi-fit update <id> [--body|--body-file|--append|--append-file] [options]",
			);
			const replacement = await bodySource(values, false);
			const appended = await bodySource(values, true);
			if (replacement !== undefined && appended !== undefined) {
				throw new UsageError("Replacement body and append body cannot be combined.");
			}
			if (
				replacement === undefined &&
				appended === undefined &&
				!values.set?.length &&
				!values.unset?.length &&
				values.priority === undefined &&
				values.slug === undefined
			) {
				throw new UsageError("Nothing to update.", "Pass at least one update option.");
			}
			const result = await updateTicket({
				board,
				id,
				body: appended ?? replacement,
				bodyMode: appended !== undefined ? "append" : undefined,
				set: setFields(values),
				unset: values.unset,
				priority: values.priority === undefined
					? undefined
					: parsePriority(values.priority),
				slug: values.slug,
				expectedRevision: values["expected-revision"],
			});
			const lines = [
				`${result.changed ? "Updated" : "Unchanged"}: ${result.ticket.id}`,
			];
			if (result.previousId !== result.ticket.id) {
				lines.push(`Renamed: ${result.previousId} -> ${result.ticket.id}`);
			}
			for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
			return {
				text: lines.join("\n"),
				json: {
					ticket: result.ticket,
					previousId: result.previousId,
					changed: result.changed,
					warnings: result.warnings,
					mode: result.mode,
				},
			};
		}

		case "move":
		case "mv": {
			const [id, status] = requirePositionals(
				args,
				["id", "status"],
				"pi-fit move <id> <status> [options]",
			);
			rejectExtraPositionals(args.slice(2), "pi-fit move <id> <status> [options]");
			const result = await moveTicket({
				board,
				id,
				status,
				priority: values.priority === undefined
					? undefined
					: parsePriority(values.priority),
				slug: values.slug,
				expectedRevision: values["expected-revision"],
			});
			return {
				text: result.changed
					? `Moved ${result.fromId} -> ${result.toId}${result.committed ? " (board committed)" : ""}`
					: `Already in ${result.toId}`,
				json: {
					ticket: result.ticket,
					fromId: result.fromId,
					toId: result.toId,
					changed: result.changed,
					committed: result.committed,
					mode: result.mode,
				},
			};
		}

		case "close": {
			if (args.length > 1) throw new UsageError("Too many arguments.", "Usage: pi-fit close [id]");
			const id = args[0] ?? (await currentInProgress(board)).id;
			const result = await moveTicket({
				board,
				id,
				status: "closed",
				expectedRevision: values["expected-revision"],
			});
			return {
				text: result.changed
					? `Closed ${result.fromId} -> ${result.toId}${result.committed ? " (board committed)" : ""}`
					: `Already closed: ${result.toId}`,
				json: {
					ticket: result.ticket,
					fromId: result.fromId,
					toId: result.toId,
					changed: result.changed,
					committed: result.committed,
					mode: result.mode,
				},
			};
		}

		case "priority": {
			const [id, token] = requirePositionals(
				args,
				["id", "priority"],
				"pi-fit priority <id> <0-99>",
			);
			rejectExtraPositionals(args.slice(2), "pi-fit priority <id> <0-99>");
			const result = await updateTicket({
				board,
				id,
				priority: parsePriority(token),
				expectedRevision: values["expected-revision"],
			});
			return {
				text: result.changed
					? `Renamed ${result.previousId} -> ${result.ticket.id}`
					: `Unchanged: ${result.ticket.id}`,
				json: {
					ticket: result.ticket,
					previousId: result.previousId,
					changed: result.changed,
					mode: result.mode,
				},
			};
		}

		case "archive": {
			const [id] = requirePositionals(args, ["id"], "pi-fit archive <id>");
			rejectExtraPositionals(args.slice(1), "pi-fit archive <id>");
			const result = await archiveTicket({
				board,
				id,
				expectedRevision: values["expected-revision"],
			});
			return {
				text: `Archived ${result.archivedId} -> ${result.recordPath}`,
				json: { ...result },
			};
		}

		case "restore": {
			const [id] = requirePositionals(args, ["record"], "pi-fit restore <record> [--status <status>]");
			rejectExtraPositionals(args.slice(1), "pi-fit restore <record> [--status <status>]");
			const result = await restoreArchivedTicket({
				board,
				id,
				status: values.status,
			});
			return {
				text: `Restored ${result.fromRecord} -> ${result.ticket.id} (${result.remainingRecords} record(s) left)`,
				json: { ...result },
			};
		}

		case "check": {
			const subcommand = args[0];
			if (subcommand === "cleanup") {
				rejectExtraPositionals(
					args.slice(2),
					"pi-fit check cleanup [max] [--dry-run]",
				);
				const result = await cleanupTicketNames(board, {
					maxLength: parseNameMaxLength(args[1]),
					dryRun: values["dry-run"] === true,
				});
				return { text: formatCleanup(result), json: { ...result } };
			}
			if (subcommand === "migrate") {
				rejectExtraPositionals(args.slice(1), "pi-fit check migrate");
				const result = await migrationReport(board);
				return { text: formatMigration(result), json: { ...result } };
			}
			if (subcommand === "normalize") {
				rejectExtraPositionals(args.slice(1), "pi-fit check normalize [--dry-run]");
				const result = await normalizeLegacyBodies(board, {
					dryRun: values["dry-run"] === true,
				});
				return { text: formatNormalize(result), json: { ...result } };
			}
			if (subcommand !== undefined) {
				throw new UsageError(
					`Unknown check subcommand: ${subcommand}`,
					"Usage: pi-fit check [cleanup [max]|migrate|normalize]",
				);
			}
			const result = await checkBoard(board);
			return {
				text: formatCheck(result),
				json: { ...result },
				exitCode: result.issues.some((issue) => issue.severity === "error") ? 1 : 0,
			};
		}

		case "init": {
			rejectExtraPositionals(args, "pi-fit init [--strict] [--refresh] [--git]");
			const result = await initBoard(board, {
				strict: values.strict === true,
				refreshSpec: values.refresh === true,
				git: values.git === true,
			});
			return { text: formatInit(result), json: { ...result } };
		}

		case "git": {
			rejectExtraPositionals(args, "pi-fit git");
			const result = await recordClosedTicketsCommit(board);
			return { text: formatGit(result), json: { ...result } };
		}

		case "mode": {
			rejectExtraPositionals(args, "pi-fit mode");
			const mode = await readBoardMode(board);
			return {
				text: `Mode: ${mode.mode}${mode.version ? ` ${mode.version}` : ""}`,
				json: { mode: mode.mode, version: mode.version, strict: mode.strict },
			};
		}

		case "next": {
			rejectExtraPositionals(args, "pi-fit next");
			const ticket = nextTicketToPromote(await listTickets(board));
			return {
				text: ticket ? ticket.id : "No open or backlog ticket.",
				json: { ticket: ticket ?? null },
			};
		}

		case "path": {
			const [id] = requirePositionals(args, ["id"], "pi-fit path <id>");
			rejectExtraPositionals(args.slice(1), "pi-fit path <id>");
			const resolved = await resolveTicketPath(board, id);
			return {
				text: resolved.path,
				json: { id: resolved.id, path: resolved.path },
			};
		}

		case "name": {
			const body = await bodySource(values, false);
			const parsed = parseNewPositionals(args);
			if (body !== undefined && parsed.text) {
				throw new UsageError(
					"Pass ticket text either positionally or with --body/--body-file, not both.",
				);
			}
			const filename = await suggestTicketFilename({
				board,
				content: body ?? parsed.text,
				status: parsed.status,
				priority: parsed.priority,
				slug: values.slug,
				title: values.title,
				project: values.project,
				frontmatter: setFields(values),
			});
			return { text: filename, json: { filename } };
		}

		default:
			throw new UsageError(
				`Unknown command: ${command}`,
				"Run pi-fit --help for usage.",
			);
	}
}

function failureOutcome(
	command: string | undefined,
	board: string,
	error: unknown,
	json: boolean,
): CliOutcome {
	const usage = error instanceof UsageError;
	const fit = error instanceof FitError ? error : undefined;
	const code = usage ? "USAGE" : fit?.code ?? "INTERNAL";
	const message = error instanceof Error ? error.message : String(error);
	const hint = usage ? error.hint : fit?.hint;
	const candidates = fit?.candidates;
	if (json) {
		const envelope: Record<string, unknown> = {
			ok: false,
			command,
			board,
			error: message,
			code,
		};
		if (hint) envelope.hint = hint;
		if (candidates?.length) envelope.candidates = candidates;
		return { stdout: "", stderr: `${JSON.stringify(envelope, null, 2)}\n`, exitCode: usage ? 2 : 1 };
	}
	const lines = [`${code}: ${message}`];
	if (hint) lines.push(`Hint: ${hint}`);
	if (candidates?.length) lines.push(...candidates.map((candidate) => `- ${candidate}`));
	return { stdout: "", stderr: `${lines.join("\n")}\n`, exitCode: usage ? 2 : 1 };
}

async function execute(argv: string[], cwd: string): Promise<CliOutcome> {
	const wantsJson = argv.includes("--json");
	let parsed: ReturnType<typeof parseCliArgs>;
	try {
		parsed = parseCliArgs(argv);
	} catch (error) {
		return failureOutcome(undefined, resolveBoard(undefined, cwd), error, wantsJson);
	}

	const { values, positionals } = parsed;
	const command = positionals[0] ?? "list";
	const args = positionals.slice(1);
	const board = resolveBoard(values.board, cwd);

	if (values.help || command === "help" || command === "--help") {
		return { stdout: `${HELP}\n`, stderr: "", exitCode: 0 };
	}
	if (values.version || command === "version" || command === "--version") {
		return {
			stdout: `${await packageVersion()}\n`,
			stderr: "",
			exitCode: 0,
		};
	}

	try {
		const result = await runCommand(command, args, values, board);
		if (values.json) {
			const envelope = {
				ok: true,
				command,
				board,
				...result.json,
			};
			return {
				stdout: `${JSON.stringify(envelope, null, 2)}\n`,
				stderr: "",
				exitCode: result.exitCode ?? 0,
			};
		}
		return {
			stdout: result.text ? `${result.text.replace(/\n$/, "")}\n` : "",
			stderr: "",
			exitCode: result.exitCode ?? 0,
		};
	} catch (error) {
		return failureOutcome(command, board, error, values.json === true);
	}
}

async function main(): Promise<void> {
	const outcome = await execute(process.argv.slice(2), process.cwd());
	if (outcome.stdout) process.stdout.write(outcome.stdout);
	if (outcome.stderr) process.stderr.write(outcome.stderr);
	process.exitCode = outcome.exitCode;
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
