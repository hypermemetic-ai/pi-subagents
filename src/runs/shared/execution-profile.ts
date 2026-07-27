import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from "node:fs";
import type { ExecutionProfileSelection, ExecutionProfileTelemetry } from "../../shared/types.ts";

const REQUIRED_FIELDS = ["effort", "model", "provider", "serviceClass"] as const;
const OPTIONAL_FIELDS = new Set(["acknowledgedServiceClass", "accountedServiceClass"]);

export function validateExecutionProfileReceiptMetadata(stat: Pick<Stats, "isFile" | "uid" | "mode" | "nlink">, uid = process.getuid?.()): void {
	if (!stat.isFile()) throw new Error("Trusted execution profile receipt must be a regular, non-symlink file.");
	if (uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
		throw new Error("Trusted execution profile receipt must be one current-user-owned mode-0600 regular file.");
	}
}

export function readExecutionProfileReceipt(
	receiptPath: string | undefined,
	expected: Readonly<ExecutionProfileSelection> | undefined,
): ExecutionProfileTelemetry | undefined {
	if (!expected) return undefined;
	if (!receiptPath) throw new Error("Trusted execution profile receipt path is missing.");
	let fd: number;
	try {
		fd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error("Trusted execution profile receipt must be a regular, non-symlink file.");
		}
		throw error;
	}
	let serialized: string;
	try {
		const before = fstatSync(fd);
		validateExecutionProfileReceiptMetadata(before);
		serialized = readFileSync(fd, "utf8");
		const after = fstatSync(fd);
		validateExecutionProfileReceiptMetadata(after);
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new Error("Trusted execution profile receipt changed while it was read.");
		}
	} finally {
		closeSync(fd);
	}
	const parsed = JSON.parse(serialized) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Trusted execution profile receipt must be an object.");
	}
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record);
	if (
		REQUIRED_FIELDS.some((key) => !keys.includes(key))
		|| keys.some((key) => !REQUIRED_FIELDS.includes(key as (typeof REQUIRED_FIELDS)[number]) && !OPTIONAL_FIELDS.has(key))
	) {
		throw new Error("Trusted execution profile receipt has an invalid shape.");
	}
	for (const key of keys) {
		if (typeof record[key] !== "string" || (record[key] as string).trim() === "") {
			throw new Error(`Trusted execution profile receipt field '${key}' must be a non-empty string.`);
		}
	}
	for (const key of REQUIRED_FIELDS) {
		if (record[key] !== expected[key]) {
			throw new Error(`Trusted execution profile receipt conflicts on '${key}'.`);
		}
	}
	return {
		provider: record.provider as string,
		model: record.model as string,
		effort: record.effort as string,
		serviceClass: record.serviceClass as string,
		...(record.acknowledgedServiceClass ? { acknowledgedServiceClass: record.acknowledgedServiceClass as string } : {}),
		...(record.accountedServiceClass ? { accountedServiceClass: record.accountedServiceClass as string } : {}),
	};
}

export function formatExecutionProfile(profile: ExecutionProfileTelemetry | undefined): string | undefined {
	if (!profile) return undefined;
	const acknowledgement = profile.acknowledgedServiceClass ?? "unacknowledged";
	return `${profile.provider}/${profile.model} • ${profile.effort} • service ${profile.serviceClass} → ${acknowledgement}`;
}
