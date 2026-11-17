/**
 * Human-facing configuration parsing.
 *
 * Commands accept review tokens such as `review` or `false`. The same tokens
 * are used by the `FIT_REVIEW` environment variable so CLI flags and env vars
 * share one vocabulary.
 */

export const REVIEW_TOKENS = new Set([
	"review",
	"--review",
	"-r",
	"true",
	"1",
	"yes",
	"hold",
	"wait",
]);

export const NORMAL_TOKENS = new Set([
	"false",
	"0",
	"no",
	"normal",
	"none",
	"--no-review",
]);

/** Parse a review token. Returns undefined when the token is not recognized. */
export function parseReviewToken(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const token = value.trim().toLowerCase();
	if (!token) return undefined;
	if (REVIEW_TOKENS.has(token)) return true;
	if (NORMAL_TOKENS.has(token)) return false;
	return undefined;
}

export const NOGRILL_TOKENS = new Set([
	"nogrill",
	"no-grill",
	"--nogrill",
	"--no-grill",
]);

/** Parse a nogrill token. Returns true only for recognized nogrill spellings. */
export function parseNogrillToken(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const token = value.trim().toLowerCase();
	return NOGRILL_TOKENS.has(token) ? true : undefined;
}

export const AUTOCOMMIT_TOKENS = new Set([
	"autocommit",
	"auto-commit",
	"--autocommit",
	"--auto-commit",
]);

/** Parse an autocommit token. Returns true only for recognized spellings. */
export function parseAutocommitToken(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const token = value.trim().toLowerCase();
	return AUTOCOMMIT_TOKENS.has(token) ? true : undefined;
}

const AGENT_MODE_TOKENS = new Set([
	"agent",
	"on",
	"true",
	"1",
	"yes",
	"readonly",
	"read-only",
]);

const NORMAL_ACCESS_TOKENS = new Set([
	"off",
	"false",
	"0",
	"no",
	"normal",
	"none",
	"--no-agent",
]);

/** Parse an agent-mode token. Returns undefined when the token is not recognized. */
export function parseAgentModeToken(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const token = value.trim().toLowerCase();
	if (!token) return undefined;
	if (AGENT_MODE_TOKENS.has(token)) return true;
	if (NORMAL_ACCESS_TOKENS.has(token)) return false;
	return undefined;
}

export type AgentModeAction = "toggle" | "on" | "off" | "status";

/**
 * Parse a `/fit agent` argument into a mode action. An omitted argument means
 * toggle; unknown arguments return undefined.
 */
export function parseAgentModeAction(value: string | undefined): AgentModeAction | undefined {
	const token = (value ?? "").trim().toLowerCase();
	if (!token || token === "toggle") return "toggle";
	if (["on", "enable", "true", "1", "readonly", "read-only"].includes(token)) {
		return "on";
	}
	if (["off", "disable", "false", "0"].includes(token)) return "off";
	if (["status", "show"].includes(token)) return "status";
	return undefined;
}

/** Return the effective state after applying an action to the current state. */
export function nextAgentMode(current: boolean, action: AgentModeAction): boolean {
	if (action === "on") return true;
	if (action === "off") return false;
	if (action === "toggle") return !current;
	return current;
}

/**
 * Resolve the configured agent-mode default. An explicit CLI flag wins over the
 * environment, and the environment wins over the built-in `false` default.
 */
export function resolveAgentMode(
	flagValue: boolean | string | undefined,
	envValue: string | undefined,
): boolean {
	if (typeof flagValue === "boolean") return flagValue;
	if (typeof flagValue === "string") {
		return parseAgentModeToken(flagValue) ?? parseAgentModeToken(envValue) ?? false;
	}
	return parseAgentModeToken(envValue) ?? false;
}

/**
 * Resolve the configured review default. An explicit CLI flag wins over the
 * environment, and the environment wins over the built-in `false` default.
 */
export function resolveReviewDefault(
	flagValue: boolean | string | undefined,
	envValue: string | undefined,
): boolean {
	if (typeof flagValue === "boolean") return flagValue;
	if (typeof flagValue === "string") return parseReviewToken(flagValue) ?? false;
	return parseReviewToken(envValue) ?? false;
}

/**
 * Resolve the configured nogrill default. An explicit CLI flag wins over the
 * environment; unrecognized or unset values leave grilling enabled.
 */
export function resolveNogrillDefault(
	flagValue: boolean | string | undefined,
	envValue: string | undefined,
): boolean {
	if (typeof flagValue === "boolean") return flagValue;
	if (typeof flagValue === "string" && parseNogrillToken(flagValue)) return true;
	return parseNogrillToken(envValue) ?? false;
}
