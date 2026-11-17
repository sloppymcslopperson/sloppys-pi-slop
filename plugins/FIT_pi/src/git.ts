/**
 * Git integration for FIT boards.
 *
 * The board lives in an orphan branch of the parent repository, checked out as
 * a linked worktree. The parent branch ignores the board directory.
 */

import { execFile } from "node:child_process";
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	rename,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { readFitConf, resolveGitIdentity } from "./conf.ts";

const execFileAsync = promisify(execFile);

export function boardIgnorePattern(board: string, repoRoot?: string): string {
	const root = repoRoot ?? dirname(board);
	const rel = relative(root, board).split(/[\\/]/).join("/");
	return `/${rel}/`;
}

export interface MergedGitignore {
	content: string;
	changed: boolean;
}

/** Add the board pattern to a .gitignore without duplicating an equivalent. */
export function mergeGitignoreContent(
	existing: string | null,
	board: string,
	repoRoot?: string,
): MergedGitignore {
	const pattern = boardIgnorePattern(board, repoRoot);
	const rel = pattern.slice(1, -1);
	const equivalents = new Set([
		pattern,
		pattern.slice(1),
		pattern.slice(0, -1),
		rel,
	]);
	const eol = existing?.includes("\r\n") ? "\r\n" : "\n";

	if (existing === null) return { content: `${pattern}${eol}`, changed: true };
	const lines = existing.split(/\r?\n/);
	if (lines.some((line) => equivalents.has(line.trim()))) {
		return { content: existing, changed: false };
	}

	const trimmed = existing.replace(/\s+$/, "");
	const content = trimmed
		? `${trimmed}${eol}${pattern}${eol}`
		: `${pattern}${eol}`;
	return { content, changed: true };
}

export type GitConflictChoice = "branch" | "local";
export type GitConflictResolver = (
	ticket: string,
) => Promise<GitConflictChoice | undefined>;

export interface BoardGitSetupOptions {
	branch?: string;
	resolveConflict?: GitConflictResolver;
}

export interface BoardGitSetup {
	branch: string;
	branchCreated: boolean;
	worktreeCreated: boolean;
	mergedTickets: string[];
	keptBranchTickets: string[];
	/** Previous board contents retained in the parent repo's Git directory. */
	backupPath?: string;
}

export class GitMergeConflictError extends Error {
	readonly conflicts: string[];
	readonly backupPath: string | undefined;

	constructor(conflicts: string[], backupPath: string | undefined) {
		super(`Unresolved FIT ticket conflicts: ${conflicts.join(", ")}`);
		this.name = "GitMergeConflictError";
		this.conflicts = conflicts;
		this.backupPath = backupPath;
	}
}

export interface BoardGitLayout {
	parentRoot: string;
	boardRoot: string;
	parentGitDir: string;
	boardGitDir: string;
	parentBranch: string;
	boardBranch: string;
}

/**
 * Validate that the board is separate from the parent checkout. The board may
 * be a separate repository or a linked worktree on a different branch, but it
 * must not share the parent's working tree or branch.
 */
export async function inspectBoardGit(board: string): Promise<BoardGitLayout> {
	const parentDir = dirname(board);
	let parentRoot: string;
	let parentGitDir: string;
	let parentBranch: string;
	let boardRoot: string;
	let boardGitDir: string;
	let boardBranch: string;
	try {
		parentRoot = (await git(parentDir, ["rev-parse", "--show-toplevel"])).trim();
		parentGitDir = (await git(parentDir, ["rev-parse", "--absolute-git-dir"])).trim();
		parentBranch = (await git(parentDir, ["branch", "--show-current"])).trim();
		boardRoot = (await git(board, ["rev-parse", "--show-toplevel"])).trim();
		boardGitDir = (await git(board, ["rev-parse", "--absolute-git-dir"])).trim();
		boardBranch = (await git(board, ["branch", "--show-current"])).trim();
	} catch {
		throw new Error(
			"The FIT board or its parent directory is not inside a Git repository.",
		);
	}

	if (resolve(boardRoot) === resolve(parentRoot)) {
		throw new Error(
			"The FIT board shares the parent repository's working tree. /fit git needs a separate board worktree or repository.",
		);
	}

	if (
		resolve(boardGitDir) === resolve(parentGitDir) &&
		boardBranch === parentBranch
	) {
		throw new Error(
			"The FIT board is on the same branch as the parent. /fit git needs the board on a different branch.",
		);
	}

	return {
		parentRoot,
		boardRoot,
		parentGitDir,
		boardGitDir,
		parentBranch,
		boardBranch,
	};
}

