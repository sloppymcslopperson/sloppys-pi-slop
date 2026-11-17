/**
 * Human-only fuzzy lookup.
 *
 * Agent-facing tools never import this module. The `/fit` command uses it to
 * turn a short human query into a deterministic candidate list; ambiguity is
 * shown as a picker instead of being resolved silently.
 */

import type { TicketSummary } from "./fit.ts";

export function fuzzyScore(ticket: TicketSummary, query: string): number {
	const needle = query.toLowerCase().trim();
	if (!needle) return 0;
	const id = ticket.id.toLowerCase();
	const filename = ticket.filename.toLowerCase();
	const title = ticket.title.toLowerCase();
	if (id === needle || filename === needle || ticket.name.toLowerCase() === needle) {
		return 1000;
	}
	let score = 0;
	if (filename.includes(needle)) score = Math.max(score, 700 + needle.length);
	if (id.includes(needle)) score = Math.max(score, 600 + needle.length);
	if (title.includes(needle)) score = Math.max(score, 500 + needle.length);
	if (isSubsequence(needle, filename)) score = Math.max(score, 300);
	if (isSubsequence(needle, id)) score = Math.max(score, 200);
	const tokens = needle.split(/[^a-z0-9]+/).filter(Boolean);
	if (tokens.length > 1) {
		const haystack = `${id} ${title}`;
		const hits = tokens.filter((token) => haystack.includes(token)).length;
		if (hits > 0) score = Math.max(score, 100 + (hits / tokens.length) * 100);
	}
	return score;
}

function isSubsequence(needle: string, haystack: string): boolean {
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) index += 1;
		if (index === needle.length) return true;
	}
	return needle.length === 0;
}

export function fuzzyFind(
	tickets: TicketSummary[],
	query: string,
	limit = 10,
): TicketSummary[] {
	return tickets
		.map((ticket) => ({ ticket, score: fuzzyScore(ticket, query) }))
		.filter((entry) => entry.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || (a.ticket.id < b.ticket.id ? -1 : a.ticket.id > b.ticket.id ? 1 : 0),
		)
		.slice(0, limit)
		.map((entry) => entry.ticket);
}
