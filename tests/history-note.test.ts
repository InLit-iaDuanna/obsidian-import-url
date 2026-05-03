import {describe, expect, it} from "vitest";
import {buildHistoryFileName, renderHistoryNote} from "../src/render/history-note";

describe("history notes", () => {
	it("builds visible history filenames under a dated naming scheme", () => {
		expect(buildHistoryFileName("example.com", new Date(2026, 3, 13, 12, 34))).toBe(
			"2026-04-13 1234 - 导入记录 - example.com.md",
		);
	});

	it("renders a visible history note with status and final note path", () => {
		const note = renderHistoryNote({
			id: "1",
			url: "https://example.com",
			host: "example.com",
				apiBaseUrl: "https://api.deepseek.com",
				model: "deepseek-v4-flash",
			submittedAt: "2026-04-13T12:34:00.000Z",
			status: "complete",
			progressStage: "complete",
			progressPercent: 100,
			progressMessage: "任务完成",
			progressUpdatedAt: "2026-04-13T12:35:00.000Z",
			title: "导入标题",
			notePath: "我的知识库/成文/2026-04-13 1234 - AI整理 - 导入标题.md",
			originalNotePath: "我的知识库/原文/2026-04-13 1234 - 原文 - 导入标题.md",
			sourceType: "webpage",
		});

			expect(note).toContain("# URL 导入记录");
			expect(note).toContain("进度：100%");
			expect(note).toContain("阶段：完成");
			expect(note).toContain("当前状态：完成");
			expect(note).toContain("来源类型：网页");
			expect(note).toContain("AI 整理笔记路径：我的知识库/成文/2026-04-13 1234 - AI整理 - 导入标题.md");
			expect(note).toContain("原文笔记路径：我的知识库/原文/2026-04-13 1234 - 原文 - 导入标题.md");
			expect(note).not.toContain("[[我的知识库/成文/2026-04-13 1234 - AI整理 - 导入标题]]");
			expect(note).not.toContain("[[我的知识库/原文/2026-04-13 1234 - 原文 - 导入标题]]");
		});
	});
