import {Readability} from "@mozilla/readability";
import {describe, expect, it, vi} from "vitest";
import {JobRunner} from "../src/pipeline/job-runner";
import {TimeoutError} from "../src/pipeline/fetcher";
import {DEFAULT_SETTINGS} from "../src/settings";
import {UserInputError} from "../src/types";
import {createFakeApp, createResponse} from "./helpers";

const sampleDigest = {
	title: "整理标题",
	summary: "总结",
	keyPoints: ["要点"],
	keyFacts: ["事实"],
	actionItems: ["行动"],
	fullOrganizedMarkdown: "# 正文",
	suggestedTags: ["clip"],
	warnings: [],
};

function createSettings() {
	return {
		...DEFAULT_SETTINGS,
		siteJsonFallbackEnabled: true,
		readerFallbackEnabled: false,
		browserRenderFallbackEnabled: false,
		openNoteAfterCreate: true,
	};
}

describe("job-runner", () => {
	it("enforces a single-flight lock", async () => {
		const {app} = createFakeApp();
		let resolveGetText!: (value: any) => void;
		const getTextPromise = new Promise((resolve) => {
			resolveGetText = resolve;
		});
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockReturnValue(getTextPromise),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		const firstRun = runner.run("https://example.com/article");
		await expect(runner.run("https://example.com/other")).rejects.toBeInstanceOf(UserInputError);

		resolveGetText(createResponse(200, "<html><body><article><p>body</p></article></body></html>", {"content-type": "text/html"}));
		await firstRun;
	});

	it("promotes a successful webpage import into the output folder", async () => {
		const {app, vault, workspace} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://example.com/article");

		const files = vault.listFiles().map((file) => file.path);
		expect(files).toContain("Inbox/Clippings/2026-04-13 1234 - 整理标题.md");
		expect(vault.read("Inbox/Clippings/2026-04-13 1234 - 整理标题.md")).toContain("# 摘要");
		expect(workspace.openedFiles[0]?.path).toBe("Inbox/Clippings/2026-04-13 1234 - 整理标题.md");
	});

	it("falls back to body HTML when Readability parsing fails inside the pipeline", async () => {
		const {app} = createFakeApp();
		let capturedMarkdown = "";
		const parseSpy = vi.spyOn(Readability.prototype, "parse").mockReturnValue(null);
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><body><main><p>Fallback 正文</p></main></body></html>",
				{"content-type": "text/html"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://example.com/fallback");

		expect(capturedMarkdown).toContain("Fallback 正文");
		parseSpy.mockRestore();
	});

	it("uses reader fallback when webpage fetching times out and the fallback is enabled", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getReaderTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				[
					"Title: Reader Title",
					"",
					"URL Source: https://example.com/article",
					"",
					"Markdown Content:",
					"# Reader markdown",
					"",
					"正文段落",
				].join("\n"),
				{"content-type": "text/plain"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				readerFallbackEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 8, 41, 35),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://example.com/article");

		expect(fetcher.getReaderTextUrl).toHaveBeenCalledWith("https://example.com/article");
		const content = vault.read("Inbox/Clippings/2026-04-14 0841 - 整理标题.md");
		expect(content).toContain("原网页直连抓取失败，已通过公开阅读代理 r.jina.ai 获取正文");
	});

	it("uses site JSON fallback for discourse-style topic pages", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getJsonUrl: vi.fn().mockResolvedValue(createResponse(
				200,
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
				{"content-type": "application/json"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 9, 30, 0),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://linux.do/t/topic/1782304");

		expect(fetcher.getJsonUrl).toHaveBeenCalledWith("https://linux.do/t/topic/1782304.json");
		const content = vault.read("Inbox/Clippings/2026-04-14 0930 - 整理标题.md");
		expect(content).toContain("原网页 HTML 抓取失败，已改用站点专用 JSON 接口提取正文");
	});

	it("prefers site JSON for discourse pages even when HTML fetch succeeds", async () => {
		const {app} = createFakeApp();
		let capturedMarkdown = "";
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				[
					"<html><head><title>Discourse Shell</title></head><body>",
					"<main>",
					"<p>This website STRICTLY PROHIBITS all AI-generated content.</p>",
					"</main>",
					"</body></html>",
				].join(""),
				{"content-type": "text/html"},
			)),
			getJsonUrl: vi.fn().mockResolvedValue(createResponse(
				200,
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
						],
					},
				}),
				{"content-type": "application/json"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 9, 35, 0),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://linux.do/t/topic/1782304");

		expect(fetcher.getJsonUrl).toHaveBeenCalledWith("https://linux.do/t/topic/1782304.json");
		expect(capturedMarkdown).toContain("首楼正文");
		expect(capturedMarkdown).not.toContain("STRICTLY PROHIBITS");
	});

	it("uses browser render fallback after other fetch paths fail", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getJsonUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getReaderTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getBrowserRenderedHtml: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Rendered Title</title></head><body><article><p>渲染正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				readerFallbackEnabled: true,
				browserRenderFallbackEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 9, 31, 0),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await runner.run("https://example.com/rendered");

		expect(fetcher.getBrowserRenderedHtml).toHaveBeenCalledWith("https://example.com/rendered");
		const content = vault.read("Inbox/Clippings/2026-04-14 0931 - 整理标题.md");
		expect(content).toContain("已通过本地桌面浏览器渲染页面后提取正文");
	});

	it("appends the fixed suffix when final filenames collide", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><body><article><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
		} as any;

		const makeRunner = () => new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as any,
			},
		});

		await makeRunner().run("https://example.com/a");
		await makeRunner().run("https://example.com/b");

		const files = vault.listFiles().map((file) => file.path).sort();
		expect(files).toContain("Inbox/Clippings/2026-04-13 1234 - 整理标题.md");
		expect(files).toContain("Inbox/Clippings/2026-04-13 1234 - 整理标题 - beef.md");
	});

	it("creates a failed note when PDF preflight detects an oversized file", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"content-type": "application/pdf",
				"content-length": String(60 * 1024 * 1024),
			})),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
			},
		});

		await runner.run("https://example.com/huge.pdf");

		const failedPath = "Inbox/Clippings/_failed/2026-04-13 1234 - Failed - example.com - beef.md";
		expect(vault.read(failedPath)).toContain("## 阶段\n\npreflight");
	});

	it("reports secret storage read errors as preflight failures", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><body><article><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => {
				throw new TypeError("i.get is not a function");
			},
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
			},
		});

		await runner.run("https://example.com/article");

		const failedPath = "Inbox/Clippings/_failed/2026-04-13 1234 - Failed - example.com - beef.md";
		const content = vault.read(failedPath);
		expect(content).toContain("## 阶段\n\npreflight");
		expect(content).toContain("i.get is not a function");
	});

	it("creates a failed note when OpenAI cannot directly download a PDF", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"content-type": "application/pdf",
				"content-length": "1024",
			})),
			postJson: vi.fn().mockResolvedValue(createResponse(
				400,
				JSON.stringify({error: {message: "could not download pdf (403)"}}),
			)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
			},
		});

		await runner.run("https://example.com/private.pdf");

		const failedPath = "Inbox/Clippings/_failed/2026-04-13 1234 - Failed - private - beef.md";
		expect(vault.read(failedPath)).toContain("OpenAI 无法直接下载此 PDF");
	});

	it.each([
		{
			name: "incomplete response",
			responseText: JSON.stringify({status: "incomplete", error: {message: "cut off"}}),
		},
		{
			name: "refusal response",
			responseText: JSON.stringify({
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{type: "refusal", refusal: "no"}],
					},
				],
			}),
		},
		{
			name: "invalid JSON payload",
			responseText: JSON.stringify({
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{type: "output_text", text: "{bad json"}],
					},
				],
			}),
		},
	])("persists failure notes for $name", async ({responseText}) => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><body><article><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			postJson: vi.fn().mockResolvedValue(createResponse(200, responseText)),
		} as any;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
			},
		});

		await runner.run("https://example.com/article");

		const failedPath = "Inbox/Clippings/_failed/2026-04-13 1234 - Failed - example.com - beef.md";
		expect(vault.read(failedPath)).toContain("# 导入失败");
	});
});
