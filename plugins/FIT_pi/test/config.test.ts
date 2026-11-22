import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	nextAgentMode,
	parseAgentModeAction,
	parseAgentModeToken,
	parseAutocommitToken,
	parseNogrillToken,
	parseReviewToken,
	resolveAgentMode,
	resolveNogrillDefault,
	resolveReviewDefault,
} from "../src/config.ts";

describe("review configuration", () => {
	it("parses review and normal tokens", () => {
		for (const token of ["review", "REVIEW", "true", "1", "yes", "hold", "wait"]) {
			assert.equal(parseReviewToken(token), true, token);
		}
		for (const token of ["false", "0", "no", "normal", "none", "--no-review"]) {
			assert.equal(parseReviewToken(token), false, token);
		}
		assert.equal(parseReviewToken(undefined), undefined);
		assert.equal(parseReviewToken(""), undefined);
		assert.equal(parseReviewToken("maybe"), undefined);
	});

	it("prefers an explicit flag over the environment", () => {
		assert.equal(resolveReviewDefault(false, "1"), false);
		assert.equal(resolveReviewDefault(true, "0"), true);
	});

	it("uses the environment when no flag is set", () => {
		assert.equal(resolveReviewDefault(undefined, "review"), true);
		assert.equal(resolveReviewDefault(undefined, "false"), false);
	});

	it("defaults to normal mode", () => {
		assert.equal(resolveReviewDefault(undefined, undefined), false);
		assert.equal(resolveReviewDefault(undefined, "unrecognized"), false);
	});
});

describe("nogrill configuration", () => {
	it("parses nogrill tokens", () => {
		for (const token of ["nogrill", "NOGRILL", "no-grill", "--nogrill", "--no-grill"]) {
			assert.equal(parseNogrillToken(token), true, token);
		}
		assert.equal(parseNogrillToken(undefined), undefined);
		assert.equal(parseNogrillToken(""), undefined);
		assert.equal(parseNogrillToken("grill"), undefined);
	});

	it("prefers an explicit flag over the environment", () => {
		assert.equal(resolveNogrillDefault(false, "1"), false);
		assert.equal(resolveNogrillDefault(true, "0"), true);
	});

	it("uses the environment when no flag is set", () => {
		assert.equal(resolveNogrillDefault(undefined, "nogrill"), true);
		assert.equal(resolveNogrillDefault(undefined, "false"), false);
	});

	it("defaults to grilling enabled", () => {
		assert.equal(resolveNogrillDefault(undefined, undefined), false);
		assert.equal(resolveNogrillDefault(undefined, "unrecognized"), false);
	});
});

describe("autocommit configuration", () => {
	it("parses autocommit tokens", () => {
		for (const token of ["autocommit", "AUTOCOMMIT", "auto-commit", "--autocommit", "--auto-commit"]) {
			assert.equal(parseAutocommitToken(token), true, token);
		}
		assert.equal(parseAutocommitToken(undefined), undefined);
		assert.equal(parseAutocommitToken(""), undefined);
		assert.equal(parseAutocommitToken("commit"), undefined);
	});
});

describe("planner mode configuration", () => {
	it("parses on and off tokens", () => {
		for (const token of ["planner", "plan", "agent", "ON", "true", "1", "yes", "readonly", "read-only"]) {
			assert.equal(parseAgentModeToken(token), true, token);
		}
		for (const token of ["off", "FALSE", "0", "no", "normal", "none", "--no-plan", "--no-agent"]) {
			assert.equal(parseAgentModeToken(token), false, token);
		}
		assert.equal(parseAgentModeToken(undefined), undefined);
		assert.equal(parseAgentModeToken(""), undefined);
		assert.equal(parseAgentModeToken("maybe"), undefined);
	});

	it("prefers an explicit flag over the environment", () => {
		assert.equal(resolveAgentMode(false, "1"), false);
		assert.equal(resolveAgentMode(true, "0"), true);
	});

	it("uses the environment when no flag is set", () => {
		assert.equal(resolveAgentMode(undefined, "1"), true);
		assert.equal(resolveAgentMode(undefined, "off"), false);
	});

	it("defaults to normal access", () => {
		assert.equal(resolveAgentMode(undefined, undefined), false);
		assert.equal(resolveAgentMode(undefined, "unrecognized"), false);
	});
});

describe("planner mode actions", () => {
	it("parses toggle, on, off, and status actions", () => {
		assert.equal(parseAgentModeAction(undefined), "toggle");
		assert.equal(parseAgentModeAction(""), "toggle");
		assert.equal(parseAgentModeAction("toggle"), "toggle");
		for (const token of ["on", "enable", "true", "1", "readonly", "read-only"]) {
			assert.equal(parseAgentModeAction(token), "on", token);
		}
		for (const token of ["off", "disable", "false", "0"]) {
			assert.equal(parseAgentModeAction(token), "off", token);
		}
		for (const token of ["status", "show"]) {
			assert.equal(parseAgentModeAction(token), "status", token);
		}
		assert.equal(parseAgentModeAction("maybe"), undefined);
	});

	it("computes the next state without mutating the current one", () => {
		assert.equal(nextAgentMode(false, "toggle"), true);
		assert.equal(nextAgentMode(true, "toggle"), false);
		assert.equal(nextAgentMode(false, "on"), true);
		assert.equal(nextAgentMode(true, "off"), false);
		assert.equal(nextAgentMode(true, "status"), true);
		assert.equal(nextAgentMode(false, "status"), false);
	});
});
