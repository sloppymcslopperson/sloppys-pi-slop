import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	AGENT_MODE_PLAN_INSTRUCTION,
	LATE_AGENT_MODE_REMINDER,
	PLAN_A_LEG_GRILL_INSTRUCTION,
	PLAN_A_LEG_INSTRUCTION,
	lateAgentModeReminder,
} from "../src/prompt.ts";

describe("agent-mode planning prompt", () => {
	it("asks for a short, human-executable plan in chat", () => {
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /Present the plan in your reply/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /numbered steps/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /files or areas/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /verify/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /risks or open questions/);
	});

	it("stops before implementation and does not create plan tickets", () => {
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /Do not create tickets/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /Do not start implementing/);
		assert.match(AGENT_MODE_PLAN_INSTRUCTION, /do not move or close the ticket/);
		assert.match(
			AGENT_MODE_PLAN_INSTRUCTION,
			/turn agent mode off and explicitly confirm/,
		);
	});

	it("does not reintroduce grilling when nogrill is used", () => {
		assert.doesNotMatch(AGENT_MODE_PLAN_INSTRUCTION, /grill/i);
		assert.doesNotMatch(LATE_AGENT_MODE_REMINDER, /grill/i);
	});
});

describe("plan-a-leg prompt", () => {
	it("asks for 2-7 implementation tickets plus a final review ticket", () => {
		assert.match(PLAN_A_LEG_INSTRUCTION, /at least 2 and at most 7 implementation tickets/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /final review ticket/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /extra, not part of the 2-7 implementation cap/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /-review/);
	});

	it("places tickets under the umbrella project and links the parent", () => {
		assert.match(PLAN_A_LEG_INSTRUCTION, /open status path/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /priorities starting at 00/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /parent: <umbrella-id>/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /30-character FIT short-name limit/);
	});

	it("keeps ticket bodies KISS and does not produce a report", () => {
		assert.match(PLAN_A_LEG_INSTRUCTION, /1-3 sentence summary/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /### Goal and ### Done when/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /novel-length spec/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /deepen shallow modules/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /do not create an HTML plan or report/);
	});

	it("updates and closes the umbrella, then stops without implementing", () => {
		assert.match(PLAN_A_LEG_INSTRUCTION, /append a short ordered list/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /close the umbrella with fit_move/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /Present the ordered leg/);
		assert.match(PLAN_A_LEG_INSTRUCTION, /do not start implementing/);
	});

	it("asks about the split and review ticket only while grilling", () => {
		assert.match(PLAN_A_LEG_GRILL_INSTRUCTION, /ask how many implementation tickets/);
		assert.match(PLAN_A_LEG_GRILL_INSTRUCTION, /final review ticket/);
		assert.match(PLAN_A_LEG_GRILL_INSTRUCTION, /stop without creating tickets/);
	});
});

describe("late agent-mode activation reminder", () => {	it("fires only on an explicit off -> on transition", () => {
		assert.equal(lateAgentModeReminder(false, true, "on"), LATE_AGENT_MODE_REMINDER);
		assert.equal(lateAgentModeReminder(false, true, "toggle"), LATE_AGENT_MODE_REMINDER);
		assert.equal(lateAgentModeReminder(true, true, "on"), undefined);
		assert.equal(lateAgentModeReminder(true, false, "off"), undefined);
		assert.equal(lateAgentModeReminder(false, false, "toggle"), undefined);
	});

	it("stays silent for status checks", () => {
		assert.equal(lateAgentModeReminder(false, true, "status"), undefined);
		assert.equal(lateAgentModeReminder(true, true, "status"), undefined);
	});

	it("includes the plan, pause, and confirmation rules", () => {
		assert.match(LATE_AGENT_MODE_REMINDER, /plan it and show the plan/);
		assert.match(LATE_AGENT_MODE_REMINDER, /Do not create tickets/);
		assert.match(LATE_AGENT_MODE_REMINDER, /Do not start implementing/);
		assert.match(LATE_AGENT_MODE_REMINDER, /turn agent mode off and explicitly confirm/);
	});
});
