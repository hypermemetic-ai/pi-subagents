import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { formatExecutionProfile, readExecutionProfileReceipt } from "../../src/runs/shared/execution-profile.ts";

const expected = {
	provider: "kimi-coding",
	model: "k3",
	effort: "max",
	serviceClass: "provider-default",
} as const;

function withReceipt(value: unknown, run: (receiptPath: string, dir: string) => void): void {
	const dir = mkdtempSync(path.join(tmpdir(), "execution-profile-receipt-"));
	try {
		const receiptPath = path.join(dir, "receipt.json");
		writeFileSync(receiptPath, JSON.stringify(value));
		run(receiptPath, dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("execution profile receipt", () => {
	it("accepts selected profile plus provider acknowledgement and accounting", () => {
		const value = {
			...expected,
			acknowledgedServiceClass: "default",
			accountedServiceClass: "default",
		};
		withReceipt(value, (receiptPath) => {
			assert.deepEqual(readExecutionProfileReceipt(receiptPath, expected), value);
			assert.equal(
				formatExecutionProfile(value),
				"kimi-coding/k3 • max • service provider-default → default",
			);
		});
	});

	it("preserves truthful absent acknowledgement while retaining selected profile", () => {
		withReceipt(expected, (receiptPath) => {
			assert.deepEqual(readExecutionProfileReceipt(receiptPath, expected), expected);
			assert.equal(formatExecutionProfile(expected), "kimi-coding/k3 • max • service provider-default → unacknowledged");
		});
	});

	it("fails closed on missing, malformed, or conflicting receipts", () => {
		withReceipt({ ...expected, model: "other" }, (receiptPath, dir) => {
			assert.throws(() => readExecutionProfileReceipt(receiptPath, expected), /conflicts on 'model'/);
			assert.throws(() => readExecutionProfileReceipt(path.join(dir, "missing.json"), expected), /ENOENT/);
		});
		withReceipt({ ...expected, extra: "forged" }, (receiptPath) => {
			assert.throws(() => readExecutionProfileReceipt(receiptPath, expected), /invalid shape/);
		});
		withReceipt({ ...expected, acknowledgedServiceClass: "" }, (receiptPath) => {
			assert.throws(() => readExecutionProfileReceipt(receiptPath, expected), /must be a non-empty string/);
		});
	});

	it("rejects a symlink receipt", { skip: process.platform === "win32" ? "symlink creation requires elevated Windows permissions" : undefined }, () => {
		withReceipt(expected, (receiptPath, dir) => {
			const aliasPath = path.join(dir, "alias.json");
			symlinkSync(receiptPath, aliasPath);
			assert.throws(() => readExecutionProfileReceipt(aliasPath, expected), /regular, non-symlink file/);
		});
	});

	it("does nothing when no trusted profile was selected", () => {
		assert.equal(readExecutionProfileReceipt(undefined, undefined), undefined);
	});
});
