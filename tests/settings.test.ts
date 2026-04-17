import {App} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {readSecretValue, removeSecretValue, writeSecretValue} from "../src/settings";

describe("secret storage compatibility", () => {
		it("reads from either get or getSecret", async () => {
			await expect(readSecretValue({
				secretStorage: {
					get: vi.fn().mockResolvedValue("sk-from-get"),
				},
			} as unknown as App, "key")).resolves.toBe("sk-from-get");

			await expect(readSecretValue({
				secretStorage: {
					getSecret: vi.fn().mockResolvedValue("sk-from-getSecret"),
				},
			} as unknown as App, "key")).resolves.toBe("sk-from-getSecret");
		});

	it("writes and removes using compatible method names", async () => {
		const setSecret = vi.fn().mockResolvedValue(undefined);
		const removeSecret = vi.fn().mockResolvedValue(undefined);

			await expect(writeSecretValue({
				secretStorage: {
					setSecret,
				},
			} as unknown as App, "key", "value")).resolves.toBe(true);

			await expect(removeSecretValue({
				secretStorage: {
					removeSecret,
				},
			} as unknown as App, "key")).resolves.toBe(true);

		expect(setSecret).toHaveBeenCalledWith("key", "value");
		expect(removeSecret).toHaveBeenCalledWith("key");
	});
});