async function git(
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env,
		windowsHide: true,
		maxBuffer: 10 * 1024 * 1024,
	});
	return stdout.toString();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isWorktreeOnBranch(board: string, branch: string): Promise<boolean> {
	try {
		const root = (await git(board, ["rev-parse", "--show-toplevel"])).trim();
		const head = (await git(board, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
		return resolve(root) === resolve(board) && head === branch;
	} catch {
		return false;
	}
}

async function findParentRepo(board: string): Promise<string> {
	try {
		const root = (await git(dirname(board), ["rev-parse", "--show-toplevel"])).trim();
		return resolve(root);
	} catch {
		throw new Error(
			"The board is not inside a Git repository. Initialize the parent repository first.",
		);
	}
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
	try {
		await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function listLocalTickets(root: string): Promise<string[]> {
	const tickets: string[] = [];

	async function walk(dir: string, prefix: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name === ".git" || entry.isSymbolicLink()) continue;
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(join(dir, entry.name), rel);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				// Root-level Markdown is the spec, not a ticket.
				if (rel.includes("/")) tickets.push(rel);
			}
		}
	}

	await walk(root, "");
	return tickets;
}

async function commitBoard(board: string, message: string): Promise<void> {
	await commitWorktreePath(board, message);
}

/**
 * Extra `git -c ...` arguments for a configured commit identity.
 * `conf.toml` in the board may set `[git] name` and `[git] email`; when both
 * are present they override the repository/system identity for FIT commits.
 */
async function commitIdentityArgs(board: string): Promise<string[]> {
	const identity = resolveGitIdentity(await readFitConf(board));
	if (!identity.name || !identity.email) return [];
	return [
		"-c",
		`user.name=${identity.name}`,
		"-c",
		`user.email=${identity.email}`,
	];
}

/**
 * Stage and commit everything under a path. Returns false when there is
 * nothing to commit. The caller decides which directory the commit belongs to.
 */
export async function commitWorktreePath(path: string, message: string): Promise<boolean> {
	await git(path, ["add", "-A", "--", "."]);
	try {
		await git(path, ["diff", "--cached", "--quiet", "--", "."]);
		return false;
	} catch {
		// There are staged changes under this path.
	}
	const identity = await commitIdentityArgs(path);
	await git(path, [...identity, "commit", "-m", message]);
	return true;
}

/**
 * Read the latest commit from the repository containing `dir`. For a board
 * checked out as a linked worktree, pass the parent directory so this resolves
 * the parent branch rather than the board branch.
 */
export async function latestCommitHash(dir: string): Promise<string> {
	try {
		return (await git(dir, ["rev-parse", "HEAD"])).trim();
	} catch {
		throw new Error(
			"Could not read the latest commit from the parent Git repository.",
		);
	}
}

async function mergeLocalTickets(
	localRoot: string,
	board: string,
	resolveConflict: GitConflictResolver | undefined,
): Promise<{ mergedTickets: string[]; keptBranchTickets: string[] }> {
	const localTickets = await listLocalTickets(localRoot);
	const conflicts: string[] = [];
	const keptBranchTickets: string[] = [];
	const toCopy: string[] = [];

	for (const ticket of localTickets) {
		if (!(await pathExists(join(board, ...ticket.split("/"))))) {
			toCopy.push(ticket);
			continue;
		}
		const choice = await resolveConflict?.(ticket);
		if (choice === "local") toCopy.push(ticket);
		else if (choice === "branch") keptBranchTickets.push(ticket);
		else conflicts.push(ticket);
	}

	if (conflicts.length > 0) throw new GitMergeConflictError(conflicts, localRoot);

	for (const ticket of toCopy) {
		const target = join(board, ...ticket.split("/"));
		await mkdir(dirname(target), { recursive: true });
		await copyFile(join(localRoot, ...ticket.split("/")), target);
	}
	if (toCopy.length > 0) {
		await commitBoard(board, "Merge local FIT tickets");
	}

	return { mergedTickets: toCopy, keptBranchTickets };
}

async function createBranchFromBoard(
	repo: string,
	board: string,
	branch: string,
): Promise<void> {
	const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
	const tempDir = await mkdtemp(join(tmpdir(), "fit-branch-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, "index") };
	const run = (args: string[]) =>
		git(board, ["--git-dir", gitDir, "--work-tree", board, ...args], env);

	try {
		await run(["add", "-A", "."]);
		const tree = (await run(["write-tree"])).trim();
		const identity = await commitIdentityArgs(board);
		const commit = (
			await run([
				...identity,
				"commit-tree",
				tree,
				"-m",
				"Initialize FIT board branch",
			])
		).trim();
		await git(repo, ["branch", branch, commit]);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Ensure the board is a linked worktree of the parent repo on `branch`.
 * If the branch is new, its first commit is built from the current board.
 * If the branch already exists, its contents replace the board directory and
 * the previous contents are retained under the parent repo's Git directory.
 */
export async function ensureBoardBranchWorktree(
	board: string,
	options: BoardGitSetupOptions = {},
): Promise<BoardGitSetup> {
	const branch = options.branch ?? "fit";
	if (await isWorktreeOnBranch(board, branch)) {
		return {
			branch,
			branchCreated: false,
			worktreeCreated: false,
			mergedTickets: [],
			keptBranchTickets: [],
		};
	}

	const repo = await findParentRepo(board);
	const existed = await branchExists(repo, branch);
	if (!existed) await createBranchFromBoard(repo, board, branch);

	const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
	await git(repo, ["worktree", "prune"]).catch(() => undefined);

	let backupPath: string | undefined;
	if (await pathExists(board)) {
		backupPath = join(
			gitDir,
			`fit-init-backup-${Date.now()}-${process.pid}`,
		);
		await rename(board, backupPath);
	}

	try {
		await git(repo, ["worktree", "add", board, branch]);
	} catch (error) {
		await rm(board, { recursive: true, force: true }).catch(() => undefined);
		if (backupPath) {
			await rename(backupPath, board).catch(() => undefined);
		}
		throw error;
	}

	let mergedTickets: string[] = [];
	let keptBranchTickets: string[] = [];
	if (existed && backupPath) {
		try {
			const merged = await mergeLocalTickets(
				backupPath,
				board,
				options.resolveConflict,
			);
			mergedTickets = merged.mergedTickets;
			keptBranchTickets = merged.keptBranchTickets;
		} catch (error) {
			if (!(error instanceof GitMergeConflictError)) throw error;
			// Leave the local board untouched when the user has not resolved a
			// conflict. The next run can ask again.
			try {
				await git(repo, ["worktree", "remove", "--force", board]);
				await rename(backupPath, board);
				backupPath = undefined;
				throw new GitMergeConflictError(error.conflicts, undefined);
			} catch (restoreError) {
				if (restoreError instanceof GitMergeConflictError) throw restoreError;
				throw error;
			}
		}
	} else if (backupPath) {
		await rm(backupPath, { recursive: true, force: true });
		backupPath = undefined;
	}

	return {
		branch,
		branchCreated: !existed,
		worktreeCreated: true,
		mergedTickets,
		keptBranchTickets,
		backupPath,
	};
}
