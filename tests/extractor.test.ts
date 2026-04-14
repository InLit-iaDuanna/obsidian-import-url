import {Readability} from "@mozilla/readability";
import * as obsidian from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {extractSiteJsonContent, extractWebpageContent, getSiteJsonFallbackUrl, scrubHtml, truncateMarkdown} from "../src/pipeline/extractor";
import {PipelineError} from "../src/types";

describe("extractor", () => {
	it("removes dangerous tags and attributes during scrub", () => {
		const scrubbed = scrubHtml(`
			<html>
				<body onload="alert(1)">
					<script>alert(1)</script>
					<img src="a.jpg" srcset="a 1x">
					<div onclick="hack()">Safe</div>
				</body>
			</html>
		`);

		expect(scrubbed).not.toContain("<script");
		expect(scrubbed).not.toContain("<img");
		expect(scrubbed).not.toContain("onload=");
		expect(scrubbed).not.toContain("onclick=");
		expect(scrubbed).not.toContain("srcset=");
	});

	it("extracts short articles because Readability uses charThreshold 0", () => {
		const result = extractWebpageContent(`
			<html>
				<head><title>Short note</title></head>
				<body><article><p>短文正文</p></article></body>
			</html>
		`);

		expect(result.title).toBe("Short note");
		expect(result.markdown).toContain("短文正文");
	});

	it("falls back to body HTML when Readability returns null", () => {
		const parseSpy = vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);

		const result = extractWebpageContent(`
			<html>
				<body><main><p>Fallback 正文</p></main></body>
			</html>
		`);

		expect(result.markdown).toContain("Fallback 正文");
		parseSpy.mockRestore();
	});

	it("accepts reader fallback markdown payloads", () => {
		const result = extractWebpageContent([
			"Title: Reader Title",
			"",
			"URL Source: https://example.com/article",
			"",
			"Markdown Content:",
			"# Reader markdown",
			"",
			"正文段落",
		].join("\n"));

		expect(result.title).toBe("Reader Title");
		expect(result.markdown).toContain("# Reader markdown");
		expect(result.markdown).toContain("正文段落");
	});

	it("extracts discourse topic JSON into markdown", () => {
		const result = extractSiteJsonContent(
			"https://linux.do/t/topic/1782304",
			JSON.stringify({
				title: "Discourse Title",
				post_stream: {
					posts: [
						{
							post_number: 1,
							username: "alice",
							name: "Alice",
							cooked: "<p>首楼正文</p>",
						},
						{
							post_number: 2,
							username: "bob",
							name: "Bob",
							cooked: "<p>回复内容</p>",
						},
					],
				},
			}),
		);

		expect(result?.title).toBe("Discourse Title");
		expect(result?.markdown).toContain("首楼正文");
		expect(result?.markdown).toContain("## 回复 2");
		expect(result?.markdown).toContain("回复内容");
		expect(getSiteJsonFallbackUrl("https://linux.do/t/topic/1782304")).toBe("https://linux.do/t/topic/1782304.json");
	});

	it("truncates markdown on paragraph boundaries when possible", () => {
		const markdown = "first block\n\nsecond block\n\nthird block";
		const truncated = truncateMarkdown(markdown, 5);

		expect(truncated.markdown).toBe("first block");
		expect(truncated.warnings).toEqual(["源网页内容在发送给模型前已按长度限制截断。"]);
	});

	it("maps markdown conversion failures to the extract stage", () => {
		const markdownSpy = vi.spyOn(obsidian, "htmlToMarkdown").mockImplementation(() => {
			throw new ReferenceError("htmlToMarkdown is not defined");
		});

		try {
			extractWebpageContent(`
				<html>
					<body><article><p>正文</p></article></body>
				</html>
			`);
		} catch (error) {
			expect(error).toBeInstanceOf(PipelineError);
			expect((error as PipelineError).failureInfo.stage).toBe("extract");
			expect((error as PipelineError).failureInfo.errorMessage).toMatch(/htmlToMarkdown is not defined/);
		}

		markdownSpy.mockRestore();
	});
});
