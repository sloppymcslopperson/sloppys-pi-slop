import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { AGENT_SPEC } from "../src/agent-spec.ts";
import { FIT_SPEC, FIT_SPEC_SHA256, FIT_SPEC_VERSION } from "../src/spec.ts";

describe("vendored FIT spec", () => {
	it("is pinned to the exact upstream file", () => {
		const digest = createHash("sha256").update(FIT_SPEC, "utf8").digest("hex");
		assert.equal(digest, FIT_SPEC_SHA256);
	});

	it("declares the same version it pins", () => {
		assert.match(FIT_SPEC, new RegExp(`^Version \`${FIT_SPEC_VERSION}\``, "m"));
		assert.equal(FIT_SPEC_VERSION, "0.5");
	});
});

describe("vendored agent spec", () => {
	it("matches AGENT_SPEC.md at the package root", () => {
		const rootCopy = readFileSync(new URL("../AGENT_SPEC.md", import.meta.url), "utf8");
		assert.equal(AGENT_SPEC, rootCopy);
	});

	it("covers both modes and the linked filename", () => {
		assert.match(AGENT_SPEC, /^# FIT agent spec/);
		assert.match(AGENT_SPEC, /## Basic/);
		assert.match(AGENT_SPEC, /## Strict/);
	});
});
