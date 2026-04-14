import {describe, expect, it} from "vitest";
import {renderFailureNote, sanitizeNoteTitle} from "../src/render/notes";

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
		expect(content).toContain("模型: gpt-4o");
		expect(content).toContain("API 地址: https://api.openai.com/v1");
		expect(content).toContain("请求接口: https://api.openai.com/v1/responses");
		expect(content).toContain("Request ID: req_123");
	});
});
