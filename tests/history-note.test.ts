import {describe, expect, it} from "vitest";
import {buildHistoryFileName, renderHistoryNote} from "../src/render/history-note";

describe("history notes", () => {
	it("builds visible history filenames under a dated naming scheme", () => {
		expect(buildHistoryFileName("example.com", "beef", new Date(2026, 3, 13, 12, 34))).toBe(
			"2026-04-13 1234 - Import History - example.com - beef.md",
		);
	});

	it("renders a visible history note with status and final note path", () => {
		const note = renderHistoryNote({
			id: "1",
			url: "https://example.com",
			host: "example.com",
			apiBaseUrl: "https://api.openai.com/v1",
			model: "gpt-5-mini",
			submittedAt: "2026-04-13T12:34:00.000Z",
			status: "complete",
			progressStage: "complete",
			progressPercent: 100,
			progressMessage: "任务完成",
			progressUpdatedAt: "2026-04-13T12:35:00.000Z",
			title: "导入标题",
			notePath: "Inbox/Clippings/2026-04-13 1234 - 导入标题.md",
			sourceType: "webpage",
		});

		expect(note).toContain("# Import URL Record");
		expect(note).toContain("Progress: 100%");
		expect(note).toContain("Current Status: complete");
		expect(note).toContain("Final Note Path: Inbox/Clippings/2026-04-13 1234 - 导入标题.md");
	});
});
