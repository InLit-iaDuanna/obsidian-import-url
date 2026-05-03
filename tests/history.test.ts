import {describe, expect, it} from "vitest";
import {findActiveImportForUrl, findLatestImportForUrl, getPreferredImportOpenPath, groupRecentImports, normalizeRecentImports, upsertRecentImport} from "../src/history";
import {ImportHistoryEntry} from "../src/types";

const makeEntry = (id: string, submittedAt: string): ImportHistoryEntry => ({
	id,
	url: `https://example.com/${id}`,
	host: "example.com",
	apiBaseUrl: "https://api.deepseek.com",
	model: "deepseek-v4-flash",
	submittedAt,
	status: "complete",
	progressStage: "complete",
	progressPercent: 100,
	progressMessage: "任务完成",
	progressUpdatedAt: submittedAt,
});

describe("history helpers", () => {
	it("normalizes and sorts recent imports", () => {
		const entries = normalizeRecentImports([
			makeEntry("older", "2026-04-10T10:00:00.000Z"),
			makeEntry("newer", "2026-04-12T10:00:00.000Z"),
			{bad: true},
		]);

		expect(entries.map((entry) => entry.id)).toEqual(["newer", "older"]);
	});

	it("uses Chinese default progress messages for legacy history entries", () => {
		const entries = normalizeRecentImports([
			{
				id: "legacy-complete",
				url: "https://example.com/complete",
				host: "example.com",
				model: "deepseek-v4-flash",
				submittedAt: "2026-04-12T10:00:00.000Z",
				status: "complete",
			},
			{
				id: "legacy-failed",
				url: "https://example.com/failed",
				host: "example.com",
				model: "deepseek-v4-flash",
				submittedAt: "2026-04-11T10:00:00.000Z",
				status: "failed",
			},
			{
				id: "legacy-processing",
				url: "https://example.com/processing",
				host: "example.com",
				model: "deepseek-v4-flash",
				submittedAt: "2026-04-10T10:00:00.000Z",
				status: "processing",
			},
		]);

		expect(entries.map((entry) => entry.progressMessage)).toEqual(["导入完成", "导入失败", "已排队"]);
	});

	it("upserts entries by id", () => {
		const entries = upsertRecentImport(
			[makeEntry("a", "2026-04-10T10:00:00.000Z")],
			{...makeEntry("a", "2026-04-11T10:00:00.000Z"), status: "failed"},
		);

		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("failed");
	});

	it("groups entries by relative day buckets", () => {
		const groups = groupRecentImports([
			makeEntry("today", "2026-04-13T03:00:00.000Z"),
			makeEntry("yesterday", "2026-04-12T03:00:00.000Z"),
			makeEntry("week", "2026-04-09T03:00:00.000Z"),
			makeEntry("older", "2026-03-30T03:00:00.000Z"),
		], new Date("2026-04-13T12:00:00.000Z"));

		expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "最近 7 天", "更早"]);
	});

	it("finds the latest entry for the same URL even if the hash differs", () => {
		const latest = findLatestImportForUrl([
			makeEntry("older", "2026-04-10T10:00:00.000Z"),
			makeEntry("newer", "2026-04-12T10:00:00.000Z"),
		], "https://example.com/newer#section");

		expect(latest?.id).toBe("newer");
	});

	it("filters latest matches by status and model", () => {
		const latest = findLatestImportForUrl([
			{...makeEntry("processing", "2026-04-12T10:00:00.000Z"), status: "processing", progressStage: "fetching", progressPercent: 40},
			{...makeEntry("complete", "2026-04-13T10:00:00.000Z"), model: "gpt-4o"},
			{...makeEntry("failed", "2026-04-14T10:00:00.000Z"), status: "failed", progressStage: "failed", errorMessage: "boom"},
		], "https://example.com/complete", {
			model: "gpt-4o",
			statuses: ["complete"],
		});

		expect(latest?.id).toBe("complete");
	});

	it("finds an active import for the same URL and model", () => {
		const active = findActiveImportForUrl([
			{...makeEntry("processing-old", "2026-04-12T10:00:00.000Z"), status: "processing", progressStage: "fetching", progressPercent: 40, model: "gpt-4o"},
			{...makeEntry("processing-new", "2026-04-13T10:00:00.000Z"), status: "processing", progressStage: "ai_call", progressPercent: 70, model: "gpt-4o"},
			{...makeEntry("other-model", "2026-04-14T10:00:00.000Z"), status: "processing", progressStage: "queued", model: "gpt-5-mini"},
		], "https://example.com/processing-new#fragment", "gpt-4o");

		expect(active?.id).toBe("processing-new");
	});

	it("prefers the final note for completed imports and the history note otherwise", () => {
		expect(getPreferredImportOpenPath({
			...makeEntry("complete", "2026-04-14T10:00:00.000Z"),
			notePath: "我的知识库/成文/final.md",
			historyNotePath: "我的知识库/状态/历史记录/record.md",
		})).toBe("我的知识库/成文/final.md");

		expect(getPreferredImportOpenPath({
			...makeEntry("processing", "2026-04-14T10:00:00.000Z"),
			status: "processing",
			progressStage: "fetching",
			historyNotePath: "我的知识库/状态/历史记录/processing.md",
			notePath: "我的知识库/状态/处理中/task.md",
		})).toBe("我的知识库/状态/历史记录/processing.md");
	});
});
