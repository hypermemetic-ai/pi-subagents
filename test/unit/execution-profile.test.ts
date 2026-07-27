import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { combineExecutionProfileReceiptError, formatExecutionProfile, readExecutionProfileReceipt, validateExecutionProfileReceiptMetadata } from "../../src/runs/shared/execution-profile.ts";

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
		writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
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

	it("rejects public, multiply linked, or differently owned receipt metadata", () => {
		withReceipt(expected, (receiptPath, dir) => {
			chmodSync(receiptPath, 0o644);
			assert.throws(() => readExecutionProfileReceipt(receiptPath, expected), /current-user-owned mode-0600/);
			chmodSync(receiptPath, 0o600);
			linkSync(receiptPath, path.join(dir, "hardlink.json"));
			assert.throws(() => readExecutionProfileReceipt(receiptPath, expected), /current-user-owned mode-0600/);
		});
		assert.throws(() => validateExecutionProfileReceiptMetadata({ isFile: () => true, uid: 1, mode: 0o100600, nlink: 1 }, 2), /current-user-owned mode-0600/);
	});

	it("retains a primary child failure when receipt validation also fails", () => {
		assert.equal(combineExecutionProfileReceiptError("child startup failed", undefined), "child startup failed");
		assert.equal(combineExecutionProfileReceiptError(undefined, "receipt missing"), "receipt missing");
		assert.equal(
			combineExecutionProfileReceiptError("child startup failed", "receipt missing"),
			"child startup failed\nSecondary trusted execution profile receipt failure: receipt missing",
		);
	});

	it("does nothing when no trusted profile was selected", () => {
		assert.equal(readExecutionProfileReceipt(undefined, undefined), undefined);
	});
});
