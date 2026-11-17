/**
 * Deterministic FIT board operations.
 *
 * This module deliberately depends only on Node built-ins so it can be unit
 * tested without loading the Pi runtime. The Pi-facing tools live in index.ts.
 *
 * FIT spec: https://github.com/HeadEmptyNoNotes/FIT/blob/main/FIT_SPEC.md
 *
 * Determinism here means an agent cannot corrupt or surprise the board:
 * - A ticket id is its exact board-relative path, e.g. "open/03-fix-typo.md".
 *   Agent-facing lookup never guesses. A bare filename is accepted only when it
 *   identifies exactly one ticket; otherwise the error lists all candidates.
 *   Fuzzy matching is deliberately confined to the human `/fit` command.
 * - Files are ordered by status, then by board-relative path (code-unit order).
 * - Writes are atomic and never overwrite a ticket. Name collisions fail with
 *   NAME_TAKEN and a suggested free name; identical creates stay idempotent.
 * - Mutations accept an optional revision (content hash) and fail on stale data.
 * - Ticket paths must live under a canonical status directory; symlink escapes
 *   and root-level Markdown files are rejected.
 * - There is no delete operation.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
	access,
	copyFile,
	lstat,
	link,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { AGENT_SPEC } from "./agent-spec.ts";
import { mergeAgentsContent } from "./agents.ts";
import {
	GitMergeConflictError,
	type GitConflictResolver,
	commitWorktreePath,
	ensureBoardBranchWorktree,
	inspectBoardGit,
	latestCommitHash,
	mergeGitignoreContent,
} from "./git.ts";
import { FIT_SPEC, FIT_SPEC_LEGACY, FIT_SPEC_VERSION } from "./spec.ts";

/** Canonical status directories. Note the spec's underscore in in_progress. */
export const FIT_STATUSES = ["open", "in_progress", "backlog", "closed"] as const;
export type FitStatus = (typeof FIT_STATUSES)[number];

/** Board display order. The FIT CLI lists in_progress first. */
export const FIT_STATUS_ORDER = ["in_progress", "open", "backlog", "closed"] as const;

const STATUS_RANK: Record<string, number> = Object.fromEntries(
	FIT_STATUS_ORDER.map((status, index) => [status, index]),
);

const STATUS_ALIASES: Record<string, string> = {
	"in-progress": "in_progress",
	inprogress: "in_progress",
};

const MAX_SLUG_CHARS = 30;
const MAX_NAME_WORDS = 7;
export const MAX_PRIORITY = 99;

/** Default maximum length for a ticket filename stem, excluding ".md". */
export const DEFAULT_MAX_TICKET_NAME_CHARS = 30;
const MIN_TICKET_NAME_CHARS = 8;
const MAX_TICKET_NAME_CHARS = 255;

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export interface TicketSummary {
	/** Board-relative path with forward slashes, including ".md". */
	id: string;
	/** Absolute path on disk. */
	path: string;
	/** Top-level status directory, e.g. "open". */
	status: string;
	/** Project/sub-status directories between the status and the file. */
	subdir: string;
	/** File name including ".md". */
	filename: string;
	/** File name without ".md". */
	name: string;
	/** Identity: the name part after a two-digit priority prefix, e.g. "fix-typo". */
	shortName: string;
	/** Human display name: the short name in title case with hyphens replaced by spaces. */
	displayName: string;
	/** Frontmatter project name, or null when absent/non-scalar. */
	project: string | null;
	/** Leading "NN-" priority, or null when the name has no two-digit prefix. */
	priority: number | null;
	/** First non-empty body line, with any Markdown heading marker removed. */
	title: string;
	/** Number of body characters, excluding frontmatter. */
	bodyChars: number;
}

export interface Ticket extends TicketSummary {
	content: string;
	/** Short content hash for optimistic concurrency. */
	revision: string;
	/** Raw YAML between the --- delimiters, or null when absent. */
	frontmatterRaw: string | null;
	frontmatter: Record<string, FrontmatterValue>;
	body: string;
}

export interface CreateTicketInput {
	board: string;
	/** Body text. May be empty when a slug or title is supplied. */
	content: string;
	priority?: number;
	slug?: string;
	title?: string;
	/** Defaults to "open". Must start with "open" or "backlog". */
	status?: string;
	/** Convenience frontmatter field; equivalent to frontmatter.project. */
	project?: string;
	frontmatter?: Record<string, FrontmatterValue>;
}

export interface UpdateTicketInput {
	board: string;
	id: string;
	body?: string;
	bodyMode?: "replace" | "append";
	set?: Record<string, FrontmatterValue>;
	unset?: string[];
	/** Convenience frontmatter field; equivalent to set.project. */
	project?: string;
	priority?: number;
	slug?: string;
	/** Fail if the ticket changed since this revision was read. */
	expectedRevision?: string;
}

export interface MoveTicketInput {
	board: string;
	id: string;
	status: string;
	priority?: number;
	slug?: string;
	/** Fail if the ticket changed since this revision was read. */
	expectedRevision?: string;
}

export interface CleanupTicketNamesOptions {
	/** Maximum filename stem length excluding ".md". Defaults to 30. */
	maxLength?: number;
	/** Report what would be renamed without touching the board. */
	dryRun?: boolean;
}

export interface CleanupTicketRename {
	fromId: string;
	toId: string;
}

export interface CleanupTicketNamesResult {
	renamed: CleanupTicketRename[];
	skipped: number;
	maxLength: number;
	dryRun: boolean;
}

export interface RecordClosedTicketsCommitResult {
	/** HEAD of the parent repository when the hashes were recorded. */
	commitHash: string;
	recorded: string[];
	skipped: number;
	commitMessage: string;
	committed: boolean;
	/** True when the board shares the parent worktree, so the close is inline. */
	inline: boolean;
}

export interface CreateTicketResult {
	ticket: Ticket;
	warnings: string[];
	created: boolean;
	mode: BoardMode;
}

export interface CreateTicketsInput {
	board: string;
	/** Ticket-like objects to create. Each item is the same shape as fit_new. */
	tickets: Array<Omit<CreateTicketInput, "board">>;
}

export interface CreateTicketsResult {
	tickets: CreateTicketResult[];
	warnings: string[];
	mode: BoardMode;
}

export interface UpdateTicketResult {
	ticket: Ticket;
	previousId: string;
	warnings: string[];
	changed: boolean;
	mode: BoardMode;
}

export class FitError extends Error {
	code: string;
	hint?: string;
	candidates?: string[];

	constructor(
		code: string,
		message: string,
		options?: { hint?: string; candidates?: string[] },
	) {
		super(message);
		this.name = "FitError";
		this.code = code;
		this.hint = options?.hint;
		this.candidates = options?.candidates;
	}
}

// ---------------------------------------------------------------------------
// Board paths
// ---------------------------------------------------------------------------

/** Resolve a board argument to an absolute path. Relative paths use `cwd`. */
export function resolveBoard(input: string | undefined, cwd: string): string {
	let value = (input ?? "fit").trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "") value = "fit";
	if (value === "~") value = homedir();
	else if (value.startsWith("~/") || value.startsWith("~\\")) {
		value = join(homedir(), value.slice(2));
	}
	return resolve(isAbsolute(value) ? value : resolve(cwd, value));
}

export interface BoardMode {
	mode: "basic" | "strict";
	/** Quoted version string from the STRICT marker, or null when absent/malformed. */
	version: string | null;
	/** Raw STRICT contents, or null when the board is Basic. */
	strict: string | null;
}

/**
 * Detect whether a board is Basic or Strict. A STRICT file at the board root
 * opts in to Strict mode; its contents are a quoted spec version (e.g. `"0.5"`).
 * Malformed contents still opt in, with `version` left null so checks can warn.
 */
export async function readBoardMode(board: string): Promise<BoardMode> {
	const strict = await readOptionalFile(join(board, "STRICT"));
	if (strict === null) return { mode: "basic", version: null, strict: null };
	const match = /^"([^"\r\n]+)"\r?\n?$/.exec(strict);
	return { mode: "strict", version: match ? match[1] : null, strict };
}

/** Read a board's mode and tickets in one pass. */
export async function readBoard(
	board: string,
): Promise<{ mode: BoardMode; tickets: TicketSummary[] }> {
	const mode = await readBoardMode(board);
	return { mode, tickets: await listTickets(board, mode) };
}

