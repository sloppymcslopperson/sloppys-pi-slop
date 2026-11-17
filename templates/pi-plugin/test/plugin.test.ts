import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin from "../extensions/index.ts";

describe("__PLUGIN_NAME__", () => {
	it("exports an extension function", () => {
		assert.equal(typeof plugin, "function");
	});
});
