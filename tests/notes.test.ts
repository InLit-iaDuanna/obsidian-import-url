import {describe, expect, it} from "vitest";
import {renderFailureNote, renderOriginalNote, renderSuccessNote, sanitizeNoteTitle} from "../src/render/notes";

describe("notes rendering", () => {
	it("sanitizes forbidden filename characters", () => {
		expect(sanitizeNoteTitle("a/b:c*d?e\"f<g>h|i[j]k#l^m")).toBe("a b c d e f g h i j k l m");
	});

	it("renders the fixed failure template headings", () => {
		const content = renderFailureNote({
			frontmatter: {
				sourceUrl: "https://example.com",
				sourceType: "webpage",
				sourceTitle: "Example",
				status: "failed",
				title: "Example",
				clippedAt: "2026-04-13T12:34:00+08:00",
				model: "gpt-4o",
				language: "zh-CN",
				tags: [],
			},
			sourceUrl: "https://example.com",
				failure: {
					stage: "ai_call",
					errorMessage: "boom",
					suggestion: "retry",
					model: "gpt-4o",
					apiBaseUrl: "https://api.openai.com/v1",
					requestUrl: "https://api.openai.com/v1/responses",
					requestId: "req_123",
				},
			});

		expect(content).toContain("# 导入失败");
		expect(content).toContain("## 阶段");
		expect(content).toContain("## 错误");
		expect(content).toContain("## 建议");
		expect(content).toContain("## 来源");
		expect(content).toContain("模型：gpt-4o");
		expect(content).toContain("接口地址：https://api.openai.com/v1");
		expect(content).toContain("请求接口：https://api.openai.com/v1/responses");
		expect(content).toContain("请求编号：req_123");
	});

	it("renders concepts as plain pending drafts before review", () => {
		const content = renderSuccessNote({
			frontmatter: {
				sourceUrl: "https://example.com",
				sourceType: "webpage",
				sourceTitle: "Example",
				status: "complete",
				title: "Example",
				clippedAt: "2026-04-13T12:34:00+08:00",
				model: "deepseek-v4-pro",
				language: "zh-CN",
				tags: [],
			},
			sourceType: "webpage",
			sourceUrl: "https://example.com",
			wikiConceptsFolder: "我的知识库/概念库/已入库",
			originalNotePath: "我的知识库/原文/2026-04-13 1234 - 原文 - Example.md",
			digest: {
				title: "Example",
				summary: "Summary",
				keyPoints: [],
				keyFacts: [],
				actionItems: [],
				fullOrganizedMarkdown: "# Body\n\n[[Should not link|显示文本]]",
				concepts: [
					{
						title: "Concept A",
						aliases: [],
						summary: "Concept summary",
						evidence: [],
						relatedConcepts: [],
						confidence: 0.8,
					},
				],
				suggestedTags: [],
				warnings: [],
			},
		});

		expect(content).toContain("# Example");
		expect(content).toContain("graph_group: 'import-url-generated'");
		expect(content).toContain("## 核心摘要");
		expect(content).toContain("## 待入库概念");
		expect(content).toContain("Concept A - Concept summary");
		expect(content).not.toContain("[[我的知识库/概念库/已入库/Concept A|Concept A]]");
		expect(content).toContain("显示文本");
		expect(content).not.toContain("[[Should not link|显示文本]]");
		expect(content).toContain("原文笔记路径：我的知识库/原文/2026-04-13 1234 - 原文 - Example.md");
		expect(content).not.toContain("[[我的知识库/原文/2026-04-13 1234 - 原文 - Example]]");
	});

	it("renders a separate original source note", () => {
		const content = renderOriginalNote({
			frontmatter: {
				sourceUrl: "https://example.com",
				sourceType: "webpage",
				sourceTitle: "Example",
				status: "complete",
				title: "原文 - Example",
				clippedAt: "2026-04-13T12:34:00+08:00",
				model: "deepseek-v4-pro",
				language: "zh-CN",
				tags: [],
			},
			sourceType: "webpage",
			sourceUrl: "https://example.com",
			markdown: "# 原始正文\n\n正文段落 [[脏链接|脏显示]]",
			warnings: ["阅读模式兜底"],
			structuredNotePath: "我的知识库/成文/2026-04-13 1234 - AI整理 - Example.md",
		});

		expect(content).toContain("# 原文");
		expect(content).toContain("graph_group: 'import-url-generated'");
		expect(content).toContain("# 原始正文");
		expect(content).toContain("脏显示");
		expect(content).not.toContain("[[脏链接|脏显示]]");
		expect(content).toContain("AI 整理笔记路径：我的知识库/成文/2026-04-13 1234 - AI整理 - Example.md");
		expect(content).not.toContain("[[我的知识库/成文/2026-04-13 1234 - AI整理 - Example]]");
		expect(content).toContain("阅读模式兜底");
	});

	it("preserves Obsidian image embeds while simplifying ordinary wikilinks", () => {
		const content = renderOriginalNote({
			frontmatter: {
				sourceUrl: "https://example.com",
				sourceType: "webpage",
				sourceTitle: "Example",
				status: "complete",
				title: "原文 - Example",
				clippedAt: "2026-04-13T12:34:00+08:00",
				model: "deepseek-v4-pro",
				language: "zh-CN",
				tags: [],
			},
			sourceType: "webpage",
			sourceUrl: "https://example.com",
			markdown: "段落 [[普通链接|显示文本]] 和 ![[我的知识库/附件/图片/cover.webp]]",
			warnings: [],
		});

		expect(content).toContain("显示文本");
		expect(content).toContain("![[我的知识库/附件/图片/cover.webp]]");
		expect(content).not.toContain("[[普通链接|显示文本]]");
	});

	it("does not render skipped decorative images as download failures", () => {
		const content = renderOriginalNote({
			frontmatter: {
				sourceUrl: "https://example.com",
				sourceType: "webpage",
				sourceTitle: "Example",
				status: "complete",
				title: "原文 - Example",
				clippedAt: "2026-04-13T12:34:00+08:00",
				model: "deepseek-v4-pro",
				language: "zh-CN",
				tags: [],
			},
			sourceType: "webpage",
			sourceUrl: "https://example.com",
			markdown: "正文段落",
			images: [
				{
					index: 0,
					url: "https://example.com/avatar.png",
					alt: "头像",
					title: "",
					caption: "",
					downloadStatus: "skipped",
					warning: "图片已跳过：疑似装饰、头像或追踪图片",
				},
			],
			warnings: [],
		});

		expect(content).not.toContain("## 图片下载失败清单");
		expect(content).not.toContain("avatar.png");
	});
});
