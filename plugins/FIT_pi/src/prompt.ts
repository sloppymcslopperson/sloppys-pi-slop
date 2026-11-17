/**
 * Agent-facing prompt fragments for FIT agent mode.
 *
 * These are kept separate from `index.ts` so the planning contract can be
 * unit-tested without registering the extension.
 */

import type { AgentModeAction } from "./config.ts";

/**
 * Added to `/fit work` and `/fit start` when agent mode is already on.
 * Grilling guidance is emitted separately before this, so this text only
 * describes the plan and the stop rule. It must stay silent about grilling so
 * `nogrill` keeps its meaning.
 */
export const AGENT_MODE_PLAN_INSTRUCTION = [
	"Agent mode is on. Before touching code, plan the work for this ticket.",
	"Present the plan in your reply, not in a file: numbered steps, the files or areas to change, how you will verify the work (tests/checks), and any risks or open questions.",
	"Keep it short and easy for a human to follow; the user should be able to execute the plan without you.",
	"Do not create tickets just to represent the plan; only offer follow-up tickets if the scope grows and the user approves a split.",
	"Do not start implementing and do not move or close the ticket. Stop after presenting the plan and wait for the user to turn agent mode off and explicitly confirm before executing it.",
].join(" ");

/**
 * Added to `/fit plan-a-leg`. The command turns agent mode on separately; this
 * text owns the split contract: how many tickets, where they go, how small
 * they must stay, and the stop rule.
 */
export const PLAN_A_LEG_INSTRUCTION = [
	"Plan one leg of work as a short sequence of bite-sized FIT implementation tickets, then one final architecture review ticket; do not implement any of them.",
	"Create at least 2 and at most 7 implementation tickets with fit_new_batch, in the order they should be worked. If the work genuinely needs more than 7, stop and ask the user whether to split it into multiple legs. If the work fits in one ticket, say so, create nothing, and leave the umbrella unchanged.",
	"Always add one final review ticket after the implementation tickets. It is extra, not part of the 2-7 implementation cap, and gets the next priority after the last implementation ticket with the short name <prefix>-review so it is worked last.",
	"Put the leg tickets under the open status path for the umbrella's project (the heading above gives the exact destination), with sequential priorities starting at 00. Prefix each short name with as much of the umbrella short name as fits within the 30-character FIT short-name limit, then -p1, -p2, and so on; the review ticket ends in -review.",
	"Record the umbrella on every leg ticket with frontmatter parent: <umbrella-id>.",
	"Keep each leg ticket KISS: a 1-3 sentence summary, then short ### Goal and ### Done when sections, plus a file hint only when you are certain. Do not write a novel-length spec. Each leg ticket gets its own grilling session later, and over-specified planner detail is often wrong.",
	"The review ticket checks only the files this leg changed. Its goal is to find and implement small, safe architecture improvements: deepen shallow modules, improve test seams and testability, and improve locality. Keep tests green and avoid broad rewrites. After those improvements, offer the user a scan for more significant or drastic improvements, but do not create an HTML plan or report unless the user explicitly asks for one.",
	"After the leg tickets exist, append a short ordered list of their ids and one-line goals to the umbrella body with fit_update, then close the umbrella with fit_move and the latest expectedRevision.",
	"Present the ordered leg in your reply and stop. Do not move any leg ticket to in_progress, and do not start implementing until the user turns agent mode off and explicitly confirms.",
].join(" ");

/** Added to `/fit plan-a-leg` when grilling is enabled. */
export const PLAN_A_LEG_GRILL_INSTRUCTION = [
	"While grilling, settle the split with the user before creating any tickets: ask how many implementation tickets they want, defaulting to at most 7, and confirm the proposed order, ticket boundaries, and the final review ticket.",
	"If the user cancels a grilling question, stop without creating tickets or closing the umbrella.",
].join(" ");

/** Sent when agent mode is turned on after the work prompt was already issued. */
export const LATE_AGENT_MODE_REMINDER = [
	"Agent mode is now on. Before doing any work, plan it and show the plan to the user.",
	"Keep the plan short and easy for a human to follow: numbered steps, files or areas to change, verification/tests, and risks or open questions.",
	"Present the plan in your reply. Do not create tickets just for the plan. Do not start implementing and do not move or close the ticket.",
	"Stop after the plan and wait for the user to turn agent mode off and explicitly confirm before executing it.",
].join(" ");

/**
 * Return the late-activation reminder only for an explicit off -> on
 * transition. Startup, status checks, and turning agent mode off stay silent.
 */
export function lateAgentModeReminder(
	previous: boolean,
	enabled: boolean,
	action: AgentModeAction,
): string | undefined {
	if (action === "status") return undefined;
	if (previous || !enabled) return undefined;
	return LATE_AGENT_MODE_REMINDER;
}
