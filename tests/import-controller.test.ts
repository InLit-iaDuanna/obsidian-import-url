import {describe, expect, it, vi} from "vitest";
import {ImportController} from "../src/import-controller";
import {DEFAULT_SETTINGS} from "../src/settings";
import {ImportHistoryEntry, JobRunResult} from "../src/types";
import {createFakeApp} from "./helpers";

function makeProcessingEntry(overrides: Partial<ImportHistoryEntry> = {}): ImportHistoryEntry {
	return {
		id: "history-processing",
		url: "https://example.com/article",
		host: "example.com",
		apiBaseUrl: "https://api.openai.com/v1",
		model: "gpt-4o",
		submittedAt: "2026-04-20T10:00:00.000Z",
		status: "processing",
		progressStage: "fetching",
		progressPercent: 45,
		progressMessage: "Fetching",
		progressUpdatedAt: "2026-04-20T10:01:00.000Z",
		historyNotePath: "Inbox/Clippings/History/existing-record.md",
		...overrides,
	};
}

function createPluginStub(entries: ImportHistoryEntry[] = []) {
	const {app, vault, workspace} = createFakeApp();
	const plugin = {
		app,
		settings: {
			...DEFAULT_SETTINGS,
			model: "gpt-4o",
			recentImports: entries,
		},
		saveSettings: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};

	return {plugin, vault, workspace};
}

describe("import controller", () => {
	it("marks stale processing entries failed before starting a replacement import", async () => {
		const staleEntry = makeProcessingEntry();
		const {plugin} = createPluginStub([staleEntry]);
		const controller = new ImportController(plugin as never);
		const jobResult: JobRunResult = {
			status: "complete",
			url: "https://example.com/article",
			model: "gpt-4o",
			title: "Imported title",
			notePath: "Inbox/Clippings/final-note.md",
			sourceType: "webpage",
		};
		const run = vi.fn<() => Promise<JobRunResult>>().mockResolvedValue(jobResult);

		vi.spyOn(controller as never, "refreshEffectiveSettings").mockResolvedValue(plugin.settings);
		(controller as unknown as {jobRunner: {isBusy: () => boolean; run: typeof run}}).jobRunner = {
			isBusy: () => false,
			run,
		};

		await (controller as unknown as {startImport: (rawUrl: string, model: string) => Promise<void>}).startImport(
			"https://example.com/article#section",
			"gpt-4o",
		);

		expect(run).toHaveBeenCalledTimes(1);

		const updatedStaleEntry = plugin.settings.recentImports.find((entry) => entry.id === staleEntry.id);
		expect(updatedStaleEntry?.status).toBe("failed");
		expect(updatedStaleEntry?.progressStage).toBe("failed");
		expect(updatedStaleEntry?.progressMessage).toBe("Previous import did not finish.");
		expect(updatedStaleEntry?.errorMessage).toBe("Previous import did not finish.");

		const replacementEntry = plugin.settings.recentImports.find((entry) => entry.id !== staleEntry.id);
		expect(replacementEntry?.status).toBe("complete");
		expect(replacementEntry?.notePath).toBe("Inbox/Clippings/final-note.md");
	});

	it("treats the current in-memory run as active instead of marking it stale", async () => {
		const activeEntry = makeProcessingEntry({
			id: "history-active",
			historyNotePath: "Inbox/Clippings/History/current-record.md",
		});
		const {plugin} = createPluginStub([activeEntry]);
		const controller = new ImportController(plugin as never);
		const run = vi.fn();
		const openVaultPath = vi.spyOn(controller as never, "openVaultPath").mockResolvedValue(true);

		vi.spyOn(controller as never, "refreshEffectiveSettings").mockResolvedValue(plugin.settings);
		(controller as unknown as {jobRunner: {isBusy: () => boolean; run: typeof run}}).jobRunner = {
			isBusy: () => true,
			run,
		};
		(controller as unknown as {activeRunHistoryId: string | null}).activeRunHistoryId = activeEntry.id;

		await (controller as unknown as {startImport: (rawUrl: string, model: string) => Promise<void>}).startImport(
			"https://example.com/article",
			"gpt-4o",
		);

		expect(run).not.toHaveBeenCalled();
		expect(openVaultPath).toHaveBeenCalledWith("Inbox/Clippings/History/current-record.md");
		expect(plugin.settings.recentImports[0]?.status).toBe("processing");
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});
});