function normalizeIdPath(id: string): string {
	const value = id.trim().replace(/\\/g, "/");
	if (!value) throw new FitError("INVALID_ID", "Ticket id must not be empty.");
	if (value.includes("\0")) {
		throw new FitError("INVALID_ID", "Ticket id contains a NUL byte.");
	}
	return value;
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertTicketFileName(name: string): void {
	if (!name.toLowerCase().endsWith(".md")) {
		throw new FitError(
			"NOT_A_TICKET",
			`Not a Markdown ticket file: ${name}`,
			{ hint: "FIT tickets are .md files inside an open, in_progress, backlog, or closed directory." },
		);
	}
}

function assertTicketIdShape(id: string, allowExtra = false): void {
	const parts = id.split("/");
	if (parts.length < 2) {
		throw new FitError(
			"NOT_A_TICKET",
			`Not a FIT ticket: ${id}`,
			{ hint: "Tickets live inside one of the status directories: open, in_progress, backlog, closed." },
		);
	}
	const status = parts[0];
	if (!(FIT_STATUSES as readonly string[]).includes(status) && !allowExtra) {
		throw new FitError(
			"NOT_A_TICKET",
			`Not inside a canonical FIT status directory: ${id}`,
			{ hint: `Expected one of: ${FIT_STATUSES.join(", ")}.` },
		);
	}
	if (parts.some((part) => part === "." || part === ".." || part === "")) {
		throw new FitError("INVALID_ID", `Invalid ticket id: ${id}`);
	}
}

/** Short content hash used for optimistic concurrency checks. */
export function revisionOf(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function assertWritableInsideBoard(board: string, targetPath: string): Promise<void> {
	const boardReal = await boardRealPath(board);
	const parent = dirname(targetPath);
	let parentReal: string;
	try {
		parentReal = await realpath(parent);
	} catch {
		throw new FitError("BOARD_NOT_FOUND", `Target directory does not exist: ${parent}`);
	}
	if (!isInside(boardReal, parentReal)) {
		throw new FitError(
			"OUTSIDE_BOARD",
			`Refusing to write outside the FIT board: ${targetPath}`,
			{ hint: "A status/project directory may be a symlink outside the board." },
		);
	}
}

async function writeTempFile(path: string, content: string): Promise<string> {
	const temp = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temp, "wx", 0o666);
		await handle.writeFile(content, "utf8");
		await handle.sync().catch(() => undefined);
		await handle.close();
		handle = undefined;
		return temp;
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

/** Atomically replace an existing file (same-directory temp + rename). */
async function atomicWrite(path: string, content: string): Promise<void> {
	const temp = await writeTempFile(path, content);
	try {
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

/** Create a file without ever overwriting an existing one. */
async function atomicCreate(path: string, content: string): Promise<void> {
	const temp = await writeTempFile(path, content);
	try {
		try {
			await link(temp, path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") throw error;
			// Some filesystems do not support hard links. `wx` still refuses to
			// overwrite, which is the important invariant here.
			await writeFile(path, content, { encoding: "utf8", flag: "wx" });
		}
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

async function readOptionalFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export interface InitBoardOptions {
	/** Also ignore the board in the parent .gitignore and use the parent's fit branch. */
	git?: boolean;
	/** Opt in to Strict mode by writing a STRICT marker with the spec version. */
	strict?: boolean;
	/** Replace a known vendored FIT_SPEC.md with the current text, keeping annotations. */
	refreshSpec?: boolean;
	/** Resolve a local ticket that shares a path with the branch version. */
	resolveGitConflict?: GitConflictResolver;
}

export interface InitBoardResult {
	board: string;
	created: string[];
	existing: string[];
	specPath: string;
	specCreated: boolean;
	specUpdated: boolean;
	specPreserved: boolean;
	strictPath: string;
	strictCreated: boolean;
	strict: boolean;
	agentsPath: string;
	agentsCreated: boolean;
	agentsUpdated: boolean;
	agentSpecPath: string;
	agentSpecCreated: boolean;
	gitRequested: boolean;
	gitignorePath: string;
	gitignoreCreated: boolean;
	gitignoreUpdated: boolean;
	gitBranch: string;
	gitBranchCreated: boolean;
	gitWorktreeCreated: boolean;
	gitMergedTickets: string[];
	gitKeptBranchTickets: string[];
	gitBackupPath?: string;
}

interface BoardScaffold {
	created: string[];
	existing: string[];
	specPath: string;
	specCreated: boolean;
	specUpdated: boolean;
	specPreserved: boolean;
}

export type SpecRefreshAction = "created" | "updated" | "unchanged" | "preserved";

export interface SpecRefreshPlan {
	action: SpecRefreshAction;
	content: string;
}

/**
 * Decide how to refresh an existing FIT_SPEC.md. Known legacy texts (and the
 * current text) are replaced in place; anything appended after a known spec is
 * treated as local annotation and kept. Unrecognized content is never touched.
 */
export function planSpecRefresh(
	existing: string | null,
	refresh: boolean,
): SpecRefreshPlan {
	if (existing === null) return { action: "created", content: FIT_SPEC };
	if (existing === FIT_SPEC || existing.startsWith(FIT_SPEC)) {
		return { action: "unchanged", content: existing };
	}
	if (!refresh) return { action: "unchanged", content: existing };
	for (const legacy of FIT_SPEC_LEGACY) {
		if (existing === legacy) return { action: "updated", content: FIT_SPEC };
		if (existing.startsWith(legacy)) {
			const annotation = existing.slice(legacy.length);
			const separator = annotation && !annotation.startsWith("\n") ? "\n" : "";
			return { action: "updated", content: `${FIT_SPEC}${separator}${annotation}` };
		}
	}
	return { action: "preserved", content: existing };
}

async function ensureBoardScaffold(
	board: string,
	refreshSpec = false,
): Promise<BoardScaffold> {
	const created: string[] = [];
	const existing: string[] = [];
	for (const status of FIT_STATUSES) {
		const dir = join(board, status);
		if (await isDirectory(dir)) {
			existing.push(status);
			continue;
		}
		await mkdir(dir, { recursive: true });
		// A board is valid without .gitkeep. The upstream CLI adds it so empty
		// status directories survive a git checkout; match that behavior.
		try {
			await writeFile(join(dir, ".gitkeep"), "", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		created.push(status);
	}

	// The spec explicitly allows the specification document at the board root.
	// Keep an existing copy unless a refresh is requested and it is a known
	// vendored version (user annotations are carried over).
	const specPath = join(board, "FIT_SPEC.md");
	const currentSpec = await readOptionalFile(specPath);
	const plan = planSpecRefresh(currentSpec, refreshSpec);
	if (plan.action === "created") {
		await atomicCreate(specPath, plan.content);
	} else if (plan.action === "updated") {
		await atomicWrite(specPath, plan.content);
	}

	return {
		created,
		existing,
		specPath,
		specCreated: plan.action === "created",
		specUpdated: plan.action === "updated",
		specPreserved: plan.action === "preserved",
	};
}

/** Write the Strict marker (`"<version>"`) without overwriting an existing one. */
async function ensureStrictMarker(
	board: string,
	requested: boolean,
): Promise<{ path: string; created: boolean; present: boolean }> {
	const path = join(board, "STRICT");
	if (await isFile(path)) return { path, created: false, present: true };
	if (!requested) return { path, created: false, present: false };
	try {
		await atomicCreate(path, `"${FIT_SPEC_VERSION}"\n`);
		return { path, created: true, present: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return { path, created: false, present: true };
	}
}

export async function initBoard(
	board: string,
	options: InitBoardOptions = {},
): Promise<InitBoardResult> {
	if (await isFile(board)) {
		throw new FitError("BOARD_NOT_DIRECTORY", `Board path is a file, not a directory: ${board}`);
	}
	await mkdir(board, { recursive: true });
	let scaffold = await ensureBoardScaffold(board, options.refreshSpec === true);

	// AGENTS.md links to this file, so create it beside the instructions. An
	// existing copy belongs to the project and is never overwritten.
	const agentSpecPath = join(dirname(board), "AGENT_SPEC.md");
	const existingAgentSpec = await readOptionalFile(agentSpecPath);
	let agentSpecCreated = false;
	if (existingAgentSpec === null) {
		await atomicCreate(agentSpecPath, AGENT_SPEC);
		agentSpecCreated = true;
	}

	// Manage only a marked section in AGENTS.md; project instructions outside
	// the markers are preserved. By convention the board sits at the repo root.
	const agentsPath = join(dirname(board), "AGENTS.md");
	const existingAgents = await readOptionalFile(agentsPath);
	const mergedAgents = mergeAgentsContent(existingAgents);
	let agentsCreated = false;
	let agentsUpdated = false;
	if (existingAgents === null) {
		await atomicCreate(agentsPath, mergedAgents.content);
		agentsCreated = true;
	} else if (mergedAgents.changed) {
		await atomicWrite(agentsPath, mergedAgents.content);
		agentsUpdated = true;
	}

	const gitRequested = options.git === true;
	const repoRoot = await findRepositoryRoot(dirname(board));
	const gitignorePath = join(repoRoot ?? dirname(board), ".gitignore");
	let gitignoreCreated = false;
	let gitignoreUpdated = false;
	let gitBranch = "fit";
	let gitBranchCreated = false;
	let gitWorktreeCreated = false;
	let gitMergedTickets: string[] = [];
	let gitKeptBranchTickets: string[] = [];
	let gitBackupPath: string | undefined;
	if (gitRequested) {
		const existingGitignore = await readOptionalFile(gitignorePath);
		const mergedGitignore = mergeGitignoreContent(
			existingGitignore,
			board,
			repoRoot ?? undefined,
		);
		if (existingGitignore === null) {
			await atomicCreate(gitignorePath, mergedGitignore.content);
			gitignoreCreated = true;
		} else if (mergedGitignore.changed) {
			await atomicWrite(gitignorePath, mergedGitignore.content);
			gitignoreUpdated = true;
		}

		try {
			const setup = await ensureBoardBranchWorktree(board, {
				resolveConflict: options.resolveGitConflict,
			});
			gitBranch = setup.branch;
			gitBranchCreated = setup.branchCreated;
			gitWorktreeCreated = setup.worktreeCreated;
			gitMergedTickets = setup.mergedTickets;
			gitKeptBranchTickets = setup.keptBranchTickets;
			gitBackupPath = setup.backupPath;
		} catch (error) {
			if (error instanceof GitMergeConflictError) {
				throw new FitError(
					"GIT_MERGE_CONFLICT",
					"Local tickets conflict with tickets already on the fit branch.",
					{
						hint: error.backupPath
							? `Resolve the conflicts and rerun /fit init git. Local contents are saved at ${error.backupPath}.`
							: "Resolve the conflicts and rerun /fit init git.",
						candidates: error.conflicts,
					},
				);
			}
			throw new FitError(
				"GIT_INIT_FAILED",
				`Could not set up the ${gitBranch} branch worktree at ${board}.`,
				{
					hint: error instanceof Error ? error.message : String(error),
				},
			);
		}

		// A pulled branch may not contain every scaffold file yet.
		scaffold = await ensureBoardScaffold(board, options.refreshSpec === true);
	}

	const strictMarker = await ensureStrictMarker(board, options.strict === true);

	return {
		board,
		created: scaffold.created,
		existing: scaffold.existing,
		specPath: scaffold.specPath,
		specCreated: scaffold.specCreated,
		specUpdated: scaffold.specUpdated,
		specPreserved: scaffold.specPreserved,
		strictPath: strictMarker.path,
		strictCreated: strictMarker.created,
		strict: strictMarker.present,
		agentsPath,
		agentsCreated,
		agentsUpdated,
		agentSpecPath,
		agentSpecCreated,
		gitRequested,
		gitignorePath,
		gitignoreCreated,
		gitignoreUpdated,
		gitBranch,
		gitBranchCreated,
		gitWorktreeCreated,
		gitMergedTickets,
		gitKeptBranchTickets,
		gitBackupPath,
	};
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function walkTickets(root: string, relDir: string, out: string[]): Promise<void> {
	const dir = relDir ? join(root, ...relDir.split("/")) : root;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isSymbolicLink()) continue;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			await walkTickets(root, rel, out);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			out.push(rel);
		}
	}
}

function compareTickets(a: TicketSummary, b: TicketSummary): number {
	const rankA = STATUS_RANK[a.status] ?? 100;
	const rankB = STATUS_RANK[b.status] ?? 100;
	if (rankA !== rankB) return rankA - rankB;
	if (rankA === 100) {
		if (a.status < b.status) return -1;
		if (a.status > b.status) return 1;
	}

	// Direct files sort before sub-status directories. Sub-status segments
	// compare by name, recursively; equal sub-statuses compare by filename.
	const subdirA = a.subdir ? a.subdir.split("/") : [];
	const subdirB = b.subdir ? b.subdir.split("/") : [];
	const length = Math.max(subdirA.length, subdirB.length);
	for (let index = 0; index < length; index += 1) {
		const partA = subdirA[index];
		const partB = subdirB[index];
		if (partA === undefined) return -1;
		if (partB === undefined) return 1;
		if (partA < partB) return -1;
		if (partA > partB) return 1;
	}

	if (a.filename < b.filename) return -1;
	if (a.filename > b.filename) return 1;
	return 0;
}

/**
 * Pick the next ticket to work on when none is in progress: the first open
 * ticket, falling back to the first backlog ticket. Mirrors the FIT CLI's
 * `pull` command. `tickets` must already be in deterministic order.
 */
export function nextTicketToPromote(
	tickets: TicketSummary[],
): TicketSummary | undefined {
	return (
		tickets.find((ticket) => ticket.status === "open") ??
		tickets.find((ticket) => ticket.status === "backlog")
	);
}

/** List every ticket on the board in deterministic order. */
export async function listTickets(
	board: string,
	_mode?: BoardMode,
): Promise<TicketSummary[]> {
	if (!(await isDirectory(board))) {
		throw new FitError("BOARD_NOT_FOUND", `FIT board not found: ${board}`, {
			hint: "Run fit_init to create ./fit, or pass the correct board path.",
		});
	}

	// Only walk child directories. Root-level Markdown such as FIT_SPEC.md is
	// not a ticket.
	const ids: string[] = [];
	const rootEntries = await readdir(board, { withFileTypes: true });
	rootEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of rootEntries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isSymbolicLink()) continue;
		if (!entry.isDirectory()) continue;
		await walkTickets(board, entry.name, ids);
	}
	ids.sort();

	const tickets: TicketSummary[] = [];
	for (const id of ids) {
		const path = join(board, ...id.split("/"));
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch {
			continue;
		}
		tickets.push(summarize(id, path, content));
	}
	tickets.sort(compareTickets);
	return tickets;
}

function displayNameFromShortName(shortName: string): string {
	return shortName
		.split("-")
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function projectFromFrontmatter(
	frontmatter: Record<string, FrontmatterValue>,
): string | null {
	const value = frontmatter.project;
	if (value === undefined || value === null || Array.isArray(value)) return null;
	return String(value);
}

function summarize(id: string, path: string, content: string): TicketSummary {
	const parts = id.split("/");
	const status = parts[0] ?? "";
	const filename = parts[parts.length - 1] ?? id;
	const subdir = parts.slice(1, -1).join("/");
	const name = filename.replace(/\.md$/i, "");
	const priorityMatch = /^(\d{2})-/.exec(name);
	const shortName = priorityMatch ? name.slice(priorityMatch[0].length) : name;
	const { raw, body } = splitFrontmatter(content);
	return {
		id,
		path,
		status,
		subdir,
		filename,
		name,
		shortName,
		displayName: displayNameFromShortName(shortName),
		project: projectFromFrontmatter(parseFrontmatter(raw)),
		priority: priorityMatch ? Number(priorityMatch[1]) : null,
		title: deriveTitle(body),
		bodyChars: Array.from(body.trim()).length,
	};
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

async function boardRealPath(board: string): Promise<string> {
	try {
		return await realpath(board);
	} catch {
		return resolve(board);
	}
}

async function finalizeTicketPath(
	boardReal: string,
	absolutePath: string,
	allowExtra = false,
): Promise<{ path: string; id: string }> {
	assertTicketFileName(absolutePath);
	let real: string;
	try {
		real = await realpath(absolutePath);
	} catch {
		throw new FitError("TICKET_NOT_FOUND", `Ticket not found: ${absolutePath}`, {
			hint: "Use fit_list to get exact ticket ids.",
		});
	}
	if (!isInside(boardReal, real)) {
		throw new FitError(
			"OUTSIDE_BOARD",
			`Ticket resolves outside the FIT board: ${absolutePath}`,
			{ hint: "Ticket ids must stay inside the board directory." },
		);
	}
	if (!(await lstat(real)).isFile()) {
		throw new FitError("TICKET_NOT_FOUND", `Not a ticket file: ${absolutePath}`);
	}
	const id = relative(boardReal, real).split("\\").join("/");
	assertTicketIdShape(id, allowExtra);
	// Return the path as addressed through the board argument (which may itself
	// be a symlink). `real` was only used for containment/id validation.
	return { path: absolutePath, id };
}

/**
 * Resolve a ticket id to an absolute path.
 *
 * Accepted forms:
 * - exact board-relative path: "open/03-fix-typo.md" or "open/03-fix-typo"
 * - absolute path inside the board
 * - a bare filename, full stem, or short name, only if it is unique on the
 *   board
 */
export async function resolveTicketPath(
	board: string,
	idInput: string,
): Promise<{ path: string; id: string }> {
	const input = normalizeIdPath(idInput);
	const boardReal = await boardRealPath(board);
	if (!(await isDirectory(boardReal))) {
		throw new FitError("BOARD_NOT_FOUND", `FIT board not found: ${board}`, {
			hint: "Run fit_init to create ./fit, or pass the correct board path.",
		});
	}
	const allowExtra = (await readBoardMode(boardReal)).mode === "basic";

	if (isAbsolute(input)) {
		const absolute = resolve(input);
		if (!isInside(boardReal, absolute)) {
			throw new FitError("OUTSIDE_BOARD", `Ticket is outside the FIT board: ${absolute}`);
		}
		const withExt = absolute.toLowerCase().endsWith(".md") ? absolute : `${absolute}.md`;
		return finalizeTicketPath(boardReal, withExt, allowExtra);
	}

	let rel = input.replace(/^\.\/+/, "").replace(/^\/+/, "");
	const boardName = basename(boardReal);
	if (rel.startsWith(`${boardName}/`)) rel = rel.slice(boardName.length + 1);
	if (rel.split("/").some((part) => part === "." || part === "..")) {
		throw new FitError("INVALID_ID", `Ticket id must not contain "." or "..": ${idInput}`);
	}
	if (!rel) throw new FitError("INVALID_ID", "Ticket id must not be empty.");

	const direct = join(boardReal, ...rel.split("/"));
	const directWithExt = direct.toLowerCase().endsWith(".md") ? direct : `${direct}.md`;
	if (await isFile(directWithExt)) {
		return finalizeTicketPath(boardReal, directWithExt, allowExtra);
	}

	if (rel.includes("/")) {
		throw new FitError("TICKET_NOT_FOUND", `Ticket not found: ${rel}`, {
			hint: "Use fit_list to get exact ticket ids.",
		});
	}

	// Bare name: accept only a unique exact filename, full stem, or short name.
	const needle = rel.toLowerCase().endsWith(".md") ? rel : `${rel}.md`;
	const shortNameNeedle = rel.replace(/\.md$/i, "");
	const all = await listTickets(boardReal);
	const matches = all.filter(
		(ticket) =>
			ticket.filename === needle ||
			ticket.name === rel ||
			ticket.shortName === shortNameNeedle,
	);
	if (matches.length === 1) {
		return finalizeTicketPath(boardReal, matches[0].path, allowExtra);
	}
	if (matches.length === 0) {
		throw new FitError("TICKET_NOT_FOUND", `Ticket not found: ${rel}`, {
			hint: "Use fit_list to get exact ticket ids.",
		});
	}
	throw new FitError(
		"AMBIGUOUS_TICKET",
		`Ticket name "${rel}" matches ${matches.length} tickets.`,
		{
			hint: "Pass the full board-relative id (for example open/03-fix-typo.md).",
			candidates: matches.map((ticket) => ticket.id),
		},
	);
}

export async function readTicket(board: string, id: string): Promise<Ticket> {
	const resolved = await resolveTicketPath(board, id);
	const content = await readFile(resolved.path, "utf8");
	const { raw, body } = splitFrontmatter(content);
	const summary = summarize(resolved.id, resolved.path, content);
	return {
		...summary,
		content,
		revision: revisionOf(content),
		frontmatterRaw: raw,
		frontmatter: parseFrontmatter(raw),
		body,
	};
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function normalizeStatusPath(
	status: string,
	options: { allowExtra?: boolean } = {},
): string {
	const value = status.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const parts = value.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) {
		throw new FitError("INVALID_STATUS", "Status must not be empty.", {
			hint: `Use one of: ${FIT_STATUSES.join(", ")}.`,
		});
	}
	const rawFirst = parts[0];
	const lowerFirst = rawFirst.toLowerCase();
	const canonical = STATUS_ALIASES[lowerFirst] ?? lowerFirst;
	let first: string;
	if ((FIT_STATUSES as readonly string[]).includes(canonical)) {
		first = canonical;
	} else if (options.allowExtra === true) {
		first = rawFirst;
	} else {
		throw new FitError("INVALID_STATUS", `Unknown FIT status: ${parts[0]}`, {
			hint: `Use one of: ${FIT_STATUSES.join(", ")}. Subtrees such as open/project-x are allowed.`,
		});
	}
	for (const part of parts) {
		if (part === "." || part === ".." || part.startsWith(".")) {
			throw new FitError("INVALID_STATUS", `Invalid status path segment: ${part}`);
		}
		if (/[<>:"|?*\u0000-\u001f]/.test(part)) {
			throw new FitError("INVALID_STATUS", `Invalid character in status path segment: ${part}`);
		}
	}
	return [first, ...parts.slice(1)].join("/");
}

function validatePriority(priority: number): number {
	if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
		throw new FitError(
			"INVALID_PRIORITY",
			`Priority must be an integer between 0 and ${MAX_PRIORITY} (two digits).`,
		);
	}
	return priority;
}

export function slugify(input: string, fallback = "ticket"): string {
	const normalized = input.normalize("NFKC").toLowerCase();
	const slug = normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	return truncateSlug(slug || fallback);
}

/** Truncate a slug to the short-name limit, preferring a word boundary. */
function truncateSlug(slug: string, limit = MAX_SLUG_CHARS): string {
	const chars = Array.from(slug);
	if (chars.length <= limit) return slug;
	let raw = chars.slice(0, limit).join("");
	if (!raw.endsWith("-")) {
		const lastHyphen = raw.lastIndexOf("-");
		if (lastHyphen > 0) raw = raw.slice(0, lastHyphen);
	}
	return raw.replace(/-+$/g, "") || "ticket";
}

function untruncatedSlug(input: string, fallback = "ticket"): string {
	const normalized = input.normalize("NFKC").toLowerCase();
	return normalized.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || fallback;
}

export function deriveTitle(body: string): string {
	const firstLine =
		body
			.replace(/\r\n?/g, "\n")
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const withoutHeading = firstLine.replace(/^#{1,6}\s+/, "").trim();
	const sentence = /^(.+?[.!?])(?:\s|$)/.exec(withoutHeading);
	return (sentence?.[1] ?? withoutHeading).trim();
}

/**
 * Derive a ticket name from its body: the first seven words of the first
 * sentence. The full sentence remains available as the ticket title.
 */
export function deriveTicketName(body: string): string {
	const words = deriveTitle(body).split(/\s+/).filter(Boolean);
	return words.slice(0, MAX_NAME_WORDS).join(" ");
}

export function ticketFilename(priority: number, slug: string): string {
	const safePriority = validatePriority(priority);
	return `${String(safePriority).padStart(2, "0")}-${slugify(slug)}.md`;
}

function cleanBody(body: string, trimStart = true): string {
	let value = body.replace(/\r\n?/g, "\n");
	if (trimStart) value = value.replace(/^\n+/, "");
	return value.replace(/\s+$/, "");
}

export function ticketWarnings(body: string): string[] {
	return legacyBodyReasons(body).map((reason) =>
		reason.startsWith("summary has")
			? `Body ${reason}; keep the summary to 1-3 sentences and move the rest under ### headers.`
			: `Body ${reason}; put everything after the summary under ### headers.`,
	);
}

interface PreparedCreate {
	statusPath: string;
	body: string;
	frontmatterRaw: string | null;
	content: string;
	priority: number;
	baseSlug: string;
	slugWarning: string | null;
}

function prepareCreate(input: CreateTicketInput): PreparedCreate {
	const statusPath = normalizeStatusPath(input.status ?? "open");
	const topStatus = statusPath.split("/")[0];
	if (topStatus !== "open" && topStatus !== "backlog") {
		throw new FitError(
			"INVALID_INITIAL_STATUS",
			`New tickets must be created in open or backlog, not ${topStatus}.`,
			{ hint: "Create the ticket in open/backlog, then use fit_move to change its status." },
		);
	}

	const body = cleanBody(input.content ?? "");
	const titleSource = input.slug ?? input.title ?? deriveTicketName(body);
	if (!titleSource.trim()) {
		throw new FitError(
			"MISSING_SLUG",
			"A ticket needs a slug, title, or non-empty body so a name can be derived.",
		);
	}

	const frontmatterInput = { ...(input.frontmatter ?? {}) };
	if (input.project !== undefined) frontmatterInput.project = input.project;
	const frontmatterRaw = updateFrontmatterRaw(null, frontmatterInput, []);
	const fullSlug = untruncatedSlug(titleSource);
	const explicitName = input.slug !== undefined || input.title !== undefined;
	const slugWarning =
		explicitName && Array.from(fullSlug).length > MAX_SLUG_CHARS
			? `Slug was truncated to ${MAX_SLUG_CHARS} characters; the short-name limit is ${MAX_SLUG_CHARS}.`
			: null;
	return {
		statusPath,
		body,
		frontmatterRaw,
		content: composeTicket(frontmatterRaw, body),
		priority: validatePriority(input.priority ?? 0),
		baseSlug: slugify(titleSource),
		slugWarning,
	};
}

/**
 * Return the filename `createTicket` would use, or its first free suffixed
 * alternative when the base name is already taken. This is read-only.
 */
export async function suggestTicketFilename(input: CreateTicketInput): Promise<string> {
	const prepared = prepareCreate(input);
	const dir = join(input.board, ...prepared.statusPath.split("/"));
	const baseSlug = prepared.baseSlug;
	const candidate = join(dir, ticketFilename(prepared.priority, baseSlug));
	const tickets = await boardTickets(input.board);
	const nameTaken = tickets.some((ticket) => ticket.shortName === baseSlug);
	if (!nameTaken && !(await pathExists(candidate))) return basename(candidate);
	const suggestion = await findAvailableName(
		input.board,
		dir,
		prepared.priority,
		baseSlug,
	);
	if (!suggestion) {
		throw new FitError("NAME_TAKEN", `No free ticket name found for ${baseSlug}.`);
	}
	return basename(suggestion);
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
	const board = input.board;
	if (await isFile(board)) {
		throw new FitError("BOARD_NOT_DIRECTORY", `Board path is a file: ${board}`);
	}
	const mode = await readBoardMode(board);
	const prepared = prepareCreate(input);
	const createWarnings = prepared.slugWarning
		? [prepared.slugWarning, ...ticketWarnings(prepared.body)]
		: ticketWarnings(prepared.body);

	const dir = join(board, ...prepared.statusPath.split("/"));
	await mkdir(dir, { recursive: true });
	await assertWritableInsideBoard(board, join(dir, "ticket.md"));

	const path = join(dir, ticketFilename(prepared.priority, prepared.baseSlug));
	const nameHolder = (await boardTickets(board)).find(
		(ticket) => ticket.shortName === prepared.baseSlug && ticket.path !== path,
	);
	if (nameHolder) {
		throw await nameTakenError(
			board,
			dir,
			prepared.priority,
			prepared.baseSlug,
			nameHolder.path,
		);
	}
	try {
		await atomicCreate(path, prepared.content);
		const ticket = await readTicket(
			board,
			posix.join(prepared.statusPath, basename(path)),
		);
		return { ticket, warnings: createWarnings, created: true, mode };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Retrying an identical create is a no-op, not a duplicate ticket.
		const existing = await readFile(path, "utf8").catch(() => null);
		if (existing === prepared.content) {
			const ticket = await readTicket(
				board,
				posix.join(prepared.statusPath, basename(path)),
			);
			return { ticket, warnings: createWarnings, created: false, mode };
		}
		throw await nameTakenError(
			board,
			dir,
			prepared.priority,
			prepared.baseSlug,
			path,
		);
	}
}

/**
 * Create several tickets from structured objects. Every item is validated
 * before anything is written, so an invalid item cannot leave a partial batch
 * behind. The tickets are still created one at a time, exactly like fit_new.
 */
export async function createTickets(input: CreateTicketsInput): Promise<CreateTicketsResult> {
	const board = input.board;
	if (await isFile(board)) {
		throw new FitError("BOARD_NOT_DIRECTORY", `Board path is a file: ${board}`);
	}
	if (input.tickets.length === 0) {
		throw new FitError("NOTHING_TO_CREATE", "Pass at least one ticket to create.", {
			hint: "Provide a non-empty JSON list of ticket-like objects.",
		});
	}

	for (const item of input.tickets) prepareCreate({ board, ...item });

	const mode = await readBoardMode(board);
	const tickets: CreateTicketResult[] = [];
	const warnings: string[] = [];
	for (const [index, item] of input.tickets.entries()) {
		const result = await createTicket({ board, ...item });
		tickets.push(result);
		for (const warning of result.warnings) {
			warnings.push(`Ticket ${index + 1}: ${warning}`);
		}
	}
	return { tickets, warnings, mode };
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function existingSlug(ticket: Ticket): string {
	return ticket.shortName || ticket.name;
}

async function boardTickets(board: string): Promise<TicketSummary[]> {
	if (!(await isDirectory(board))) return [];
	return listTickets(board);
}

function suffixedSlug(baseSlug: string, attempt: number): string {
	const suffix = `-${attempt}`;
	const room = Math.max(1, MAX_SLUG_CHARS - Array.from(suffix).length);
	const stem = Array.from(baseSlug).slice(0, room).join("").replace(/-+$/g, "");
	return `${stem || "ticket"}${suffix}`;
}

async function findAvailableName(
	board: string,
	dir: string,
	priority: number,
	baseSlug: string,
	sourcePath?: string,
): Promise<string | undefined> {
	const tickets = await boardTickets(board);
	const taken = new Set(
		tickets.filter((ticket) => ticket.path !== sourcePath).map((ticket) => ticket.shortName),
	);
	for (let attempt = 2; attempt <= 999; attempt += 1) {
		const slug = suffixedSlug(baseSlug, attempt);
		if (taken.has(slug)) continue;
		const candidate = join(dir, ticketFilename(priority, slug));
		if (candidate === sourcePath) return candidate;
		if (!(await pathExists(candidate))) return candidate;
	}
	return undefined;
}

async function nameTakenError(
	board: string,
	dir: string,
	priority: number,
	baseSlug: string,
	target: string,
	sourcePath?: string,
): Promise<FitError> {
	const suggestion = await findAvailableName(
		board,
		dir,
		priority,
		baseSlug,
		sourcePath,
	);
	const suggestedName = suggestion ? basename(suggestion, ".md") : undefined;
	return new FitError("NAME_TAKEN", `Ticket name is already taken: ${target}`, {
		hint: suggestedName
			? `Choose a different slug, for example "${suggestedName}", or rename the existing ticket first.`
			: "Choose a different slug or rename the existing ticket first.",
		candidates: [target, ...(suggestion ? [suggestion] : [])],
	});
}

async function chooseTarget(
	board: string,
	dir: string,
	priority: number,
	baseSlug: string,
	sourcePath: string,
): Promise<string> {
	const candidate = join(dir, ticketFilename(priority, baseSlug));
	if (candidate === sourcePath) return candidate;
	const tickets = await boardTickets(board);
	const nameHolder = tickets.find(
		(ticket) => ticket.shortName === baseSlug && ticket.path !== sourcePath,
	);
	if (nameHolder || (await pathExists(candidate))) {
		throw await nameTakenError(
			board,
			dir,
			priority,
			baseSlug,
			nameHolder?.path ?? candidate,
			sourcePath,
		);
	}
	return candidate;
}

async function moveFile(source: string, target: string): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	try {
		// Hard-link first: this refuses to overwrite and keeps the source intact
		// if the final unlink fails.
		await link(source, target);
		await unlink(source);
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") {
			throw new FitError("NAME_COLLISION", `Target already exists: ${target}`);
		}
		if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOSYS" && code !== "EACCES") {
			throw error;
		}
	}
	// Cross-device or a filesystem without hard links. COPYFILE_EXCL still
	// guarantees we never clobber an existing ticket.
	await copyFile(source, target, constants.COPYFILE_EXCL);
	await unlink(source);
}

function assertRevision(ticket: Ticket, expectedRevision: string | undefined): void {
	if (!expectedRevision) return;
	if (ticket.revision === expectedRevision) return;
	throw new FitError(
		"STALE_TICKET",
		`Ticket ${ticket.id} changed since revision ${expectedRevision}.`,
		{
			hint: `Current revision is ${ticket.revision}. Read the ticket again before mutating it.`,
		},
	);
}

async function isTrackedInline(board: string): Promise<boolean> {
	try {
		await inspectBoardGit(board);
		return false;
	} catch {
		return true;
	}
}

export interface MoveTicketResult {
	ticket: Ticket;
	fromId: string;
	toId: string;
	changed: boolean;
	/** True when the board branch received a close commit. */
	committed: boolean;
	mode: BoardMode;
}

export async function moveTicket(input: MoveTicketInput): Promise<MoveTicketResult> {
	const mode = await readBoardMode(input.board);
	const resolved = await resolveTicketPath(input.board, input.id);
	const ticket = await readTicket(input.board, input.id);
	assertRevision(ticket, input.expectedRevision);
	const targetStatus = normalizeStatusPath(input.status, {
		allowExtra: mode.mode === "basic",
	});
	const targetParts = targetStatus.split("/");
	if (targetParts[0] === "in_progress") {
		const others = (await listTickets(input.board)).filter(
			(candidate) =>
				candidate.status === "in_progress" && candidate.id !== ticket.id,
		);
		if (others.length > 0) {
			throw new FitError(
				"IN_PROGRESS_LIMIT",
				`in_progress already contains ${others.length} ticket(s); only one is allowed per checkout.`,
				{
					hint: "Move the current in_progress ticket to open, backlog, or closed first.",
					candidates: others.map((candidate) => candidate.id),
				},
			);
		}
	}

	// Moving to a top-level status keeps the ticket's project subdirectory.
	// An explicit nested target (closed/project-x) wins.
	const targetDirRel =
		targetParts.length === 1 && ticket.subdir
			? posix.join(targetParts[0], ticket.subdir)
			: targetStatus;

	const priority = validatePriority(input.priority ?? ticket.priority ?? 0);
	const baseSlug = input.slug ? slugify(input.slug) : existingSlug(ticket);
	const targetDir = join(input.board, ...targetDirRel.split("/"));
	await mkdir(targetDir, { recursive: true });
	await assertWritableInsideBoard(input.board, join(targetDir, "ticket.md"));
	const targetPath = await chooseTarget(input.board, targetDir, priority, baseSlug, resolved.path);
	const targetId = relative(input.board, targetPath).split("\\").join("/");

	if (targetPath === resolved.path) {
		return {
			ticket,
			fromId: resolved.id,
			toId: resolved.id,
			changed: false,
			committed: false,
			mode,
		};
	}

	await moveFile(resolved.path, targetPath);
	let moved = await readTicket(input.board, targetId);
	const closing = targetParts[0] === "closed";
	const inline = closing ? await isTrackedInline(input.board) : true;
	if (closing && moved.frontmatter.completed === undefined && !inline) {
		const updated = await updateTicket({
			board: input.board,
			id: targetId,
			set: { completed: new Date().toISOString() },
			expectedRevision: moved.revision,
		});
		moved = updated.ticket;
	}

	// Inline boards leave the close move for the parent work commit. A board on
	// its own branch/repository commits the close on that board branch.
	let committed = false;
	if (closing && !inline) {
		committed = await commitWorktreePath(
			input.board,
			`FIT: close ${moved.shortName || moved.name}`,
		);
	}
	return {
		ticket: moved,
		fromId: resolved.id,
		toId: targetId,
		changed: true,
		committed,
		mode,
	};
}

export interface ArchiveTicketInput {
	board: string;
	id: string;
	expectedRevision?: string;
}

export interface ArchiveRecord {
	/** Header path, including the board directory. */
	path: string;
	/** Exact fenced ticket content. */
	body: string;
}

export interface ParsedArchive {
	records: ArchiveRecord[];
	errors: string[];
}

export interface ArchiveTicketResult {
	archivePath: string;
	archivedId: string;
	recordPath: string;
	revision: string;
}

export interface RestoreTicketInput {
	board: string;
	/** Archived record path, with or without the board prefix. */
	id: string;
	/** Destination status; defaults to open. */
	status?: string;
}

export interface RestoreTicketResult {
	archivePath: string;
	fromRecord: string;
	ticket: Ticket;
	remainingRecords: number;
}

function archiveRecordText(record: ArchiveRecord): string {
	const body = record.body.endsWith("\n") ? record.body : `${record.body}\n`;
	return `### ${record.path}\n\`\`\`\n${body}\`\`\`\n\n`;
}

/** Parse the fenced archive format used by closed/archive.txt. */
export function parseArchiveContent(content: string): ParsedArchive {
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const records: ArchiveRecord[] = [];
	const errors: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		if (!line.startsWith("### ")) {
			errors.push(`line ${index + 1}: expected an "### <path>" record header`);
			index += 1;
			continue;
		}
		const path = line.slice(4).trim();
		if (lines[index + 1] !== "\`\`\`") {
			errors.push(`line ${index + 1}: record header must be followed by a \`\`\` fence`);
			index += 1;
			continue;
		}
		let close = index + 2;
		while (close < lines.length && lines[close] !== "\`\`\`") close += 1;
		if (close >= lines.length) {
			errors.push(`line ${index + 1}: unterminated fenced record body`);
			break;
		}
		const body = lines.slice(index + 2, close).join("\n");
		records.push({ path, body: body ? `${body}\n` : "" });
		index = close + 1;
	}
	return { records, errors };
}

/** Append a closed ticket to closed/archive.txt, then remove the ticket file. */
export async function archiveTicket(
	input: ArchiveTicketInput,
): Promise<ArchiveTicketResult> {
	const ticket = await readTicket(input.board, input.id);
	assertRevision(ticket, input.expectedRevision);
	if (ticket.status !== "closed") {
		throw new FitError("NOT_CLOSED", `Only closed tickets can be archived: ${ticket.id}`, {
			hint: "Move the ticket to closed first with fit_move.",
		});
	}

	const archivePath = join(input.board, "closed", "archive.txt");
	const existing = (await readOptionalFile(archivePath)) ?? "";
	const recordPath = `${basename(resolve(input.board))}/${ticket.id}`;
	const body = ticket.content.endsWith("\n") ? ticket.content : `${ticket.content}\n`;
	const record = archiveRecordText({ path: recordPath, body });
	const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
	await atomicWrite(archivePath, `${prefix}${record}`);
	await unlink(ticket.path);
	return {
		archivePath,
		archivedId: ticket.id,
		recordPath,
		revision: ticket.revision,
	};
}

/** Restore one archive record into a status directory, then remove the record. */
export async function restoreArchivedTicket(
	input: RestoreTicketInput,
): Promise<RestoreTicketResult> {
	const mode = await readBoardMode(input.board);
	const archivePath = join(input.board, "closed", "archive.txt");
	const content = await readOptionalFile(archivePath);
	if (content === null) {
		throw new FitError("ARCHIVE_NOT_FOUND", `No archive found at ${archivePath}.`);
	}
	const parsed = parseArchiveContent(content);
	if (parsed.errors.length > 0) {
		throw new FitError("ARCHIVE_INVALID", `Archive is malformed: ${parsed.errors[0]}`);
	}
	const boardName = basename(resolve(input.board));
	const wanted = input.id.replace(/\\/g, "/").replace(/^\.?\/+/, "");
	const matches = parsed.records.filter(
		(record) =>
			record.path === wanted ||
			record.path === `${boardName}/${wanted}` ||
			record.path.endsWith(`/${wanted}`),
	);
	if (matches.length === 0) {
		throw new FitError("ARCHIVE_RECORD_NOT_FOUND", `No archived record matches ${input.id}.`, {
			candidates: parsed.records.map((record) => record.path),
		});
	}
	if (matches.length > 1) {
		throw new FitError("AMBIGUOUS_ARCHIVE_RECORD", `Several archived records match ${input.id}.`, {
			candidates: matches.map((record) => record.path),
		});
	}
	const record = matches[0];
	const statusPath = normalizeStatusPath(input.status ?? "open", {
		allowExtra: mode.mode === "basic",
	});
	const filename = basename(record.path);
	if (!filename.toLowerCase().endsWith(".md")) {
		throw new FitError("ARCHIVE_INVALID", `Archived record is not a Markdown ticket: ${record.path}`);
	}
	const dir = join(input.board, ...statusPath.split("/"));
	await mkdir(dir, { recursive: true });
	await assertWritableInsideBoard(input.board, join(dir, "ticket.md"));
	const targetPath = join(dir, filename);
	const shortName = filename.replace(/\.md$/i, "").replace(/^\d{2}-/, "");
	const collision = (await boardTickets(input.board)).find(
		(ticket) => ticket.shortName === shortName,
	);
	if (collision || (await pathExists(targetPath))) {
		throw new FitError("NAME_TAKEN", `Ticket name is already in use: ${shortName}`, {
			candidates: collision ? [collision.id] : [targetPath],
			hint: "Rename or remove the existing ticket before restoring this record.",
		});
	}
	await atomicCreate(targetPath, record.body);
	const remaining = parsed.records.filter((candidate) => candidate !== record);
	if (remaining.length === 0) await unlink(archivePath);
	else await atomicWrite(archivePath, remaining.map(archiveRecordText).join(""));
	const targetId = relative(input.board, targetPath).split("\\").join("/");
	return {
		archivePath,
		fromRecord: record.path,
		ticket: await readTicket(input.board, targetId),
		remainingRecords: remaining.length,
	};
}

function validateNameMaxLength(value: number | undefined): number {
	const maxLength = value ?? DEFAULT_MAX_TICKET_NAME_CHARS;
	if (
		!Number.isInteger(maxLength) ||
		maxLength < MIN_TICKET_NAME_CHARS ||
		maxLength > MAX_TICKET_NAME_CHARS
	) {
		throw new FitError(
			"INVALID_MAX_LENGTH",
			`Maximum ticket name length must be an integer between ${MIN_TICKET_NAME_CHARS} and ${MAX_TICKET_NAME_CHARS}.`,
		);
	}
	return maxLength;
}

/**
 * Truncate a ticket name stem while preserving any numeric priority prefix.
 * The cut prefers a hyphen boundary so cleanup does not leave a partial word.
 */
export function truncateTicketName(name: string, maxLength = DEFAULT_MAX_TICKET_NAME_CHARS): string {
	const limit = validateNameMaxLength(maxLength);
	if (Array.from(name).length <= limit) return name;

	const priority = /^(\d{2}-)/.exec(name)?.[1] ?? "";
	const slug = name.slice(priority.length);
	const available = Math.max(1, limit - Array.from(priority).length);
	const raw = Array.from(slug).slice(0, available).join("");
	let truncated = raw.replace(/-+$/g, "");
	if (!raw.endsWith("-") && raw.length === available) {
		const lastHyphen = truncated.lastIndexOf("-");
		if (lastHyphen > 0) truncated = truncated.slice(0, lastHyphen);
	}
	truncated = truncated.replace(/-+$/g, "");
	return `${priority}${truncated || "ticket"}`;
}

async function chooseCleanupTarget(
	dir: string,
	stem: string,
	sourcePath: string,
	reserved: Set<string>,
): Promise<string> {
	for (let attempt = 1; attempt <= 999; attempt += 1) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const candidate = join(dir, `${stem}${suffix}.md`);
		if (candidate === sourcePath) return candidate;
		if (!reserved.has(candidate) && !(await pathExists(candidate))) return candidate;
	}
	throw new FitError(
		"NAME_COLLISION",
		`Could not find a free filename for ${stem}.md after 999 attempts.`,
	);
}

/**
 * Rename tickets whose filename stems exceed the configured length. Only the
 * filename changes: status, subdirectory, priority, frontmatter, and body stay
 * put. Existing names are never overwritten, and collisions get suffixes.
 */
export async function cleanupTicketNames(
	board: string,
	options: CleanupTicketNamesOptions = {},
): Promise<CleanupTicketNamesResult> {
	const maxLength = validateNameMaxLength(options.maxLength);
	const dryRun = options.dryRun === true;
	const tickets = await listTickets(board);
	const renamed: CleanupTicketRename[] = [];
	const reserved = new Set<string>();
	let skipped = 0;

	for (const ticket of tickets) {
		const nextStem = truncateTicketName(ticket.name, maxLength);
		if (nextStem === ticket.name) {
			skipped += 1;
			continue;
		}
		const dir = dirname(ticket.path);
		const targetPath = await chooseCleanupTarget(dir, nextStem, ticket.path, reserved);
		const targetId = relative(board, targetPath).split("\\").join("/");
		reserved.add(targetPath);
		if (!dryRun) await moveFile(ticket.path, targetPath);
		renamed.push({ fromId: ticket.id, toId: targetId });
	}

	return { renamed, skipped, maxLength, dryRun };
}

function hasRecordedCommit(frontmatter: Record<string, FrontmatterValue>): boolean {
	for (const [key, value] of Object.entries(frontmatter)) {
		const normalized = key.toLowerCase().replace(/[\s-]+/g, "_");
		if (!["commit", "commit_hash", "commithash", "git_commit", "hash"].includes(normalized)) {
			continue;
		}
		const values = Array.isArray(value) ? value : [value];
		if (values.some((item) => item !== null && String(item).trim() !== "")) return true;
	}
	return false;
}

function closedTicketsCommitMessage(tickets: TicketSummary[]): string {
	const labels = tickets.map((ticket) => ticket.shortName || ticket.name);
	const shown = labels.slice(0, 3);
	const suffix = labels.length > shown.length ? ` (+${labels.length - shown.length} more)` : "";
	return `FIT: close ${shown.join(", ")}${suffix}`;
}

/**
 * Record the parent repository's latest commit on closed tickets that do not
 * already have a commit hash, then commit the board.
 *
 * This deliberately refuses boards that share the parent's working tree or
 * branch: the board must live in a separate repository or a linked worktree on
 * a different branch, so the recorded hash refers to the parent-side work.
 */
export async function recordClosedTicketsCommit(
	board: string,
): Promise<RecordClosedTicketsCommitResult> {
	let inline = false;
	try {
		await inspectBoardGit(board);
	} catch {
		// An inline board is tracked by the parent worktree/branch. Its close move
		// belongs to the work commit, so there is nothing for this tool to record.
		inline = true;
	}

	if (inline) {
		const commitHash = await latestCommitHash(dirname(board)).catch(() => "");
		const closed = (await listTickets(board)).filter((ticket) => ticket.status === "closed");
		return {
			commitHash,
			recorded: [],
			skipped: closed.length,
			commitMessage: "",
			committed: false,
			inline: true,
		};
	}

	let commitHash: string;
	try {
		commitHash = await latestCommitHash(dirname(board));
	} catch (error) {
		throw new FitError(
			"GIT_NOT_AVAILABLE",
			error instanceof Error ? error.message : String(error),
			{ hint: "Initialize the parent repository and make at least one commit first." },
		);
	}

	const closed = (await listTickets(board)).filter((ticket) => ticket.status === "closed");
	const targets: Ticket[] = [];
	let skipped = 0;
	for (const summary of closed) {
		const ticket = await readTicket(board, summary.id);
		if (hasRecordedCommit(ticket.frontmatter)) {
			skipped += 1;
			continue;
		}
		targets.push(ticket);
	}

	if (targets.length === 0) {
		return {
			commitHash,
			recorded: [],
			skipped,
			commitMessage: "",
			committed: false,
			inline: false,
		};
	}

	const commitMessage = closedTicketsCommitMessage(targets);
	for (const target of targets) {
		await updateTicket({
			board,
			id: target.id,
			set: { commit: commitHash },
			expectedRevision: target.revision,
		});
	}

	let committed = false;
	try {
		committed = await commitWorktreePath(board, commitMessage);
	} catch (error) {
		throw new FitError(
			"GIT_COMMIT_FAILED",
			`Recorded ${commitHash} on ${targets.length} closed ticket(s), but the board commit failed.`,
			{ hint: error instanceof Error ? error.message : String(error) },
		);
	}

	return {
		commitHash,
		recorded: targets.map((ticket) => ticket.id),
		skipped,
		commitMessage,
		committed,
		inline: false,
	};
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

export async function updateTicket(input: UpdateTicketInput): Promise<UpdateTicketResult> {
	const mode = await readBoardMode(input.board);
	const previous = await readTicket(input.board, input.id);
	assertRevision(previous, input.expectedRevision);
	const hasFrontmatterChange =
		input.set !== undefined ||
		input.project !== undefined ||
		(input.unset !== undefined && input.unset.length > 0);
	const hasBodyChange = input.body !== undefined;
	const hasRenameChange = input.priority !== undefined || input.slug !== undefined;
	if (!hasFrontmatterChange && !hasBodyChange && !hasRenameChange) {
		throw new FitError(
			"NOTHING_TO_UPDATE",
			"No change requested. Pass body, set/unset frontmatter fields, priority, or slug.",
		);
	}

	let body = previous.body;
	if (hasBodyChange) {
		const nextBody = cleanBody(input.body ?? "");
		body =
			input.bodyMode === "append"
				? [cleanBody(previous.body, false).trimEnd(), nextBody].filter(Boolean).join("\n\n")
				: nextBody;
	}

	let frontmatterRaw = previous.frontmatterRaw;
	if (hasFrontmatterChange) {
		const set = { ...(input.set ?? {}) };
		if (input.project !== undefined) set.project = input.project;
		frontmatterRaw = updateFrontmatterRaw(
			previous.frontmatterRaw,
			set,
			input.unset ?? [],
		);
	}

	const content = composeTicket(frontmatterRaw, body);
	const resolved = await resolveTicketPath(input.board, input.id);
	let targetPath = resolved.path;

	if (hasRenameChange) {
		const priority = validatePriority(input.priority ?? previous.priority ?? 0);
		const baseSlug = input.slug ? slugify(input.slug) : existingSlug(previous);
		const dir = join(input.board, ...previous.status.split("/"));
		if (previous.subdir) {
			targetPath = await chooseTarget(
				input.board,
				join(input.board, ...previous.status.split("/"), ...previous.subdir.split("/")),
				priority,
				baseSlug,
				resolved.path,
			);
		} else {
			targetPath = await chooseTarget(
				input.board,
				dir,
				priority,
				baseSlug,
				resolved.path,
			);
		}
	}

	if (targetPath === resolved.path) {
		if (content === previous.content) {
			return {
				ticket: previous,
				previousId: resolved.id,
				warnings: ticketWarnings(previous.body),
				changed: false,
				mode,
			};
		}
		await assertWritableInsideBoard(input.board, targetPath);
		await atomicWrite(targetPath, content);
	} else {
		await assertWritableInsideBoard(input.board, targetPath);
		// Update the content first, then rename without overwriting. A crash
		// leaves a valid ticket at the old path rather than losing it.
		if (content !== previous.content) await atomicWrite(resolved.path, content);
		await moveFile(resolved.path, targetPath);
	}

	const targetId =
		targetPath === resolved.path
			? resolved.id
			: relative(input.board, targetPath).split("\\").join("/");
	const ticket = await readTicket(input.board, targetId);
	return {
		ticket,
		previousId: resolved.id,
		warnings: ticketWarnings(ticket.body),
		changed: true,
		mode,
	};
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Split a ticket into raw frontmatter and body. Unclosed frontmatter is body. */
export function splitFrontmatter(content: string): { raw: string | null; body: string } {
	const normalized = content.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0] !== "---") return { raw: null, body: normalized };
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index] === "---") {
			return {
				raw: lines.slice(1, index).join("\n"),
				body: lines.slice(index + 1).join("\n"),
			};
		}
	}
	return { raw: null, body: normalized };
}

/**
 * Validate the supported frontmatter YAML subset.
 *
 * Supported: top-level `key: value` mappings, inline `[a, b]` arrays,
 * block `- item` lists under a key, comments, and indented continuation
 * lines that are preserved verbatim. Tabs may not be used for indentation,
 * and top-level sequence entries are invalid because frontmatter is a map.
 */
export function validateFrontmatterYaml(raw: string): string[] {
	const errors: string[] = [];
	const lines = raw.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line === "" || /^\s*#/.test(line)) continue;
		if (/^ *\t/.test(line)) {
			errors.push(`line ${index + 1}: tabs are not allowed for indentation`);
			continue;
		}
		if (/^ +/.test(line)) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			errors.push(`line ${index + 1}: expected a top-level "key: value" mapping`);
			continue;
		}
		const value = match[2].trim();
		if (value.startsWith("[") && !value.endsWith("]")) {
			errors.push(`line ${index + 1}: unterminated inline array`);
		}
	}
	return errors;
}

