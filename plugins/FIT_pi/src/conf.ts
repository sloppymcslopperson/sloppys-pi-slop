/**
 * Board configuration (`conf.toml`).
 *
 * A board may carry a `conf.toml` at its root. The file is optional and
 * intentionally open-ended: current tools read the `[git]` table, and future
 * FIT tooling can add sections without changing this parser.
 *
 * Supported TOML subset: tables (`[section]`, `[a.b]`), dotted keys, basic
 * strings (`"..."`), literal strings (`'...'`), integers, floats, booleans,
 * and single-line arrays of those scalars. Comments and blank lines are
 * ignored.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONF_FILENAME = "conf.toml";

export type TomlValue =
	| string
	| number
	| boolean
	| TomlValue[];

export type TomlTable = { [key: string]: TomlValue | TomlTable };

export interface FitGitConf {
	name?: string;
	email?: string;
}

/** Parsed contents of `conf.toml`. Tools read only the keys they understand. */
export type FitConf = TomlTable;

export interface GitIdentity {
	name?: string;
	email?: string;
}

function isTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove a `#` comment, ignoring hashes inside quoted strings. */
function stripComment(line: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]!;
		if (quote) {
			if (quote === '"' && char === "\\") i += 1;
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "#") {
			return line.slice(0, i);
		}
	}
	return line;
}

/** Find the first `=`, ignoring equals signs inside quoted keys. */
function findEquals(line: string): number {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]!;
		if (quote) {
			if (quote === '"' && char === "\\") i += 1;
			else if (char === quote) quote = null;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "=") {
			return i;
		}
	}
	return -1;
}

function splitKey(key: string, lineNumber: number): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	const push = () => {
		const part = current.trim();
		if (!part) throw new Error(`Empty key in conf.toml on line ${lineNumber}.`);
		parts.push(part);
		current = "";
	};
	for (let i = 0; i < key.length; i += 1) {
		const char = key[i]!;
		if (quote) {
			if (quote === '"' && char === "\\") {
				current += char;
				if (i + 1 < key.length) current += key[(i += 1)];
			} else if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ".") {
			push();
		} else {
			current += char;
		}
	}
	if (quote) throw new Error(`Unterminated quoted key in conf.toml on line ${lineNumber}.`);
	push();
	return parts;
}

function parseBasicString(raw: string, lineNumber: number): string {
	let value = "";
	for (let i = 1; i < raw.length; i += 1) {
		const char = raw[i]!;
		if (char === '"') {
			if (raw.slice(i + 1).trim() !== "") {
				throw new Error(`Unexpected text after string in conf.toml on line ${lineNumber}.`);
			}
			return value;
		}
		if (char !== "\\") {
			value += char;
			continue;
		}
		const next = raw[(i += 1)];
		if (next === undefined) break;
		switch (next) {
			case "n": value += "\n"; break;
			case "t": value += "\t"; break;
			case "r": value += "\r"; break;
			case '"': value += '"'; break;
			case "\\": value += "\\"; break;
			case "b": value += "\b"; break;
			case "f": value += "\f"; break;
			default:
				throw new Error(`Unsupported escape \\${next} in conf.toml on line ${lineNumber}.`);
		}
	}
	throw new Error(`Unterminated string in conf.toml on line ${lineNumber}.`);
}

function parseLiteralString(raw: string, lineNumber: number): string {
	const end = raw.indexOf("'", 1);
	if (end < 0) throw new Error(`Unterminated string in conf.toml on line ${lineNumber}.`);
	if (raw.slice(end + 1).trim() !== "") {
		throw new Error(`Unexpected text after string in conf.toml on line ${lineNumber}.`);
	}
	return raw.slice(1, end);
}

