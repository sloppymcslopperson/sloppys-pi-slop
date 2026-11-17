import type { BoardMode, TicketSummary } from "./fit.ts";

/**
 * Format the footer indicator for the current in-progress ticket.
 *
 * The indicator is intentionally Strict-only. Basic boards may have any number
 * of in-progress tickets, so there is no single stable identity to show there.
 * A Strict board must have exactly one; more than one is surfaced as an error.
 */
export function formatInProgressStatus(
	mode: BoardMode,
	tickets: TicketSummary[],
): string | undefined {
	if (mode.mode !== "strict") return undefined;

	const inProgress = tickets.filter((ticket) => ticket.status === "in_progress");
	if (inProgress.length === 0) return undefined;
	if (inProgress.length === 1) {
		return `fit: in_progress ${inProgress[0].name}`;
	}

	return `fit: ERROR in_progress has ${inProgress.length} tickets: ${inProgress
		.map((ticket) => ticket.name)
		.join(", ")}`;
}