export function composeTicket(frontmatterRaw: string | null, body: string): string {
	const frontmatter = (frontmatterRaw ?? "").trim();
	const normalizedBody = cleanBody(body);
	let output = "";
	if (frontmatter) output += `---\n${frontmatter}\n---\n`;
	if (normalizedBody) output += `${output ? "\n" : ""}${normalizedBody}\n`;
	else if (output) output += "\n";
	return output;
}

function parseScalar(text: string): FrontmatterScalar {
	let value = text.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (
				parsed === null ||
				typeof parsed === "string" ||
				typeof parsed === "number" ||
				typeof parsed === "boolean"
			) {
				return parsed;
			}
			return value.slice(1, -1);
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	value = value.replace(/\s+#.*$/, "").trim();
	if (value === "" || value === "~" || value.toLowerCase() === "null") return null;
	if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
	return value;
}

function splitInlineArray(inner: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < inner.length; index += 1) {
		const char = inner[index];
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ",") {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) items.push(current.trim());
	return items;
}

function parseValue(text: string): FrontmatterValue {
	const value = text.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return splitInlineArray(inner).map(parseScalar);
	}
	return parseScalar(value);
}

/** Best-effort parse of top-level frontmatter fields. Unknown nesting is kept raw. */
export function parseFrontmatter(raw: string | null): Record<string, FrontmatterValue> {
	const result: Record<string, FrontmatterValue> = {};
	if (!raw) return result;
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		if (/^[ \t]/.test(line)) continue;
		const match = /^([^:#][^:]*?)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1].trim();
		const rest = match[2].trim();
		if (rest === "") {
			const items: FrontmatterScalar[] = [];
			let lookahead = index + 1;
			while (lookahead < lines.length) {
				const candidate = lines[lookahead];
				const item = /^\s*-\s+(.*)$/.exec(candidate);
				if (item) {
					items.push(parseScalar(item[1]));
					lookahead += 1;
					continue;
				}
				if (!candidate.trim()) {
					lookahead += 1;
					continue;
				}
				break;
			}
			if (items.length > 0) {
				result[key] = items;
				index = lookahead - 1;
			} else {
				result[key] = null;
			}
		} else {
			result[key] = parseValue(rest);
		}
	}
	return result;
}

function validateFrontmatterKey(key: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
		throw new FitError(
			"INVALID_FRONTMATTER_KEY",
			`Invalid frontmatter key: ${JSON.stringify(key)}`,
			{ hint: "Use letters, digits, underscore, dot, or hyphen; start with a letter or underscore." },
		);
	}
}

