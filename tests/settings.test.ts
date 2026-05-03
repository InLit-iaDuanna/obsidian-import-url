import {App} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {DEFAULT_API_SECRET_NAME, LEGACY_OPENAI_SECRET_NAME, readApiKeyValue, readSecretValue, removeSecretValue, writeSecretValue} from "../src/settings";

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

	it("falls back to the legacy API key name when the DeepSeek key is empty", async () => {
		const get = vi.fn().mockImplementation(async (key: string) => {
			if (key === DEFAULT_API_SECRET_NAME) {
				return null;
			}
			if (key === LEGACY_OPENAI_SECRET_NAME) {
				return "sk-legacy";
			}
			return null;
		});

		await expect(readApiKeyValue({
			secretStorage: {get},
		} as unknown as App, DEFAULT_API_SECRET_NAME)).resolves.toBe("sk-legacy");
	});

	it("falls back to the default DeepSeek key when a custom key name is empty", async () => {
		const get = vi.fn().mockImplementation(async (key: string) => {
			if (key === "custom-empty-key") {
				return null;
			}
			if (key === DEFAULT_API_SECRET_NAME) {
				return "sk-default";
			}
			return null;
		});

		await expect(readApiKeyValue({
			secretStorage: {get},
		} as unknown as App, "custom-empty-key")).resolves.toBe("sk-default");
	});
});
