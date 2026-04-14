import {describe, expect, it} from "vitest";
import {groupRecentImports, normalizeRecentImports, upsertRecentImport} from "../src/history";
import {ImportHistoryEntry} from "../src/types";

const makeEntry = (id: string, submittedAt: string): ImportHistoryEntry => ({
	id,
	url: `https://example.com/${id}`,
	host: "example.com",
	apiBaseUrl: "https://api.openai.com/v1",
	model: "gpt-5-mini",
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

		expect(groups.map((group) => group.label)).toEqual(["今天", "昨天", "近 7 天", "更早"]);
	});
});