function quoteYamlString(value: string): string {
	const needsQuotes =
		value === "" ||
		/^\s|\s$/.test(value) ||
		/[\n\r\t:#,[\]{}&*!|>'"%@`]/.test(value) ||
		/^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
		/^-?(?:\d|\.\d)/.test(value) ||
		value.startsWith("- ") ||
		value.startsWith("? ") ||
		value.startsWith(": ");
	return needsQuotes ? JSON.stringify(value) : value;
}

function serializeScalar(value: string | number | boolean | null): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new FitError("INVALID_FRONTMATTER_VALUE", "Frontmatter numbers must be finite.");
		}
		return String(value);
	}
	return quoteYamlString(value);
}

export function serializeFrontmatterValue(value: FrontmatterValue): string {
	if (Array.isArray(value)) {
		return `[${value.map(serializeScalar).join(", ")}]`;
	}
	return serializeScalar(value);
}

/**
 * Set/unset top-level frontmatter keys while preserving all unrelated lines,
 * comments, and unknown nested YAML verbatim.
 */
export function updateFrontmatterRaw(
	raw: string | null,
	set: Record<string, FrontmatterValue>,
	unset: string[],
): string | null {
	for (const key of [...Object.keys(set), ...unset]) validateFrontmatterKey(key);
	const touched = new Set([...Object.keys(set), ...unset]);
	const lines = raw ? raw.split("\n") : [];
	const output: string[] = [];
	const applied = new Set<string>();

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(line);
		if (!match || !touched.has(match[1])) {
			output.push(line);
			continue;
		}
		const key = match[1];
		// Consume the key's continuation lines (nested mappings and lists).
		index += 1;
		while (
			index < lines.length &&
			(/^[ \t]/.test(lines[index]) || /^-\s+/.test(lines[index]))
		) {
			index += 1;
		}
		index -= 1;
		if (Object.prototype.hasOwnProperty.call(set, key) && !applied.has(key)) {
			output.push(`${key}: ${serializeFrontmatterValue(set[key])}`);
			applied.add(key);
		}
	}

	for (const key of Object.keys(set).sort()) {
		if (applied.has(key)) continue;
		output.push(`${key}: ${serializeFrontmatterValue(set[key])}`);
	}

	while (output.length > 0 && output[output.length - 1].trim() === "") output.pop();
	const rendered = output.join("\n");
	return rendered ? rendered : null;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function countTickets(tickets: TicketSummary[]): {
	counts: Record<string, number>;
	total: number;
} {
	const counts: Record<string, number> = {};
	for (const status of FIT_STATUSES) counts[status] = 0;
	for (const ticket of tickets) {
		counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
	}
	return { counts, total: tickets.length };
}

