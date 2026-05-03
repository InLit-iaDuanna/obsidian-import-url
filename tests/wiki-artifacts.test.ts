import {describe, expect, it} from "vitest";
import {
	approveActiveWikiCandidate,
	approveWikiCandidateByPath,
	cleanupLegacyConceptGraphLinks,
	getWikiOverview,
	rebuildWikiConceptGraph,
	rejectActiveWikiCandidate,
	setWikiConceptGraphVisibility,
	writeWikiArtifacts,
} from "../src/wiki-artifacts";
import {DEFAULT_SETTINGS} from "../src/settings";
import {createFakeApp} from "./helpers";

const digest = {
	title: "整理标题",
	summary: "总结",
	keyPoints: [],
	keyFacts: [],
	actionItems: [],
	fullOrganizedMarkdown: "# 正文",
	concepts: [
		{
			title: "核心概念",
			aliases: ["概念别名"],
			summary: "概念摘要",
			evidence: ["正文证据"],
			relatedConcepts: ["相关概念"],
			confidence: 0.8,
		},
	],
	suggestedTags: [],
	warnings: [],
};

describe("wiki artifacts", () => {
	it("writes source records, candidate notes, and a wiki index", async () => {
		const {app, vault} = createFakeApp();

		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/article",
			sourceType: "webpage",
			sourceTitle: "Example",
			notePath: "我的知识库/成文/final.md",
			digest,
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 34, 56),
			suffix: "beef",
		});

		const files = vault.listFiles().map((file) => file.path);
		expect(files).toContain("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md");
		expect(files).toContain("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md");
		expect(files).toContain("我的知识库/概念库/索引.md");
		expect(vault.read("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md")).toContain("# 来源 - 整理标题");
		expect(vault.read("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md")).toContain("graph_group: 'import-url-wiki-source'");
		expect(vault.read("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md")).toContain("'import-url/source'");
		expect(vault.read("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md")).toContain("结果笔记路径：我的知识库/成文/final.md");
		expect(vault.read("我的知识库/概念库/来源/2026-04-13 1234 - 整理标题.md")).not.toContain("[[我的知识库/final]]");
		expect(vault.read("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md")).toContain("status: 'pending'");
		expect(vault.read("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md")).toContain("graph_group: 'import-url-wiki-candidate'");
		expect(vault.read("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md")).toContain("'import-url/candidate'");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("# 知识库索引");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("graph_group: 'import-url-status'");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("'import-url/index'");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("## 待入库概念");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("## 已入库概念");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md");
		expect(vault.read("我的知识库/概念库/索引.md")).not.toContain("[[");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("- 核心概念 · 候选页：");
	});

	it("approves and rejects current wiki candidates without overwriting concept pages", async () => {
		const {app, vault, workspace} = createFakeApp();
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/article",
			sourceType: "webpage",
			sourceTitle: "Example",
			notePath: "我的知识库/成文/final.md",
			digest,
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 34, 56),
			suffix: "beef",
		});

		const candidate = vault.getAbstractFileByPath("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md");
		if (!candidate || !("content" in candidate)) {
			throw new Error("Candidate was not created");
		}
		workspace.setActiveFile(candidate);
		await approveActiveWikiCandidate(app, DEFAULT_SETTINGS);

		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).toContain("# 核心概念");
		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).toContain("graph_group: 'import-url-concept'");
		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).toContain("'import-url/concept'");
		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).toContain("graph: 'show'");
		expect(vault.read("我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md")).toContain("status: 'approved'");
		expect(vault.read("我的知识库/概念库/索引.md")).toContain("核心概念（我的知识库/概念库/已入库/核心概念.md）");
		expect(vault.read("我的知识库/概念库/索引.md")).not.toContain("[[");

		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/other",
			sourceType: "webpage",
			sourceTitle: "Other",
			notePath: "我的知识库/成文/other.md",
			digest: {
				...digest,
				concepts: [{...digest.concepts[0]!, evidence: ["第二条证据"]}],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 14, 9, 0, 0),
			suffix: "cafe",
		});

		const secondCandidate = vault.getAbstractFileByPath("我的知识库/概念库/待入库/2026-04-14 0900 - 核心概念.md");
		if (!secondCandidate || !("content" in secondCandidate)) {
			throw new Error("Second candidate was not created");
		}
		workspace.setActiveFile(secondCandidate);
		await rejectActiveWikiCandidate(app, DEFAULT_SETTINGS);

		expect(vault.listFiles().map((file) => file.path)).toContain("我的知识库/概念库/待入库/已拒绝/2026-04-14 0900 - 核心概念.md");
		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).not.toContain("第二条证据");
		expect(vault.read("我的知识库/概念库/索引.md")).not.toContain("[[");
	});

	it("approves candidates as hidden concepts and toggles graph visibility", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/成文/final.md", "[[我的知识库/概念库/已入库/核心概念|核心概念]]\n[[核心概念]]");
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/article",
			sourceType: "webpage",
			sourceTitle: "Example",
			notePath: "我的知识库/成文/final.md",
			digest,
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 34, 56),
			suffix: "beef",
		});

		await approveWikiCandidateByPath(
			app,
			DEFAULT_SETTINGS,
			"我的知识库/概念库/待入库/2026-04-13 1234 - 核心概念.md",
			{graphVisible: false},
		);

		const hiddenConcept = vault.read("我的知识库/概念库/已入库/核心概念.md");
		expect(hiddenConcept).toContain("graph: 'hide'");
		const hiddenIndex = vault.read("我的知识库/概念库/索引.md");
		expect(hiddenIndex).toContain("核心概念（我的知识库/概念库/已入库/核心概念.md）");
		expect(hiddenIndex).not.toContain("[[");
		expect(hiddenIndex).toContain("链接次数：2");

		await setWikiConceptGraphVisibility(app, DEFAULT_SETTINGS, "我的知识库/概念库/已入库/核心概念.md", true);

		expect(vault.read("我的知识库/概念库/已入库/核心概念.md")).toContain("graph: 'show'");
		expect(vault.read("我的知识库/概念库/索引.md")).not.toContain("[[");
	});

	it("loads wiki overview with sorting and link counts", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/成文/linking-note.md", [
			"[[我的知识库/概念库/已入库/乙概念|乙概念]]",
			"[[乙概念]]",
			"[[我的知识库/概念库/已入库/甲概念|甲概念]]",
		].join("\n"));

		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/a",
			sourceType: "webpage",
			sourceTitle: "A",
			notePath: "我的知识库/成文/a.md",
			digest: {
				...digest,
				concepts: [{...digest.concepts[0]!, title: "甲概念"}],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 0, 0),
			suffix: "aaaa",
		});
		await approveWikiCandidateByPath(app, DEFAULT_SETTINGS, "我的知识库/概念库/待入库/2026-04-13 1200 - 甲概念.md");
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/b",
			sourceType: "webpage",
			sourceTitle: "B",
			notePath: "我的知识库/成文/b.md",
			digest: {
				...digest,
				concepts: [{...digest.concepts[0]!, title: "乙概念"}],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 14, 12, 0, 0),
			suffix: "bbbb",
		});
		await approveWikiCandidateByPath(app, DEFAULT_SETTINGS, "我的知识库/概念库/待入库/2026-04-14 1200 - 乙概念.md");

		const byInitial = await getWikiOverview(app, DEFAULT_SETTINGS, "initial");
		expect(byInitial.concepts.map((concept) => concept.title)).toEqual(["甲概念", "乙概念"]);

		const byImported = await getWikiOverview(app, DEFAULT_SETTINGS, "imported");
		expect(byImported.concepts.map((concept) => concept.title)).toEqual(["乙概念", "甲概念"]);

		const byLinks = await getWikiOverview(app, DEFAULT_SETTINGS, "links");
		expect(byLinks.concepts.map((concept) => `${concept.title}:${concept.linkCount}`)).toEqual(["乙概念:2", "甲概念:1"]);
	});

	it("keeps pending candidates and approved concepts separate in overview", async () => {
		const {app} = createFakeApp();
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/a",
			sourceType: "webpage",
			sourceTitle: "A",
			notePath: "我的知识库/成文/a.md",
			digest,
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 0, 0),
			suffix: "aaaa",
		});
		await approveWikiCandidateByPath(app, DEFAULT_SETTINGS, "我的知识库/概念库/待入库/2026-04-13 1200 - 核心概念.md");
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/b",
			sourceType: "webpage",
			sourceTitle: "B",
			notePath: "我的知识库/成文/b.md",
			digest,
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 14, 12, 0, 0),
			suffix: "bbbb",
		});

		const overview = await getWikiOverview(app, DEFAULT_SETTINGS, "initial");
		expect(overview.concepts.map((concept) => concept.title)).toEqual(["核心概念"]);
		expect(overview.candidates.map((candidate) => candidate.title)).toEqual(["核心概念"]);
		expect(overview.candidates[0]?.targetConceptExists).toBe(true);
		expect(overview.candidates[0]?.targetConceptPath).toBe("我的知识库/概念库/已入库/核心概念.md");
	});

	it("cleans legacy concept wikilinks from generated AI notes", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/成文/2026-04-13 1234 - AI整理 - 旧笔记.md", [
			"# AI 结构化整理",
			"",
			"## 相关概念",
			"",
			"- [[我的知识库/概念库/已入库/核心概念|核心概念]] - 概念摘要",
			"",
			"# 来源",
			"",
			"- 原始链接：https://example.com",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/核心概念.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '核心概念'",
			"created_at: '2026-04-13T12:34:56+08:00'",
			"updated_at: '2026-04-13T12:34:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 核心概念",
		].join("\n"));

		const changedCount = await cleanupLegacyConceptGraphLinks(app, DEFAULT_SETTINGS);

		expect(changedCount).toBe(1);
		const cleaned = vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 旧笔记.md");
		expect(cleaned).toContain("## 待入库概念");
		expect(cleaned).toContain("- 核心概念 - 概念摘要");
		expect(cleaned).not.toContain("[[我的知识库/概念库/已入库/核心概念|核心概念]]");
	});

	it("filters noisy concept candidates", async () => {
		const {app, vault} = createFakeApp();

		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/noisy",
			sourceType: "webpage",
			sourceTitle: "Noisy",
			notePath: "我的知识库/成文/noisy.md",
			digest: {
				...digest,
				concepts: [
					{...digest.concepts[0]!, title: "也"},
					{...digest.concepts[0]!, title: "4"},
					{...digest.concepts[0]!, title: "dca97c421426b666c3911c2ebde05a16"},
					{...digest.concepts[0]!, title: "未命名 3"},
					{...digest.concepts[0]!, title: "PPT Agent"},
				],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 34, 56),
			suffix: "beef",
		});

		const candidatePaths = vault.listFiles()
			.map((file) => file.path)
			.filter((path) => path.startsWith("我的知识库/概念库/待入库/"));
		expect(candidatePaths).toEqual(["我的知识库/概念库/待入库/2026-04-13 1234 - PPT Agent.md"]);
	});

	it("rebuilds the graph from approved concept relationships only", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/成文/2026-04-13 1234 - AI整理 - 材料.md", [
			"# AI 结构化整理",
			"",
			"## 待入库概念",
			"",
			"- [[我的知识库/概念库/已入库/PPT Agent|PPT Agent]] - legacy",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/PPT Agent.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: 'PPT Agent'",
			"created_at: '2026-04-13T12:34:56+08:00'",
			"updated_at: '2026-04-13T12:34:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# PPT Agent",
			"",
			"## 当前摘要",
			"",
			"PPT Agent 需要理解 需求调研，但这只是正文共现，不应自动连线。",
			"",
			"## 相关概念",
			"",
			"- 需求调研",
			"",
			"## 真实关联",
			"",
			"- [[我的知识库/概念库/已入库/无关旧链接|无关旧链接]]",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/需求调研.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '需求调研'",
			"created_at: '2026-04-13T12:35:56+08:00'",
			"updated_at: '2026-04-13T12:35:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 需求调研",
		].join("\n"));
		await vault.create("我的知识库/概念库/索引.md", "[[我的知识库/概念库/已入库/PPT Agent|PPT Agent]]");

		const result = await rebuildWikiConceptGraph(app, DEFAULT_SETTINGS);

		expect(result.cleanedFiles).toBeGreaterThan(0);
		expect(result.updatedConcepts).toBeGreaterThan(0);
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 材料.md")).not.toContain("[[");
		expect(vault.read("我的知识库/概念库/索引.md")).not.toContain("[[");
		const pptAgent = vault.read("我的知识库/概念库/已入库/PPT Agent.md");
		expect(pptAgent).toContain("## 真实关联");
		expect(pptAgent).toContain("[[我的知识库/概念库/已入库/需求调研|需求调研]]");
		expect(pptAgent).not.toContain("无关旧链接");
	});

	it("backfills graph color metadata for old generated artifacts only", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/成文/2026-04-13 1234 - AI整理 - 旧成文.md", [
			"---",
			"source_url: 'https://example.com/article'",
			"source_type: 'webpage'",
			"title: '旧成文'",
			"tags:",
			"  - 'custom/tag'",
			"---",
			"",
			"# 旧成文",
			"",
			"## 待入库概念",
			"",
			"- 核心概念",
		].join("\n"));
		await vault.create("我的知识库/原文/2026-04-13 1234 - 原文 - 旧成文.md", [
			"---",
			"source_url: 'https://example.com/article'",
			"source_type: 'webpage'",
			"title: '原文 - 旧成文'",
			"---",
			"",
			"# 原文",
			"",
			"正文",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/核心概念.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '核心概念'",
			"created_at: '2026-04-13T12:34:56+08:00'",
			"updated_at: '2026-04-13T12:34:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 核心概念",
		].join("\n"));
		await vault.create("我的知识库/手写.md", [
			"# 手写笔记",
			"",
			"这篇不是插件生成的笔记。",
		].join("\n"));

		const result = await rebuildWikiConceptGraph(app, DEFAULT_SETTINGS);

		expect(result.taggedFiles).toBeGreaterThanOrEqual(3);
		const article = vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 旧成文.md");
		expect(article).toContain("graph_group: 'import-url-article'");
		expect(article).toContain("'import-url/article'");
		expect(article).toContain("'import-url/generated'");
		expect(article).toContain("'custom/tag'");
		const original = vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 旧成文.md");
		expect(original).toContain("graph_group: 'import-url-original'");
		expect(original).toContain("'import-url/original'");
		const concept = vault.read("我的知识库/概念库/已入库/核心概念.md");
		expect(concept).toContain("graph_group: 'import-url-concept'");
		expect(concept).toContain("'import-url/concept'");
		expect(vault.read("我的知识库/手写.md")).not.toContain("import-url/");
	});

	it("does not infer graph links from body co-occurrence alone", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/概念库/已入库/PPT Agent.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: 'PPT Agent'",
			"created_at: '2026-04-13T12:34:56+08:00'",
			"updated_at: '2026-04-13T12:34:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# PPT Agent",
			"",
			"## 当前摘要",
			"",
			"PPT Agent 和 需求调研 出现在同一段，但没有明确相关概念。",
			"",
			"## 真实关联",
			"",
			"- 无",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/需求调研.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '需求调研'",
			"created_at: '2026-04-13T12:35:56+08:00'",
			"updated_at: '2026-04-13T12:35:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 需求调研",
		].join("\n"));

		await rebuildWikiConceptGraph(app, DEFAULT_SETTINGS);

		const pptAgent = vault.read("我的知识库/概念库/已入库/PPT Agent.md");
		expect(pptAgent).toContain("## 真实关联");
		expect(pptAgent).toContain("- 无");
		expect(pptAgent).not.toContain("[[我的知识库/概念库/已入库/需求调研|需求调研]]");
	});

	it("keeps multiple explicit graph relations from one related concepts section", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/概念库/已入库/PPT Agent.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: 'PPT Agent'",
			"created_at: '2026-04-13T12:34:56+08:00'",
			"updated_at: '2026-04-13T12:34:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# PPT Agent",
			"",
			"## 相关概念",
			"",
			"- 需求调研",
			"- 内容生成",
			"",
			"## 真实关联",
			"",
			"- 无",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/需求调研.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '需求调研'",
			"created_at: '2026-04-13T12:35:56+08:00'",
			"updated_at: '2026-04-13T12:35:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 需求调研",
		].join("\n"));
		await vault.create("我的知识库/概念库/已入库/内容生成.md", [
			"---",
			"kind: 'wiki-concept'",
			"title: '内容生成'",
			"created_at: '2026-04-13T12:36:56+08:00'",
			"updated_at: '2026-04-13T12:36:56+08:00'",
			"graph: 'show'",
			"---",
			"",
			"# 内容生成",
		].join("\n"));

		await rebuildWikiConceptGraph(app, DEFAULT_SETTINGS);

		const pptAgent = vault.read("我的知识库/概念库/已入库/PPT Agent.md");
		expect(pptAgent).toContain("[[我的知识库/概念库/已入库/需求调研|需求调研]]");
		expect(pptAgent).toContain("[[我的知识库/概念库/已入库/内容生成|内容生成]]");
	});

	it("refreshes real relation links immediately when approving related concepts", async () => {
		const {app, vault} = createFakeApp();
		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/a",
			sourceType: "webpage",
			sourceTitle: "A",
			notePath: "我的知识库/成文/a.md",
			digest: {
				...digest,
				concepts: [{...digest.concepts[0]!, title: "PPT Agent", relatedConcepts: ["需求调研"]}],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 13, 12, 0, 0),
			suffix: "aaaa",
		});
		await approveWikiCandidateByPath(app, DEFAULT_SETTINGS, "我的知识库/概念库/待入库/2026-04-13 1200 - PPT Agent.md");
		expect(vault.read("我的知识库/概念库/已入库/PPT Agent.md")).toContain("- 无");

		await writeWikiArtifacts(app, DEFAULT_SETTINGS, {
			sourceUrl: "https://example.com/b",
			sourceType: "webpage",
			sourceTitle: "B",
			notePath: "我的知识库/成文/b.md",
			digest: {
				...digest,
				concepts: [{...digest.concepts[0]!, title: "需求调研", relatedConcepts: []}],
			},
			model: "deepseek-v4-pro",
			date: new Date(2026, 3, 14, 12, 0, 0),
			suffix: "bbbb",
		});
		await approveWikiCandidateByPath(app, DEFAULT_SETTINGS, "我的知识库/概念库/待入库/2026-04-14 1200 - 需求调研.md");

		expect(vault.read("我的知识库/概念库/已入库/PPT Agent.md")).toContain("[[我的知识库/概念库/已入库/需求调研|需求调研]]");
	});
});
