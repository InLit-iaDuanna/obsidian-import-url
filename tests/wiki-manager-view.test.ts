import {WorkspaceLeaf} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {WikiManagerView} from "../src/wiki-manager-view";
import {FAKE_CONFIG_DIR} from "./helpers";

function createOverview() {
	return {
		candidates: [
			{
				path: "我的知识库/概念库/待入库/候选.md",
				title: "候选概念",
				generatedAt: "2026-04-13T12:34:56+08:00",
				confidence: "0.8",
				sourceUrl: "https://example.com",
				sourceNotePath: "我的知识库/成文/a.md",
				targetConceptPath: "我的知识库/概念库/已入库/候选概念.md",
				targetConceptExists: false,
				linkCount: 2,
			},
		],
		concepts: [
			{
				path: "我的知识库/概念库/已入库/已入库概念.md",
				title: "已入库概念",
				createdAt: "2026-04-13T12:34:56+08:00",
				updatedAt: "2026-04-14T12:34:56+08:00",
				graphVisible: true,
				linkCount: 5,
			},
		],
	};
}

describe("wiki manager view", () => {
	it("renders pending records with default graph visibility on", async () => {
		const approveCandidate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const view = new WikiManagerView(new WorkspaceLeaf(), {
			loadOverview: vi.fn().mockResolvedValue(createOverview()),
			approveCandidate,
			rejectCandidate: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			setConceptGraphVisibility: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			applyGraphColorGroups: vi.fn<() => Promise<{graphPath: string; added: number; updated: number; unchanged: number; total: number; preserved: number}>>().mockResolvedValue({graphPath: `${FAKE_CONFIG_DIR}/graph.json`, added: 6, updated: 0, unchanged: 0, total: 6, preserved: 0}),
			cleanupLegacyGraphLinks: vi.fn<() => Promise<number>>().mockResolvedValue(0),
			rebuildConceptGraph: vi.fn<() => Promise<{cleanedFiles: number; updatedConcepts: number; taggedFiles: number}>>().mockResolvedValue({cleanedFiles: 0, updatedConcepts: 0, taggedFiles: 0}),
			openPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
		});

		await view.onOpen();

		expect(view.contentEl.textContent).toContain("候选概念");
		expect(view.contentEl.textContent).toContain("图谱颜色分组");
		expect(view.contentEl.textContent).toContain("应用到 Obsidian 图谱");
		expect(view.contentEl.textContent).toContain("已入库概念");
		expect(view.contentEl.textContent).toContain("待入库候选");
		expect(view.contentEl.textContent).toContain("tag:#import-url/concept");
		expect(view.contentEl.textContent).toContain("tag:#import-url/candidate");
		expect(view.contentEl.textContent).toContain("-tag:#import-url/generated");
		expect(view.contentEl.textContent).toContain("批准后创建正式概念页");
		expect(view.contentEl.querySelector(".import-url-wiki-meta-grid")?.textContent).toContain("链接次数2");
		const graphSwitch = view.contentEl.querySelector<HTMLInputElement>(".import-url-wiki-switch input");
		expect(graphSwitch?.checked).toBe(true);

		const approveButton = Array.from(view.contentEl.querySelectorAll("button")).find((button) => button.textContent === "入库");
		if (!approveButton) {
			throw new Error("Expected 入库 button to exist.");
		}
		approveButton.click();
		await Promise.resolve();
		expect(approveCandidate).toHaveBeenCalledWith("我的知识库/概念库/待入库/候选.md", true);
	});
});