// ---------------------------------------------------------------------------
// Migration reporting
// ---------------------------------------------------------------------------

export type MigrationKind =
	| "priority"
	| "short-name"
	| "duplicate-name"
	| "body";

export interface MigrationAction {
	kind: MigrationKind;
	id: string;
	message: string;
	/** Suggested board-relative path after applying every suggestion for this ticket. */
	suggestedId?: string;
	suggestedShortName?: string;
}

export interface MigrationReport {
	board: string;
	mode: BoardMode;
	total: number;
	actions: MigrationAction[];
	/** This reporter is always read-only. */
	dryRun: true;
}

function sentenceCount(text: string): number {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter(Boolean).length;
}

/** Reasons a body does not follow the Strict summary + level-3 section shape. */
function legacyBodyReasons(body: string): string[] {
	const reasons: string[] = [];
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	let inSummary = true;
	let inSection = false;
	let sawSummary = false;
	const summaryLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			if (sawSummary) inSummary = false;
			continue;
		}
		if (inSummary && !trimmed.startsWith("#")) {
			sawSummary = true;
			summaryLines.push(trimmed);
			continue;
		}
		if (inSummary) inSummary = false;
		if (trimmed.startsWith("### ")) {
			inSection = true;
			continue;
		}
		if (/^#{1,2} /.test(trimmed)) {
			reasons.push("uses a level-1 or level-2 heading after the summary");
			inSection = true;
			continue;
		}
		if (!inSection) {
			reasons.push("has content after the summary outside a level-3 section");
		}
	}

	const summary = summaryLines.join(" ").trim();
	if (summary && sentenceCount(summary) > 3) {
		reasons.push(`summary has ${sentenceCount(summary)} sentences; keep 1-3`);
	}
	return [...new Set(reasons)];
}