/** Split array items on top-level commas, ignoring commas in strings/brackets. */
function splitArrayItems(raw: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let depth = 0;
	for (let i = 0; i < raw.length; i += 1) {
		const char = raw[i]!;
		if (quote) {
			current += char;
			if (quote === '"' && char === "\\") {
				if (i + 1 < raw.length) current += raw[(i += 1)];
			} else if (char === quote) {
				quote = null;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			current += char;
		} else if (char === "[" || char === "{") {
			depth += 1;
			current += char;
		} else if (char === "]" || char === "}") {
			depth -= 1;
			current += char;
		} else if (char === "," && depth === 0) {
			items.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	if (current.trim() !== "") items.push(current);
	return items;
}

function parseValue(raw: string, lineNumber: number): TomlValue {
	const value = raw.trim();
	if (value === "") throw new Error(`Missing value in conf.toml on line ${lineNumber}.`);
	if (value.startsWith('"')) return parseBasicString(value, lineNumber);
	if (value.startsWith("'")) return parseLiteralString(value, lineNumber);
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.startsWith("[")) {
		if (!value.endsWith("]")) {
			throw new Error(`Unterminated array in conf.toml on line ${lineNumber}.`);
		}
		const inner = value.slice(1, -1);
		if (inner.trim() === "") return [];
		return splitArrayItems(inner).map((item) => parseValue(item, lineNumber));
	}
	if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return Number(value);
	throw new Error(`Unsupported TOML value in conf.toml on line ${lineNumber}: ${value}`);
}

function ensureTable(root: TomlTable, path: string[], lineNumber: number): TomlTable {
	let table = root;
	for (const key of path) {
		const existing = table[key];
		if (existing === undefined) {
			const next: TomlTable = {};
			table[key] = next;
			table = next;
		} else if (isTable(existing)) {
			table = existing;
		} else {
			throw new Error(
				`conf.toml line ${lineNumber}: ${path.join(".")} is already a value, not a table.`,
			);
		}
	}
	return table;
}

function setValue(
	table: TomlTable,
	path: string[],
	value: TomlValue,
	lineNumber: number,
): void {
	const parent = ensureTable(table, path.slice(0, -1), lineNumber);
	const key = path[path.length - 1]!;
	if (key in parent) {
		throw new Error(`Duplicate key ${path.join(".")} in conf.toml on line ${lineNumber}.`);
	}
	parent[key] = value;
}

/** Parse the supported TOML subset. Throws with a line number on bad input. */
export function parseToml(text: string): TomlTable {
	const root: TomlTable = {};
	let current = root;
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = stripComment(lines[index]!).trim();
		if (!line) continue;
		if (line.startsWith("[")) {
			const match = /^\[([^\]]+)\]$/.exec(line);
			if (!match) {
				throw new Error(`Invalid table header in conf.toml on line ${lineNumber}.`);
			}
			current = ensureTable(root, splitKey(match[1]!, lineNumber), lineNumber);
			continue;
		}
		const equals = findEquals(line);
		if (equals < 0) {
			throw new Error(`Expected key = value in conf.toml on line ${lineNumber}.`);
		}
		const key = splitKey(line.slice(0, equals), lineNumber);
		const value = parseValue(line.slice(equals + 1), lineNumber);
		setValue(current, key, value, lineNumber);
	}
	return root;
}

/** Read `conf.toml` from a board. Returns an empty object when it is absent. */
export async function readFitConf(board: string): Promise<FitConf> {
	let text: string;
	try {
		text = await readFile(join(board, CONF_FILENAME), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return parseToml(text) as FitConf;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the configured commit identity. `[git] name`/`[git] email` win;
 * top-level `gitname`/`gitemail` are accepted as aliases. A partial identity
 * is ignored so commits fall back to the repository/system configuration.
 */
export function resolveGitIdentity(conf: FitConf): GitIdentity {
	const git = isTable(conf.git) ? conf.git : {};
	const name = stringValue(git.name) ?? stringValue(conf.gitname);
	const email = stringValue(git.email) ?? stringValue(conf.gitemail);
	if (!name || !email) return {};
	return { name, email };
}
