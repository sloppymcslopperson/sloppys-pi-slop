/**
 * AGENTS.md integration for FIT boards.
 *
 * `fit_init` owns only the marked FIT block. Everything outside the markers is
 * preserved so a project can keep its own agent instructions.
 */

export const FIT_AGENTS_BEGIN = "<!-- fit:begin -->";
export const FIT_AGENTS_END = "<!-- fit:end -->";

export const FIT_AGENTS_SECTION = [
	FIT_AGENTS_BEGIN,
	"## FIT tickets",
	"",
	"This repository uses FIT: tickets are Markdown files under `fit/open/`,",
	"`fit/in_progress/`, `fit/backlog/`, and `fit/closed/`. The directory is the",
	"ticket status. Filenames are `NN-short-name.md`: a two-digit priority from",
	"`00` to `99` (`00` first) and a short-name identity that must be unique across",
	"the board.",
	"",
	"Mode: no `fit/STRICT` marker means Basic (permissive). A `STRICT` file with the",
	"quoted spec version means Strict, which adds naming, priority, uniqueness,",
	"body, archive, and lifecycle rules. Read [AGENT_SPEC.md](AGENT_SPEC.md) before",
	"working a Strict board.",
	"",
	"Workflow: use `fit_list` to find an exact ticket id, read only the ticket you",
	"are assigned, move it to `in_progress` while working, and move it to `closed`",
	"when finished. At most one ticket may be in `in_progress` per checkout. Keep a",
	"1-3 sentence summary, then put everything else under level-3 (`###`) headers.",
	"Pass the `expectedRevision` from `fit_show` to mutations. Use `fit_archive`",
	"for closed tickets that should leave the active board; `fit_restore` brings an",
	"archived ticket back.",
	"",
	"Tools: `fit_init`, `fit_list`, `fit_show`, `fit_new`, `fit_new_batch`,",
	"`fit_update`, `fit_move`, `fit_cleanup`, `fit_archive`, `fit_restore`, and",
	"`fit_check`.",
	"",
	"Guardrails:",
	"- Prefer dedicated tools over direct manipulation when one exists. For FIT",
	"  operations, use the FIT tools rather than ad-hoc shell or editor changes.",
	"- Do not read ticket files or scan ticket bodies unless the task requires it.",
	"- Do not use `write`, `edit`, or shell commands to create, modify, move, or",
	"  delete files under `fit/`; use the FIT tools.",
	"- Do not guess ticket ids or fuzzy-match them in tool calls. Use exact ids",
	"  from `fit_list` or `fit_show`.",
	"- If a ticket changed since you read it, re-read it instead of forcing a",
	"  write.",
	FIT_AGENTS_END,
].join("\n");

export interface MergedAgents {
	content: string;
	changed: boolean;
}

/**
 * Merge the managed FIT section into an existing AGENTS.md body.
 *
 * - No file: produce a new file containing the section.
 * - Existing file without markers: append the section.
 * - Existing file with markers: replace only the marked block.
 */
export function mergeAgentsContent(existing: string | null): MergedAgents {
	const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
	const section = FIT_AGENTS_SECTION.replace(/\n/g, eol);
	if (existing === null) return { content: `${section}${eol}`, changed: true };

	const begin = existing.indexOf(FIT_AGENTS_BEGIN);
	const end =
		begin === -1
			? -1
			: existing.indexOf(FIT_AGENTS_END, begin + FIT_AGENTS_BEGIN.length);
	if (begin !== -1 && end !== -1) {
		const next =
			existing.slice(0, begin) +
			section +
			existing.slice(end + FIT_AGENTS_END.length);
		return { content: next, changed: next !== existing };
	}

	const trimmed = existing.replace(/\s+$/, "");
	const content = trimmed
		? `${trimmed}${eol}${eol}${section}${eol}`
		: `${section}${eol}`;
	return { content, changed: true };
}