function uniqueShortName(base: string, taken: Set<string>): string {
	const limit = Math.max(1, MAX_SLUG_CHARS - 1);
	let candidate = truncateSlug(base, limit);
	if (!taken.has(candidate)) return candidate;
	for (let attempt = 2; attempt <= 999; attempt += 1) {
		const suffix = `-${attempt}`;
		candidate = `${truncateSlug(base, Math.max(1, limit - suffix.length))}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${truncateSlug(base, Math.max(1, limit - 4))}-999`;
}

function suggestedTicketId(
	ticket: TicketSummary,
	priority: number,
	shortName: string,
): string {
	const parts = [ticket.status];
	if (ticket.subdir) parts.push(ticket.subdir);
	parts.push(`${String(priority).padStart(2, "0")}-${shortName}.md`);
	return parts.join("/");
}

/**
 * Read-only migration report for boards moving to the v0.5 Strict rules.
 *
 * It only reports; it never renames or rewrites anything. Each action carries a
 * concrete suggestion where one can be derived safely.
 */
export async function migrationReport(board: string): Promise<MigrationReport> {
	if (!(await isDirectory(board))) {
		throw new FitError("BOARD_NOT_FOUND", `FIT board not found: ${board}`, {
			hint: "Run fit_init to create ./fit, or pass the correct board path.",
		});
	}
	const mode = await readBoardMode(board);
	const tickets = await listTickets(board, mode);
	const actions: MigrationAction[] = [];

	interface Planned {
		ticket: TicketSummary;
		priority: number;
		shortName: string;
		priorityChanged: boolean;
		shortNameChanged: boolean;
	}

	const planned: Planned[] = [];
	for (const ticket of tickets) {
		let priority = ticket.priority ?? 0;
		let shortName = ticket.shortName;
		let priorityChanged = false;
		let shortNameChanged = false;

		const digits = /^(\d{3,})-/.exec(ticket.name)?.[1];
		if (digits !== undefined) {
			const suggestion = String(Number(digits.slice(0, 2))).padStart(2, "0");
			priority = Number(suggestion);
			shortName = ticket.name.slice(digits.length + 1);
			priorityChanged = true;
			actions.push({
				kind: "priority",
				id: ticket.id,
				message: `Priority prefix "${digits}" is not two digits; suggest "${suggestion}" (00-99).`,
			});
		}

		if (Array.from(shortName).length >= MAX_SLUG_CHARS) {
			shortName = truncateSlug(shortName, MAX_SLUG_CHARS - 1);
			shortNameChanged = true;
			actions.push({
				kind: "short-name",
				id: ticket.id,
				message: `Short name is ${Array.from(ticket.shortName).length} characters; suggest "${shortName}" (under ${MAX_SLUG_CHARS}).`,
				suggestedShortName: shortName,
			});
		}

		planned.push({
			ticket,
			priority,
			shortName,
			priorityChanged,
			shortNameChanged,
		});
	}

	// Resolve name collisions against the final suggestions, keeping document order.
	const taken = new Set<string>();
	for (const entry of planned) {
		if (taken.has(entry.shortName)) {
			const replacement = uniqueShortName(entry.shortName, taken);
			entry.shortName = replacement;
			entry.shortNameChanged = true;
		}
		taken.add(entry.shortName);
	}

	const nameCounts = new Map<string, string[]>();
	for (const ticket of tickets) {
		const ids = nameCounts.get(ticket.shortName) ?? [];
		ids.push(ticket.id);
		nameCounts.set(ticket.shortName, ids);
	}

	for (const entry of planned) {
		const duplicates = nameCounts.get(entry.ticket.shortName) ?? [];
		if (duplicates.length > 1) {
			actions.push({
				kind: "duplicate-name",
				id: entry.ticket.id,
				message: `Short name "${entry.ticket.shortName}" is shared by ${duplicates.join(", ")}; rename, merge, or delete one.`,
				suggestedShortName:
					entry.shortName === entry.ticket.shortName
						? undefined
						: entry.shortName,
			});
		}

		if (entry.priorityChanged || entry.shortNameChanged) {
			for (const action of actions) {
				if (action.id !== entry.ticket.id) continue;
				action.suggestedId = suggestedTicketId(
					entry.ticket,
					entry.priority,
					entry.shortName,
				);
			}
		}
	}

	for (const ticket of tickets) {
		const content = await readFile(ticket.path, "utf8");
		const { body } = splitFrontmatter(content);
		const reasons = legacyBodyReasons(body);
		if (reasons.length === 0) continue;
		actions.push({
			kind: "body",
			id: ticket.id,
			message: `Legacy body: ${reasons.join("; ")}. Keep a 1-3 sentence summary and put the rest under ### headers.`,
		});
	}

	const kindOrder: Record<MigrationKind, number> = {
		priority: 0,
		"short-name": 1,
		"duplicate-name": 2,
		body: 3,
	};
	actions.sort(
		(a, b) =>
			kindOrder[a.kind] - kindOrder[b.kind] ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);

	return { board, mode, total: tickets.length, actions, dryRun: true };
}

// ---------------------------------------------------------------------------
// Body normalization
// ---------------------------------------------------------------------------

export interface NormalizeLegacyBodiesOptions {
	/** Report what would change without writing anything. */
	dryRun?: boolean;
}

export interface NormalizedBody {
	id: string;
	body: string;
}

export interface NormalizeLegacyBodiesResult {
	changed: NormalizedBody[];
	dryRun: boolean;
}

function splitSummaryAndRest(body: string): { summary: string[]; rest: string[] } {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const summary: string[] = [];
	let index = 0;
	while (index < lines.length && lines[index].trim() === "") index += 1;
	for (; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		if (trimmed === "" || trimmed.startsWith("#")) break;
		summary.push(trimmed);
	}
	while (index < lines.length && lines[index].trim() === "") index += 1;
	return { summary, rest: lines.slice(index) };
}

function splitSentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.split(/(?<=[.!?])\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Rewrite one legacy body into the Strict shape without changing its wording:
 * the first one to three sentences stay as the summary, and everything else
 * moves under level-3 headers.
 */
export function normalizeBodyForStrict(body: string): string {
	const { summary, rest } = splitSummaryAndRest(body);
	let summaryText = summary.join(" ").trim();
	let overflow = "";
	if (summaryText) {
		const sentences = splitSentences(summaryText);
		if (sentences.length > 3) {
			summaryText = sentences.slice(0, 3).join(" ");
			overflow = sentences.slice(3).join(" ");
		}
	}

	let restText = rest.join("\n").trim();
	if (restText) {
		restText = restText.replace(/^(#{1,2})(\s+)/gm, "###$2");
	}
	if (overflow) {
		restText = [`### Notes`, "", overflow, restText].filter(Boolean).join("\n\n");
	}
	if (restText) {
		const firstLine = restText.split("\n").find((line) => line.trim() !== "") ?? "";
		if (!firstLine.startsWith("### ")) {
			restText = `### Notes\n\n${restText}`;
		}
	}

	return [summaryText, restText]
		.filter(Boolean)
		.join("\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Rewrite legacy bodies on a board into the Strict summary + ### shape.
 * Dry-run by default at the call site; this helper reports every change it
 * would make and never renames files.
 */
export async function normalizeLegacyBodies(
	board: string,
	options: NormalizeLegacyBodiesOptions = {},
): Promise<NormalizeLegacyBodiesResult> {
	const dryRun = options.dryRun === true;
	const mode = await readBoardMode(board);
	const tickets = await listTickets(board, mode);
	const changed: NormalizedBody[] = [];
	for (const ticket of tickets) {
		const content = await readFile(ticket.path, "utf8");
		const { body } = splitFrontmatter(content);
		if (legacyBodyReasons(body).length === 0) continue;
		const normalized = normalizeBodyForStrict(body);
		if (normalized === body) continue;
		if (!dryRun) {
			await updateTicket({
				board,
				id: ticket.id,
				body: normalized,
				expectedRevision: revisionOf(content),
			});
		}
		changed.push({ id: ticket.id, body: normalized });
	}
	return { changed, dryRun };
}

// ---------------------------------------------------------------------------
// Board checks
// ---------------------------------------------------------------------------

export type CheckMode = "basic" | "strict";

export type CheckSeverity = "error" | "warning";

/**
 * Machine-readable rule registry. Every issue carries the rule id in `code`.
 * A rule runs only in the modes listed in `severity`; an `error` severity means
 * the rule is required in that mode, while `warning` means it is optional.
 */
export interface CheckRule {
	id: string;
	description: string;
	severity: Partial<Record<CheckMode, CheckSeverity>>;
}

export const CHECK_RULES: readonly CheckRule[] = [
	{
		id: "MISSING_STATUS_DIR",
		description: "All four canonical status directories exist.",
		severity: { basic: "error", strict: "error" },
	},
	{
		id: "MISSING_PRIORITY",
		description: "Ticket filenames carry an NN- priority prefix.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "NON_TWO_DIGIT_PRIORITY",
		description: "Ticket priorities use exactly two digits.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "TICKET_FILENAME_FORMAT",
		description: "Ticket filenames match NN-lowercase-name.md with a two-digit priority.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "TICKET_FILENAME_SAFE",
		description: "Ticket filenames avoid URL-illegal and OS-reserved names.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "TICKET_SHORT_NAME_LENGTH",
		description: "Ticket short names stay under 30 characters.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "TICKET_NAME_UNIQUE",
		description: "Ticket short-name identities are unique across the board.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "TICKET_BODY_SECTIONS",
		description: "Body content after the summary lives under level-3 headers.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "TICKET_SUMMARY_LENGTH",
		description: "Body summaries stay within one to three sentences.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "UNCLOSED_FRONTMATTER",
		description: "Frontmatter opened with --- is closed with ---.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "INVALID_YAML",
		description: "Frontmatter uses the supported YAML subset.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "STRUCTURAL_FRONTMATTER",
		description: "Frontmatter does not duplicate path-derived structural data.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "INVALID_FRONTMATTER_VALUE",
		description: "Defined frontmatter keys use the expected value formats.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "ROOT_MARKDOWN",
		description: "Markdown outside a status directory is not mistaken for a ticket.",
		severity: { basic: "warning", strict: "warning" },
	},
	{
		id: "ARCHIVE_RECORD_INVALID",
		description: "Archive records use the documented header and fence format.",
		severity: { basic: "warning", strict: "error" },
	},
	{
		id: "STRICT_MARKER_MALFORMED",
		description: "STRICT contains exactly the quoted spec version.",
		severity: { strict: "error" },
	},
	{
		id: "STRICT_VERSION_NEWER",
		description: "STRICT declares a newer version than this tool implements.",
		severity: { strict: "warning" },
	},
	{
		id: "STRICT_VERSION_UNKNOWN",
		description: "STRICT declares an unknown version.",
		severity: { strict: "warning" },
	},
	{
		id: "STRICT_BOARD_NAME",
		description: "A Strict board directory is named fit.",
		severity: { strict: "error" },
	},
	{
		id: "STRICT_BOARD_LOCATION",
		description: "A Strict board is at the repository root or outside a repository.",
		severity: { strict: "error" },
	},
	{
		id: "STRICT_EXTRA_STATUS",
		description: "A Strict board has no extra top-level status directories.",
		severity: { strict: "error" },
	},
	{
		id: "STRICT_STATUS_FILE",
		description: "Status directories contain only tickets, .gitkeep, images, and archive.txt.",
		severity: { strict: "error" },
	},
	{
		id: "NON_CANONICAL_STATUS",
		description: "Tickets live inside a canonical status directory.",
		severity: { strict: "error" },
	},
	{
		id: "IN_PROGRESS_LIMIT",
		description: "At most one ticket is in_progress per checkout.",
		severity: { strict: "error" },
	},
];

const CHECK_RULES_BY_ID = new Map(CHECK_RULES.map((rule) => [rule.id, rule]));

/** Severity for a rule in a mode, or undefined when the rule is skipped. */
export function checkRuleSeverity(
	id: string,
	mode: CheckMode,
): CheckSeverity | undefined {
	return CHECK_RULES_BY_ID.get(id)?.severity[mode];
}

export interface BoardIssue {
	severity: CheckSeverity;
	code: string;
	id?: string;
	message: string;
}

export interface BoardCheckResult {
	board: string;
	mode: BoardMode;
	total: number;
	counts: Record<string, number>;
	issues: BoardIssue[];
}

function isIso8601(value: FrontmatterValue): boolean {
	if (typeof value !== "string") return false;
	const pattern =
		/^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
	if (!pattern.test(value) || Number.isNaN(Date.parse(value))) return false;
	const [year, month, day] = value.slice(0, 10).split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

function isCommitHash(value: FrontmatterValue): boolean {
	return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);
}

function isScalar(value: FrontmatterValue): boolean {
	return !Array.isArray(value) && value !== null;
}

function compareVersions(a: string, b: string): number | null {
	if (!/^\d+(?:\.\d+)*$/.test(a) || !/^\d+(?:\.\d+)*$/.test(b)) return null;
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function findRepositoryRoot(start: string): Promise<string | null> {
	let current = resolve(start);
	while (true) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

const STRICT_IMAGE_EXTENSIONS = new Set([
	".avif",
	".bmp",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".svg",
	".webp",
]);

function isAllowedStrictStatusFile(relFile: string): boolean {
	const name = basename(relFile);
	if (name === ".gitkeep") return true;
	if (relFile === "closed/archive.txt") return true;
	if (name.toLowerCase().endsWith(".md")) return true;
	const dot = name.lastIndexOf(".");
	return dot >= 0 && STRICT_IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

const WINDOWS_RESERVED_NAMES =
	/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const URL_ILLEGAL_CHARS = /[#%&{}$!'"@+`=~^()\[\];,|\\ ]/;

/**
 * Filename safety problems that apply across Windows, macOS, Linux, and URLs.
 * Returns human-readable reasons; an empty list means the name is safe.
 */
export function ticketFilenameProblems(filename: string): string[] {
	const problems: string[] = [];
	const stem = filename.replace(/\.md$/i, "");
	if (/[<>:"/\\|?*\u0000-\u001f]/.test(filename)) {
		problems.push("contains a character that is illegal on Windows or macOS");
	}
	if (URL_ILLEGAL_CHARS.test(filename)) {
		problems.push("contains a URL-illegal character");
	}
	if (/[. ]$/.test(stem)) {
		problems.push("ends with a dot or space, which Windows strips");
	}
	if (WINDOWS_RESERVED_NAMES.test(stem)) {
		problems.push("uses a reserved Windows device name");
	}
	if (Array.from(filename).length > 255) {
		problems.push("is longer than the 255-character filesystem limit");
	}
	if (stem.startsWith(" ") || stem.endsWith(" ")) {
		problems.push("has leading or trailing whitespace");
	}
	return problems;
}

async function walkAllFiles(
	root: string,
	relDir: string,
	out: string[],
): Promise<void> {
	const dir = relDir ? join(root, ...relDir.split("/")) : root;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) await walkAllFiles(root, rel, out);
		else if (entry.isFile()) out.push(rel);
	}
}

/** Read-only validation of board invariants and spec conventions. */
export async function checkBoard(board: string): Promise<BoardCheckResult> {
	if (!(await isDirectory(board))) {
		throw new FitError("BOARD_NOT_FOUND", `FIT board not found: ${board}`, {
			hint: "Run fit_init to create ./fit, or pass the correct board path.",
		});
	}
	const mode = await readBoardMode(board);
	const checkMode = mode.mode;
	const issues: BoardIssue[] = [];

	// Every rule declares its severity per mode; skipped rules never report.
	const emit = (code: string, message: string, id?: string): void => {
		const severity = checkRuleSeverity(code, checkMode);
		if (severity === undefined) return;
		issues.push(id === undefined ? { severity, code, message } : { severity, code, id, message });
	};

	// Basic rules always run. Strict rules are added only for a STRICT board.
	if (checkMode === "strict") {
		if (mode.version === null) {
			emit(
				"STRICT_MARKER_MALFORMED",
				`STRICT must contain exactly the quoted version string, e.g. "${FIT_SPEC_VERSION}".`,
			);
		} else {
			const comparison = compareVersions(mode.version, FIT_SPEC_VERSION);
			if (comparison !== 0) {
				emit(
					comparison !== null && comparison > 0
						? "STRICT_VERSION_NEWER"
						: "STRICT_VERSION_UNKNOWN",
					`STRICT declares version ${mode.version}; this tool implements ${FIT_SPEC_VERSION} and applies the ${FIT_SPEC_VERSION} rules.`,
				);
			}
		}
		if (basename(resolve(board)) !== "fit") {
			emit("STRICT_BOARD_NAME", 'A Strict board directory must be named "fit".');
		}
		const repoRoot = await findRepositoryRoot(dirname(board));
		if (repoRoot && resolve(repoRoot) !== resolve(dirname(board))) {
			emit(
				"STRICT_BOARD_LOCATION",
				`A Strict board must be at the repository root or outside a repository; found it under ${repoRoot}.`,
			);
		}
		let rootEntries: Dirent[];
		try {
			rootEntries = await readdir(board, { withFileTypes: true });
		} catch {
			rootEntries = [];
		}
		for (const entry of rootEntries) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			if (!(FIT_STATUSES as readonly string[]).includes(entry.name)) {
				emit(
					"STRICT_EXTRA_STATUS",
					`Strict boards must not have extra top-level status directories: ${entry.name}`,
				);
			}
		}
		const statusFiles: string[] = [];
		for (const entry of rootEntries) {
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				await walkAllFiles(board, entry.name, statusFiles);
			}
		}
		for (const relFile of statusFiles) {
			if (!isAllowedStrictStatusFile(relFile)) {
				emit(
					"STRICT_STATUS_FILE",
					`Strict status directories allow only .md, .gitkeep, images, and closed/archive.txt; found ${relFile}.`,
					relFile,
				);
			}
		}
	}

	for (const status of FIT_STATUSES) {
		if (!(await isDirectory(join(board, status)))) {
			emit("MISSING_STATUS_DIR", `Missing status directory: ${status}`);
		}
	}

	const tickets = await listTickets(board, mode);
	const { counts, total } = countTickets(tickets);
	const seenNames = new Map<string, string[]>();

	for (const ticket of tickets) {
		if (
			checkMode === "strict" &&
			!(FIT_STATUSES as readonly string[]).includes(ticket.status)
		) {
			emit(
				"NON_CANONICAL_STATUS",
				`Ticket is not inside a canonical status directory: ${ticket.status}`,
				ticket.id,
			);
		}
		const priorityPrefix = /^(\d+)-/.exec(ticket.filename)?.[1];
		if (priorityPrefix === undefined) {
			emit("MISSING_PRIORITY", "Filename has no NN- priority prefix.", ticket.id);
		} else if (priorityPrefix.length !== 2) {
			emit(
				"NON_TWO_DIGIT_PRIORITY",
				`Priority prefix must be exactly two digits, not ${priorityPrefix.length}.`,
				ticket.id,
			);
		}
		const formatOk = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(ticket.filename);
		if (!formatOk) {
			emit(
				"TICKET_FILENAME_FORMAT",
				"Filename must be NN-lowercase-hyphenated-name.md with a two-digit priority (00-99).",
				ticket.id,
			);
		}
		const safetyProblems = ticketFilenameProblems(ticket.filename);
		if (safetyProblems.length > 0) {
			emit(
				"TICKET_FILENAME_SAFE",
				`Filename is unsafe: ${safetyProblems.join("; ")}.`,
				ticket.id,
			);
		}
		if (Array.from(ticket.shortName).length >= MAX_SLUG_CHARS) {
			emit(
				"TICKET_SHORT_NAME_LENGTH",
				`Short name is ${Array.from(ticket.shortName).length} characters; keep it under ${MAX_SLUG_CHARS}.`,
				ticket.id,
			);
		}
		const content = await readFile(ticket.path, "utf8");
		const split = splitFrontmatter(content);
		const firstLine = content.replace(/\r\n?/g, "\n").split("\n")[0];
		if (firstLine === "---" && split.raw === null) {
			emit(
				"UNCLOSED_FRONTMATTER",
				"File starts with --- but the frontmatter is not closed.",
				ticket.id,
			);
		}
		if (split.raw !== null) {
			for (const error of validateFrontmatterYaml(split.raw)) {
				emit(
					"INVALID_YAML",
					`Frontmatter is outside the supported YAML subset: ${error}.`,
					ticket.id,
				);
			}
		}
		const frontmatter = split.raw === null ? {} : parseFrontmatter(split.raw);
		for (const key of ["status", "priority", "name", "id", "path"]) {
			if (frontmatter[key] !== undefined) {
				emit(
					"STRUCTURAL_FRONTMATTER",
					`Frontmatter key "${key}" duplicates structural data (status/priority/name/id are derived from the path).`,
					ticket.id,
				);
			}
		}
		const definedKeys: Array<{
			key: string;
			valid: (value: FrontmatterValue) => boolean;
			expected: string;
		}> = [
			{ key: "completed", valid: isIso8601, expected: "an ISO-8601 date or datetime" },
			{ key: "commit", valid: isCommitHash, expected: "a 7-64 character hexadecimal commit hash" },
			{ key: "project", valid: isScalar, expected: "a scalar value" },
		];
		for (const { key, valid, expected } of definedKeys) {
			const value = frontmatter[key];
			if (value === undefined || valid(value)) continue;
			emit(
				"INVALID_FRONTMATTER_VALUE",
				`Frontmatter key "${key}" must be ${expected}.`,
				ticket.id,
			);
		}
		const bodyReasons = legacyBodyReasons(split.body);
		const sectionReasons = bodyReasons.filter(
			(reason) => !reason.startsWith("summary has"),
		);
		if (sectionReasons.length > 0) {
			emit(
				"TICKET_BODY_SECTIONS",
				`Body ${sectionReasons.join("; ")}. Put everything after the summary under ### headers.`,
				ticket.id,
			);
		}
		const summaryReasons = bodyReasons.filter((reason) =>
			reason.startsWith("summary has"),
		);
		if (summaryReasons.length > 0) {
			emit("TICKET_SUMMARY_LENGTH", `Body ${summaryReasons.join("; ")}.`, ticket.id);
		}
		const list = seenNames.get(ticket.shortName) ?? [];
		list.push(ticket.id);
		seenNames.set(ticket.shortName, list);
	}

	for (const [shortName, ids] of seenNames) {
		if (ids.length > 1) {
			emit(
				"TICKET_NAME_UNIQUE",
				`Short name "${shortName}" is used by ${ids.length} tickets (${ids.join(", ")}); identities must be unique.`,
			);
		}
	}

	if (checkMode === "strict") {
		const inProgress = tickets.filter((ticket) => ticket.status === "in_progress");
		if (inProgress.length > 1) {
			emit(
				"IN_PROGRESS_LIMIT",
				`in_progress contains ${inProgress.length} tickets; only one is allowed per checkout.`,
			);
		}
	}

	let rootEntries: Dirent[];
	try {
		rootEntries = await readdir(board, { withFileTypes: true });
	} catch {
		rootEntries = [];
	}
	for (const entry of rootEntries) {
		if (
			entry.isFile() &&
			entry.name.toLowerCase().endsWith(".md") &&
			entry.name !== "FIT_SPEC.md"
		) {
			emit(
				"ROOT_MARKDOWN",
				`Markdown file outside a status directory is not a ticket: ${entry.name}`,
			);
		}
	}

	const archiveContent = await readOptionalFile(join(board, "closed", "archive.txt"));
	if (archiveContent !== null) {
		const parsed = parseArchiveContent(archiveContent);
		for (const error of parsed.errors) {
			emit(
				"ARCHIVE_RECORD_INVALID",
				`Archive record is malformed: ${error}.`,
				"closed/archive.txt",
			);
		}
		const boardName = basename(resolve(board));
		for (const record of parsed.records) {
			const expectedPrefix = `${boardName}/`;
			if (!record.path.startsWith(expectedPrefix) || !record.path.endsWith(".md")) {
				emit(
					"ARCHIVE_RECORD_INVALID",
					`Archive record path must start with "${expectedPrefix}" and end with .md: ${record.path}`,
					"closed/archive.txt",
				);
			}
		}
	}

	return { board, mode, total, counts, issues };
}
