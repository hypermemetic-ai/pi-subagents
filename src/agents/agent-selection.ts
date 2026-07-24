import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, AgentScope } from "./agents.ts";

export const TRUSTED_AGENT_PATHS_ENV = "PI_SUBAGENT_TRUSTED_AGENT_PATHS";

function trustedAgentPaths(raw: string): Map<string, string> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: expected a non-empty object mapping agent names to absolute files.`);
	}

	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) {
		throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: expected at least one trusted agent path.`);
	}

	const policy = new Map<string, string>();
	const seenPaths = new Set<string>();
	for (const [name, candidate] of entries) {
		if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: '${name}' is not a valid agent name.`);
		}
		if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: '${name}' must map to an absolute file path.`);
		}
		const resolved = path.resolve(candidate);
		if (candidate !== resolved) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: '${name}' path must be exact and normalized; received '${candidate}'.`);
		}
		let canonical: string;
		try {
			const stat = lstatSync(resolved);
			if (!stat.isFile() || stat.isSymbolicLink()) {
				throw new Error("expected a regular, non-symlink file");
			}
			canonical = realpathSync(resolved);
		} catch (error) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: '${name}' path '${resolved}' is unavailable (${error instanceof Error ? error.message : String(error)}).`);
		}
		if (candidate !== canonical) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: '${name}' path must not traverse a symlink; received '${candidate}'.`);
		}
		if (seenPaths.has(canonical)) {
			throw new Error(`Invalid ${TRUSTED_AGENT_PATHS_ENV}: multiple agents map to '${canonical}'.`);
		}
		seenPaths.add(canonical);
		policy.set(name, canonical);
	}
	return policy;
}

function assertTrustedAgentPathFromPolicy(name: string, agentFilePath: string | undefined, policy: Map<string, string>): void {
	const expectedPath = policy.get(name);
	if (!expectedPath) return;
	if (!agentFilePath) {
		throw new Error(`Trusted agent '${name}' has no persisted definition path; expected '${expectedPath}'.`);
	}
	if (agentFilePath !== expectedPath) {
		throw new Error(`Trusted agent '${name}' resolved to '${agentFilePath}' instead of '${expectedPath}'.`);
	}
	const selectedPath = path.resolve(agentFilePath);
	let selectedCanonical: string;
	try {
		selectedCanonical = realpathSync(selectedPath);
	} catch (error) {
		throw new Error(`Trusted agent '${name}' selected unavailable definition '${selectedPath}' (${error instanceof Error ? error.message : String(error)}).`);
	}
	if (selectedPath !== expectedPath || selectedCanonical !== expectedPath) {
		throw new Error(`Trusted agent '${name}' definition '${agentFilePath}' no longer resolves to '${expectedPath}'.`);
	}
}

export function assertTrustedAgentPath(
	name: string,
	agentFilePath: string | undefined,
	raw: string | undefined = process.env[TRUSTED_AGENT_PATHS_ENV],
): void {
	if (raw === undefined) return;
	assertTrustedAgentPathFromPolicy(name, agentFilePath, trustedAgentPaths(raw));
}

function enforceTrustedAgentPaths(agents: AgentConfig[], raw: string | undefined): AgentConfig[] {
	if (raw === undefined) return agents;
	const policy = trustedAgentPaths(raw);
	return agents.map((agent) => {
		if (!policy.has(agent.name)) return agent;
		try {
			assertTrustedAgentPathFromPolicy(agent.name, agent.filePath, policy);
			if (agent.override) {
				throw new Error(`Trusted agent '${agent.name}' was modified by ${agent.override.scope} override '${agent.override.path}'.`);
			}
			return agent;
		} catch (error) {
			return {
				...agent,
				trustedPathError: error instanceof Error ? error.message : String(error),
			};
		}
	});
}

export function mergeAgentsForScope(
	scope: AgentScope,
	userAgents: AgentConfig[],
	projectAgents: AgentConfig[],
	builtinAgents: AgentConfig[] = [],
	packageAgents: AgentConfig[] = [],
	trustedAgentPathsRaw: string | undefined = process.env[TRUSTED_AGENT_PATHS_ENV],
): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);
	for (const agent of packageAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return enforceTrustedAgentPaths(Array.from(agentMap.values()), trustedAgentPathsRaw);
}
