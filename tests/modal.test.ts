import {App} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {ImportUrlModal} from "../src/modal";
import {ImportHistoryEntry, ModelOption} from "../src/types";

const defaultModelOptions: ModelOption[] = [
	{id: "gpt-4o", label: "GPT-4o", description: "Default"},
	{id: "gpt-5.4", label: "GPT-5.4", description: "Stronger reasoning"},
];

function createHistoryEntry(): ImportHistoryEntry {
	return {
		id: "history-1",
		url: "https://example.com/post",
		host: "example.com",
		apiBaseUrl: "https://api.openai.com/v1",
		model: "gpt-5.4",
		submittedAt: "2026-04-16T10:00:00.000Z",
		status: "failed",
		progressStage: "failed",
		progressPercent: 100,
		progressMessage: "Import failed",
		progressUpdatedAt: "2026-04-16T10:01:00.000Z",
		errorMessage: "Test failure",
	};
}

describe("import modal", () => {
	it("submits typed URLs with the currently selected model", async () => {
		const onSubmit = vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "gpt-4o",
			recentImports: [],
			resolveApiBaseUrl: () => "https://api.openai.com/v1",
			onSubmit,
		});

		modal.onOpen();
		const input = modal.contentEl.querySelector("input");
		if (!input) {
			throw new Error("Expected modal input to exist.");
		}
		input.value = "https://example.com/article";

		(modal as unknown as {handleSubmit: () => void}).handleSubmit();
		expect(onSubmit).toHaveBeenCalledWith("https://example.com/article", "gpt-4o");
	});

	it("re-runs a history entry with its original URL and model", () => {
		const onSubmit = vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "gpt-4o",
			recentImports: [createHistoryEntry()],
			resolveApiBaseUrl: () => "https://api.openai.com/v1",
			onSubmit,
		});

		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const rerunButton = buttons.find((button) => button.textContent === "Re-import");
		if (!rerunButton) {
			throw new Error("Expected Re-import button to exist.");
		}

		rerunButton.click();
		expect(onSubmit).toHaveBeenCalledWith("https://example.com/post", "gpt-5.4");
	});
});
