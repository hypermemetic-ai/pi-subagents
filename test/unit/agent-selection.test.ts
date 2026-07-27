import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { assertTrustedAgentPath, mergeAgentsForScope } from "../../src/agents/agent-selection.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(name: string, source: "builtin" | "package" | "user" | "project", systemPrompt: string, filePath = `/${source}/${name}.md`): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt,
		source,
		filePath,
	};
}

describe("mergeAgentsForScope", () => {
	it("returns project agents when scope is project", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("project", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("returns user agents when scope is user", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("user", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
	});

	it("prefers project agents on name collisions when scope is both", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
		assert.equal(result[0]?.systemPrompt, "project prompt");
	});

	it("keeps agents from both scopes when names are distinct", () => {
		const userAgents = [makeAgent("user-only", "user", "user prompt")];
		const projectAgents = [makeAgent("project-only", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "user-only" && a.source === "user"));
		assert.ok(result.find((a) => a.name === "project-only" && a.source === "project"));
	});

	it("includes builtin agents when no user or project override exists", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const result = mergeAgentsForScope("both", [], [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "builtin");
	});

	it("user agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const userAgents = [makeAgent("scout", "user", "custom prompt")];
		const result = mergeAgentsForScope("both", userAgents, [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
		assert.equal(result[0]?.systemPrompt, "custom prompt");
	});

	it("package agents override builtins but not user or project agents", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const packageAgents = [makeAgent("scout", "package", "package prompt")];
		const userAgents = [makeAgent("scout", "user", "user prompt")];
		const projectAgents = [makeAgent("scout", "project", "project prompt")];

		assert.equal(mergeAgentsForScope("both", [], [], builtinAgents, packageAgents)[0]?.source, "package");
		assert.equal(mergeAgentsForScope("user", userAgents, [], builtinAgents, packageAgents)[0]?.source, "user");
		assert.equal(mergeAgentsForScope("project", [], projectAgents, builtinAgents, packageAgents)[0]?.source, "project");
	});

	it("project agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const projectAgents = [makeAgent("scout", "project", "project prompt")];
		const result = mergeAgentsForScope("both", [], projectAgents, builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("injects an immutable trusted execution profile after exact path validation", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-profile-"));
		try {
			const trustedPath = path.join(dir, "observer.md");
			writeFileSync(trustedPath, "trusted");
			const trusted = {
				...makeAgent("observer", "user", "trusted prompt", trustedPath),
				model: "manifest/model",
				thinking: "low",
				fallbackModels: ["fallback/model"],
			} as AgentConfig;
			const profile = { provider: "kimi-coding", model: "k3", effort: "max", serviceClass: "provider-default" };
			const result = mergeAgentsForScope(
				"both",
				[trusted],
				[],
				[],
				[],
				JSON.stringify({ observer: trustedPath }),
				JSON.stringify({ observer: profile }),
			);
			assert.equal(result[0]?.model, "kimi-coding/k3");
			assert.equal(result[0]?.thinking, "max");
			assert.deepEqual(result[0]?.fallbackModels, []);
			assert.deepEqual(result[0]?.trustedExecutionProfile, profile);
			assert.equal(Object.isFrozen(result[0]?.trustedExecutionProfile), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires trusted profile keys to match trusted seats exactly", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-profile-"));
		try {
			const trustedPath = path.join(dir, "observer.md");
			writeFileSync(trustedPath, "trusted");
			const trusted = makeAgent("observer", "user", "trusted prompt", trustedPath);
			const profile = { provider: "kimi-coding", model: "k3", effort: "max", serviceClass: "provider-default" };
			assert.throws(
				() => mergeAgentsForScope("both", [trusted], [], [], [], undefined, JSON.stringify({ observer: profile })),
				/requires PI_SUBAGENT_TRUSTED_AGENT_PATHS/,
			);
			assert.throws(
				() => mergeAgentsForScope("both", [trusted], [], [], [], JSON.stringify({ observer: trustedPath }), JSON.stringify({ reviewer: profile })),
				/agent keys must exactly match/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects malformed trusted execution profiles before selection", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-profile-"));
		try {
			const trustedPath = path.join(dir, "observer.md");
			writeFileSync(trustedPath, "trusted");
			const trusted = makeAgent("observer", "user", "trusted prompt", trustedPath);
			const paths = JSON.stringify({ observer: trustedPath });
			assert.throws(
				() => mergeAgentsForScope("both", [trusted], [], [], [], paths, JSON.stringify({ observer: { provider: "kimi-coding", model: "k3", effort: "turbo", serviceClass: "provider-default" } })),
				/observer\.effort.*unsupported/,
			);
			assert.throws(
				() => mergeAgentsForScope("both", [trusted], [], [], [], paths, JSON.stringify({ observer: { provider: "kimi-coding", model: "k3", effort: "max", serviceClass: "provider-default", fallback: "other" } })),
				/must contain exactly/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts a trusted agent only from its exact regular file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "reviewer.md");
			writeFileSync(trustedPath, "---\nname: reviewer\n---\nTrusted reviewer\n");
			const trusted = makeAgent("reviewer", "user", "trusted prompt", trustedPath);
			const result = mergeAgentsForScope("both", [trusted], [], [], [], JSON.stringify({ reviewer: trustedPath }));
			assert.equal(result[0]?.filePath, trustedPath);
			assert.equal(result[0]?.trustedPathError, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses mutable settings overrides on an otherwise trusted definition", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "observer.md");
			writeFileSync(trustedPath, "trusted");
			const trusted = makeAgent("observer", "user", "trusted prompt", trustedPath);
			const overridden = {
				...trusted,
				override: { scope: "project", path: "/project/.pi/subagents.json", base: {} } as NonNullable<AgentConfig["override"]>,
			};
			const result = mergeAgentsForScope("both", [overridden], [], [], [], JSON.stringify({ observer: trustedPath }));
			assert.match(result[0]?.trustedPathError ?? "", /was modified by project override/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a same-name project agent instead of letting it occupy a trusted seat", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "reviewer.md");
			const projectPath = path.join(dir, "project-reviewer.md");
			writeFileSync(trustedPath, "trusted");
			writeFileSync(projectPath, "project");
			const helperPath = path.join(dir, "helper.md");
			writeFileSync(helperPath, "helper");
			const trusted = makeAgent("reviewer", "user", "trusted prompt", trustedPath);
			const project = makeAgent("reviewer", "project", "project prompt", projectPath);
			const helper = makeAgent("helper", "project", "helper prompt", helperPath);
			const result = mergeAgentsForScope("both", [trusted], [project, helper], [], [], JSON.stringify({ reviewer: trustedPath }));
			assert.match(result.find((agent) => agent.name === "reviewer")?.trustedPathError ?? "", /Trusted agent 'reviewer' resolved to/);
			assert.equal(result.find((agent) => agent.name === "helper")?.trustedPathError, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a later same-name user agent instead of letting it occupy a trusted seat", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "researcher.md");
			const unrelatedPath = path.join(dir, "unrelated-researcher.md");
			writeFileSync(trustedPath, "trusted");
			writeFileSync(unrelatedPath, "unrelated");
			const trusted = makeAgent("researcher", "user", "trusted prompt", trustedPath);
			const unrelated = makeAgent("researcher", "user", "unrelated prompt", unrelatedPath);
			const result = mergeAgentsForScope("user", [trusted, unrelated], [], [], [], JSON.stringify({ researcher: trustedPath }));
			assert.match(result[0]?.trustedPathError ?? "", /Trusted agent 'researcher' resolved to/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves non-reserved project agents available when trusted seats are outside the requested scope", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "reviewer.md");
			const helperPath = path.join(dir, "helper.md");
			writeFileSync(trustedPath, "trusted");
			writeFileSync(helperPath, "helper");
			const helper = makeAgent("helper", "project", "helper prompt", helperPath);
			const result = mergeAgentsForScope("project", [], [helper], [], [], JSON.stringify({ reviewer: trustedPath }));
			assert.equal(result[0]?.name, "helper");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed on builtin fallback, missing resume provenance, or an unavailable policy path", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const trustedPath = path.join(dir, "reviewer.md");
			const builtinPath = path.join(dir, "builtin-reviewer.md");
			writeFileSync(trustedPath, "trusted");
			writeFileSync(builtinPath, "builtin");
			const builtin = makeAgent("reviewer", "builtin", "builtin prompt", builtinPath);
			const result = mergeAgentsForScope("both", [], [], [builtin], [], JSON.stringify({ reviewer: trustedPath }));
			assert.match(result[0]?.trustedPathError ?? "", /Trusted agent 'reviewer' resolved to/);
			assert.throws(
				() => assertTrustedAgentPath("reviewer", undefined, JSON.stringify({ reviewer: trustedPath })),
				/has no persisted definition path/,
			);
			assert.throws(
				() => mergeAgentsForScope("both", [], [], [], [], JSON.stringify({ observer: path.join(dir, "missing.md") })),
				/Invalid PI_SUBAGENT_TRUSTED_AGENT_PATHS/,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects lexical and symlink-parent aliases in policy and resume paths", { skip: process.platform === "win32" ? "symlink creation requires elevated Windows permissions" : undefined }, () => {
		const dir = mkdtempSync(path.join(tmpdir(), "trusted-agent-selection-"));
		try {
			const realDir = path.join(dir, "real");
			const aliasDir = path.join(dir, "alias");
			mkdirSync(realDir);
			symlinkSync(realDir, aliasDir, "dir");
			const trustedPath = path.join(realDir, "reviewer.md");
			writeFileSync(trustedPath, "trusted");
			const aliasPath = path.join(aliasDir, "reviewer.md");
			assert.throws(
				() => mergeAgentsForScope("both", [], [], [], [], JSON.stringify({ reviewer: aliasPath })),
				/path must not traverse a symlink/,
			);
			const lexicalAlias = `${realDir}/nested/../reviewer.md`;
			assert.throws(
				() => mergeAgentsForScope("both", [], [], [], [], JSON.stringify({ reviewer: lexicalAlias })),
				/path must be exact and normalized/,
			);
			assert.throws(
				() => assertTrustedAgentPath("reviewer", lexicalAlias, JSON.stringify({ reviewer: trustedPath })),
				/ resolved to .* instead of /,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
