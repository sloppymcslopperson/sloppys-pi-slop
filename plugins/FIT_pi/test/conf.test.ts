import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	CONF_FILENAME,
	parseToml,
	readFitConf,
	resolveGitIdentity,
} from "../src/conf.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("conf.toml parser", () => {
	it("parses tables, scalars, comments, and dotted keys", () => {
		const conf = parseToml(`
# Board configuration
[git]
name = "Sloppy McSlopperson" # inline comment
email = 'sloppy@example.com'

[board]
strict = true
max = 42
ratio = 1.5
tags = ["a", "b"]
nested.key = "value"
`);
		assert.deepEqual(conf, {
			git: { name: "Sloppy McSlopperson", email: "sloppy@example.com" },
			board: {
				strict: true,
				max: 42,
				ratio: 1.5,
				tags: ["a", "b"],
				nested: { key: "value" },
			},
		});
	});

	it("handles escaped characters and hashes inside strings", () => {
		const conf = parseToml(
			'[git]\nname = "A \\"quoted\\" name # not a comment"\n',
		);
		assert.equal(
			(conf.git as Record<string, unknown>).name,
			'A "quoted" name # not a comment',
		);
	});

	it("rejects malformed input with a line number", () => {
		assert.throws(() => parseToml("[git]\nname\n"), /line 2/);
		assert.throws(() => parseToml("[git]\nname = \n"), /line 2/);
		assert.throws(() => parseToml('name = "unterminated\n'), /line 1/);
		assert.throws(
			() => parseToml("[git]\nname = \"a\"\nname = \"b\"\n"),
			/Duplicate key/,
		);
	});
});

describe("git identity from conf.toml", () => {
	it("reads the [git] table", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-conf-"));
		roots.push(root);
		await writeFile(
			join(root, CONF_FILENAME),
			'[git]\nname = "Someone"\nemail = "someone@example.com"\n',
			"utf8",
		);
		const conf = await readFitConf(root);
		assert.deepEqual(resolveGitIdentity(conf), {
			name: "Someone",
			email: "someone@example.com",
		});
	});

	it("accepts top-level gitname and gitemail aliases", () => {
		const conf = parseToml(
			'gitname = "Someone"\ngitemail = "someone@example.com"\n',
		);
		assert.deepEqual(resolveGitIdentity(conf), {
			name: "Someone",
			email: "someone@example.com",
		});
	});

	it("ignores a partial identity so commits use the system values", () => {
		assert.deepEqual(
			resolveGitIdentity(parseToml('[git]\nname = "Only Name"\n')),
			{},
		);
	});

	it("returns an empty object when conf.toml is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "fit-conf-missing-"));
		roots.push(root);
		assert.deepEqual(await readFitConf(root), {});
	});
});
