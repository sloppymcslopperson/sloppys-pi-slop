import { parseArgs } from "node:util";

import type { FrontmatterValue } from "./fit.ts";

/** A CLI syntax error. These exit with status 2 instead of 1. */
export class UsageError extends Error {
	code = "USAGE";
	readonly hint?: string;

	constructor(message: string, hint?: string) {
		super(message);
		this.name = "UsageError";
		this.hint = hint;
	}
}

const CLI_OPTIONS = {
	board: { type: "string", short: "b" },
	json: { type: "boolean" },
	status: { type: "string" },
	prefix: { type: "string" },
	limit: { type: "string" },
	all: { type: "boolean" },
	slug: { type: "string" },
	title: { type: "string" },
	project: { type: "string" },
	set: { type: "string", multiple: true },
	unset: { type: "string", multiple: true },
	body: { type: "string" },
	"body-file": { type: "string" },
	append: { type: "string" },
	"append-file": { type: "string" },
	priority: { type: "string" },
	"expected-revision": { type: "string" },
	strict: { type: "boolean" },
	refresh: { type: "boolean" },
	git: { type: "boolean" },
	"dry-run": { type: "boolean" },
	help: { type: "boolean", short: "h" },
	version: { type: "boolean", short: "v" },
} as const;

export type CliValues = ReturnType<typeof parseCliArgs>["values"];

export function parseCliArgs(argv: string[]): {
	values: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>>["values"];
	positionals: string[];
} {
	try {
		return parseArgs({
			args: argv,
			options: CLI_OPTIONS,
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		throw new UsageError(
			error instanceof Error ? error.message : String(error),
			"Run pi-fit --help for usage.",
		);
	}
}

function parseInteger(value: string, name: string): number {
	if (!/^-?\d+$/.test(value)) {
		throw new UsageError(`${name} must be an integer, got "${value}".`);
	}
	return Number(value);
}

export function parsePriority(value: string | undefined, fallback = 0): number {
	if (value === undefined) return fallback;
	const priority = parseInteger(value, "Priority");
	if (priority < 0 || priority > 99) {
		throw new UsageError("Priority must be an integer between 0 and 99.");
	}
	return priority;
}

export function parseNameMaxLength(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const maxLength = parseInteger(value, "Maximum ticket name length");
	if (maxLength < 8 || maxLength > 255) {
		throw new UsageError("Maximum ticket name length must be an integer between 8 and 255.");
	}
	return maxLength;
}

export function parseListLimit(
	value: string | undefined,
	all: boolean,
): number | undefined {
	if (value === undefined) return undefined;
	if (all) throw new UsageError("--all and --limit cannot be combined.");
	const limit = parseInteger(value, "--limit");
	if (limit < 1) throw new UsageError("--limit must be a positive integer.");
	return limit;
}

function parseSetValue(raw: string): FrontmatterValue {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed === null ||
			typeof parsed === "string" ||
			typeof parsed === "number" ||
			typeof parsed === "boolean"
		) {
			return parsed;
		}
		if (
			Array.isArray(parsed) &&
			parsed.every(
				(item) =>
					item === null ||
					typeof item === "string" ||
					typeof item === "number" ||
					typeof item === "boolean",
			)
		) {
			return parsed as FrontmatterValue;
		}
	} catch {
		// Invalid JSON stays a literal string, which keeps simple CLI values easy.
	}
	return raw;
}

export function parseSetAssignments(
	entries: string[] | undefined,
): Record<string, FrontmatterValue> | undefined {
	if (!entries?.length) return undefined;
	const values: Record<string, FrontmatterValue> = {};
	for (const entry of entries) {
		const equals = entry.indexOf("=");
		if (equals < 0) {
			throw new UsageError(`--set expects key=value, got "${entry}".`);
		}
		const key = entry.slice(0, equals).trim();
		if (!key) throw new UsageError(`--set has an empty key in "${entry}".`);
		values[key] = parseSetValue(entry.slice(equals + 1));
	}
	return values;
}

/** Parse `new [status] [priority] <text>`, mirroring the /fit command. */
export function parseNewPositionals(args: string[]): {
	status: string;
	priority: number;
	text: string;
} {
	const knownStatuses = new Set([
		"open",
		"in_progress",
		"in-progress",
		"inprogress",
		"backlog",
		"closed",
	]);
	let index = 0;
	let status = "open";
	const first = args[0];
	if (first !== undefined && (knownStatuses.has(first.toLowerCase()) || first.includes("/"))) {
		status = first;
		index = 1;
	}
	let priority = 0;
	const priorityToken = args[index];
	if (priorityToken !== undefined && /^-?\d+$/.test(priorityToken)) {
		priority = parsePriority(priorityToken);
		index += 1;
	}
	return {
		status,
		priority,
		text: args.slice(index).join(" "),
	};
}

export function requirePositionals(
	args: string[],
	names: string[],
	usage: string,
): string[] {
	if (args.length < names.length) {
		throw new UsageError(`Missing ${names[args.length] ?? "argument"}.`, `Usage: ${usage}`);
	}
	return args.slice(0, names.length);
}

export function rejectExtraPositionals(args: string[], usage: string): void {
	if (args.length > 0) {
		throw new UsageError(`Unexpected argument "${args[0]}".`, `Usage: ${usage}`);
	}
}
