import {Readability} from "@mozilla/readability";
import {RequestUrlResponse} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {AiClient} from "../src/pipeline/ai-client";
import {JobRunner} from "../src/pipeline/job-runner";
import {Fetcher, TimeoutError} from "../src/pipeline/fetcher";
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
	suggestedTags: ["clip"],
	warnings: [],
};

function createSettings() {
	return {
		...DEFAULT_SETTINGS,
		model: "deepseek-v4-pro",
		siteJsonFallbackEnabled: true,
		readerFallbackEnabled: false,
		browserRenderFallbackEnabled: false,
		openNoteAfterCreate: true,
	};
}

describe("job-runner", () => {
	it("enforces a single-flight lock", async () => {
		const {app} = createFakeApp();
		let resolveGetText!: (value: RequestUrlResponse) => void;
		const getTextPromise = new Promise<RequestUrlResponse>((resolve) => {
			resolveGetText = resolve;
		});
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockReturnValue(getTextPromise),
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
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
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/article");

		const files = vault.listFiles().map((file) => file.path);
		expect(files).toContain("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md");
		expect(files).toContain("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("# 整理标题");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("graph_group: 'import-url-article'");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("'import-url/article'");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("## 成文整理");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("原文笔记路径：我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("# 原文");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("graph_group: 'import-url-original'");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("'import-url/original'");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("正文");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("AI 整理笔记路径：我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md");
		expect(workspace.openedFiles[0]?.path).toBe("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md");
	});

	it("downloads webpage images into the attachment folder and embeds them in the original note", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/cover.png\" alt=\"封面图\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/png"},
				arrayBuffer: new TextEncoder().encode("png-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/article");

		expect(vault.listFiles().map((file) => file.path)).toContain("我的知识库/附件/图片/cover.png");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("![[我的知识库/附件/图片/cover.png]]");
	});

	it("keeps the import successful and records a failure list when image download fails", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/private.png\" alt=\"受限图片\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 403,
				text: "forbidden",
				headers: {"content-type": "text/plain"},
				arrayBuffer: new ArrayBuffer(0),
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/article");

		const original = vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(original).toContain("## 图片下载失败清单");
		expect(original).toContain("https://example.com/images/private.png");
		expect(original).toContain("图片下载失败");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("# 整理标题");
	});

	it("adds the fixed suffix when a downloaded image filename already exists", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/附件/图片/cover.png", "existing image placeholder");
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/cover.png\" alt=\"封面图\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/png"},
				arrayBuffer: new TextEncoder().encode("png-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/article");

		expect(vault.listFiles().map((file) => file.path)).toContain("我的知识库/附件/图片/cover - beef.png");
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("![[我的知识库/附件/图片/cover - beef.png]]");
	});

	it("keeps the import successful when image OCR is enabled but the vision key is missing", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/chart.webp\" alt=\"图表\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/webp"},
				arrayBuffer: new TextEncoder().encode("webp-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
				imageOcrEnabled: true,
				imageOcrApiBaseUrl: "https://vision.example.com/v1",
				imageOcrModel: "vision-model",
			}),
			getApiKey: async () => "sk-main",
			getImageOcrApiKey: async () => null,
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
				createImageOcrClient: vi.fn(),
			},
		});

		await runner.run("https://example.com/article");

		const original = vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(original).toContain("![[我的知识库/附件/图片/chart.webp]]");
		expect(original).toContain("## 图片文字识别");
		expect(original).toContain("图片文字识别已跳过：未保存视觉模型密钥。");
		expect(vault.read("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md")).toContain("# 整理标题");
	});

	it("does not reuse the main model key for image OCR when no vision key reader is provided", async () => {
		const {app, vault} = createFakeApp();
		const createImageOcrClient = vi.fn();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/chart.webp\" alt=\"图表\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/webp"},
				arrayBuffer: new TextEncoder().encode("webp-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
				imageOcrEnabled: true,
				imageOcrApiBaseUrl: "https://vision.example.com/v1",
				imageOcrModel: "vision-model",
			}),
			getApiKey: async () => "sk-main",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
				createImageOcrClient,
			},
		});

		await runner.run("https://example.com/article");

		expect(createImageOcrClient).not.toHaveBeenCalled();
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("图片文字识别已跳过：未提供视觉模型密钥读取器。");
	});

	it("adds successful image OCR text to the original note and AI input", async () => {
		const {app, vault} = createFakeApp();
		let capturedMarkdown = "";
		const ocrImage = vi.fn().mockResolvedValue({text: "图中文字：增长 42%", warning: "局部模糊"});
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/chart.webp\" alt=\"增长图\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/webp"},
				arrayBuffer: new TextEncoder().encode("webp-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
				imageOcrEnabled: true,
				imageOcrApiBaseUrl: "https://vision.example.com/v1",
				imageOcrModel: "vision-model",
			}),
			getApiKey: async () => "sk-main",
			getImageOcrApiKey: async () => "sk-vision",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}: {markdown: string}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
				createImageOcrClient: () => ({ocrImage}) as unknown as never,
			},
		});

		await runner.run("https://example.com/article");

		const original = vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(ocrImage).toHaveBeenCalledTimes(1);
		expect(original).toContain("## 图片文字识别");
		expect(original).toContain("图中文字：增长 42%");
		expect(original).toContain("警告：局部模糊");
		expect(capturedMarkdown).toContain("## 图片补充证据");
		expect(capturedMarkdown).toContain("图片说明：增长图");
		expect(capturedMarkdown).toContain("图片文字识别：图中文字：增长 42%");
	});

	it("uses Baidu OCR credentials when Baidu image OCR is selected", async () => {
		const {app, vault} = createFakeApp();
		const ocrImage = vi.fn().mockResolvedValue({text: "百度识别文字"});
		const createBaiduImageOcrClient = vi.fn().mockReturnValue({ocrImage});
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Source Title</title></head><body><article><img src=\"/images/chart.webp\" alt=\"图表\"><p>正文</p></article></body></html>",
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/webp"},
				arrayBuffer: new TextEncoder().encode("webp-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
				imageOcrEnabled: true,
				imageOcrProvider: "baidu",
				imageOcrApiBaseUrl: "https://aip.baidubce.com",
			}),
			getApiKey: async () => "sk-main",
			getImageOcrApiKey: async () => {
				throw new Error("should not read compatible vision key");
			},
			getImageOcrBaiduApiKey: async (secretName) => secretName === "import-url-baidu-ocr-api-key" ? "baidu-api-key" : null,
			getImageOcrBaiduSecretKey: async (secretName) => secretName === "import-url-baidu-ocr-secret-key" ? "baidu-secret-key" : null,
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
				createBaiduImageOcrClient,
			},
		});

		await runner.run("https://example.com/article");

		expect(createBaiduImageOcrClient).toHaveBeenCalledWith(fetcher, expect.objectContaining({
			imageOcrProvider: "baidu",
		}), "baidu-api-key", "baidu-secret-key");
		expect(ocrImage).toHaveBeenCalledTimes(1);
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("百度识别文字");
	});

	it("limits image OCR calls and records a truncation warning", async () => {
		const {app, vault} = createFakeApp();
		const ocrImage = vi.fn().mockResolvedValue({text: "可见文字"});
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				[
					"<html><head><title>Source Title</title></head><body><article>",
					"<img src=\"/images/a.webp\" alt=\"图 A\">",
					"<img src=\"/images/b.webp\" alt=\"图 B\">",
					"<p>正文</p>",
					"</article></body></html>",
				].join(""),
				{"content-type": "text/html"},
			)),
			getImageUrl: vi.fn().mockResolvedValue({
				status: 200,
				text: "",
				headers: {"content-type": "image/webp"},
				arrayBuffer: new TextEncoder().encode("webp-bytes").buffer,
				json: null,
			} as RequestUrlResponse),
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				imageDownloadEnabled: true,
				imageOcrEnabled: true,
				imageOcrApiBaseUrl: "https://vision.example.com/v1",
				imageOcrModel: "vision-model",
				imageOcrMaxImages: 1,
			}),
			getApiKey: async () => "sk-main",
			getImageOcrApiKey: async () => "sk-vision",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockResolvedValue(sampleDigest),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
				createImageOcrClient: () => ({ocrImage}) as unknown as never,
			},
		});

		await runner.run("https://example.com/article");

		expect(ocrImage).toHaveBeenCalledTimes(1);
		expect(vault.read("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md")).toContain("图片文字识别已按上限处理前 1 张，剩余 1 张已跳过。");
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
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 13, 12, 34, 56),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}: {markdown: string}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/fallback");

		expect(capturedMarkdown).toContain("Fallback 正文");
		parseSpy.mockRestore();
	});

	it("uses reader fallback when webpage fetching times out and the fallback is enabled", async () => {
		const {app, vault} = createFakeApp();
		const getReaderTextUrl = vi.fn().mockResolvedValue(createResponse(
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
		));
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getReaderTextUrl,
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/article");

		expect(getReaderTextUrl).toHaveBeenCalledWith("https://example.com/article");
		const content = vault.read("我的知识库/成文/2026-04-14 0841 - AI整理 - 整理标题.md");
		expect(content).toContain("网页正文已通过 r.jina.ai 阅读模式获取");
	});

	it("uses reader fallback when direct HTML succeeds but extraction finds only a shell", async () => {
		const {app, vault} = createFakeApp();
		let capturedMarkdown = "";
		const getReaderTextUrl = vi.fn().mockResolvedValue(createResponse(
			200,
			[
				"Title: Reader Title",
				"",
				"URL Source: https://example.com/shell",
				"",
				"Markdown Content:",
				"# Reader markdown",
				"",
				"正文段落",
			].join("\n"),
			{"content-type": "text/plain"},
		));
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Shell</title></head><body><script>window.__DATA__={}</script></body></html>",
				{"content-type": "text/html"},
			)),
			getReaderTextUrl,
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				readerFallbackEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 8, 42, 35),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}: {markdown: string}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/shell");

		expect(getReaderTextUrl).toHaveBeenCalledWith("https://example.com/shell");
		expect(capturedMarkdown).toContain("# Reader markdown");
		const content = vault.read("我的知识库/成文/2026-04-14 0842 - AI整理 - 整理标题.md");
		expect(content).toContain("网页正文已通过 r.jina.ai 阅读模式获取");
	});

	it("uses site JSON fallback for discourse-style topic pages", async () => {
		const {app, vault} = createFakeApp();
		const getJsonUrl = vi.fn().mockResolvedValue(createResponse(
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
		));
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getJsonUrl,
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://linux.do/t/topic/1782304");

		expect(getJsonUrl).toHaveBeenCalledWith("https://linux.do/t/topic/1782304.json");
		const content = vault.read("我的知识库/成文/2026-04-14 0930 - AI整理 - 整理标题.md");
		expect(content).toContain("内容已从站点 JSON 接口提取");
	});

	it("prefers site JSON for discourse pages even when HTML fetch succeeds", async () => {
		const {app} = createFakeApp();
		let capturedMarkdown = "";
		const getJsonUrl = vi.fn().mockResolvedValue(createResponse(
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
		));
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
			getJsonUrl,
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: createSettings,
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 9, 35, 0),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}: {markdown: string}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://linux.do/t/topic/1782304");

		expect(getJsonUrl).toHaveBeenCalledWith("https://linux.do/t/topic/1782304.json");
		expect(capturedMarkdown).toContain("首楼正文");
		expect(capturedMarkdown).not.toContain("STRICTLY PROHIBITS");
	});

	it("uses browser render fallback after other fetch paths fail", async () => {
		const {app, vault} = createFakeApp();
		const getBrowserRenderedHtml = vi.fn().mockResolvedValue(createResponse(
			200,
			"<html><head><title>Rendered Title</title></head><body><article><p>渲染正文</p></article></body></html>",
			{"content-type": "text/html"},
		));
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getJsonUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getReaderTextUrl: vi.fn().mockRejectedValue(new TimeoutError("fetch", "GET request timed out after 30000ms.")),
			getBrowserRenderedHtml,
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/rendered");

		expect(getBrowserRenderedHtml).toHaveBeenCalledWith("https://example.com/rendered");
		const content = vault.read("我的知识库/成文/2026-04-14 0931 - AI整理 - 整理标题.md");
		expect(content).toContain("网页正文已从桌面浏览器渲染后的 HTML 提取");
	});

	it("uses browser render fallback when direct HTML extraction finds only a shell", async () => {
		const {app, vault} = createFakeApp();
		let capturedMarkdown = "";
		const getBrowserRenderedHtml = vi.fn().mockResolvedValue(createResponse(
			200,
			"<html><head><title>Rendered Title</title></head><body><article><p>渲染正文</p></article></body></html>",
			{"content-type": "text/html"},
		));
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {"content-type": "text/html"})),
			getTextUrl: vi.fn().mockResolvedValue(createResponse(
				200,
				"<html><head><title>Shell</title></head><body><script>window.__DATA__={}</script></body></html>",
				{"content-type": "text/html"},
			)),
			getBrowserRenderedHtml,
		} as unknown as Fetcher;

		const runner = new JobRunner({
			app,
			getSettings: () => ({
				...createSettings(),
				browserRenderFallbackEnabled: true,
			}),
			getApiKey: async () => "sk-test",
			deps: {
				now: () => new Date(2026, 3, 14, 9, 32, 0),
				randomSuffix: () => "beef",
				createFetcher: () => fetcher,
				createAiClient: () => ({
					digestWebpage: vi.fn().mockImplementation(async ({markdown}: {markdown: string}) => {
						capturedMarkdown = markdown;
						return sampleDigest;
					}),
					digestPdf: vi.fn().mockResolvedValue(sampleDigest),
				}) as unknown as AiClient,
			},
		});

		await runner.run("https://example.com/render-shell");

		expect(getBrowserRenderedHtml).toHaveBeenCalledWith("https://example.com/render-shell");
		expect(capturedMarkdown).toContain("渲染正文");
		const content = vault.read("我的知识库/成文/2026-04-14 0932 - AI整理 - 整理标题.md");
		expect(content).toContain("网页正文已从桌面浏览器渲染后的 HTML 提取");
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
		} as unknown as Fetcher;

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
				}) as unknown as AiClient,
			},
		});

		await makeRunner().run("https://example.com/a");
		await makeRunner().run("https://example.com/b");

		const files = vault.listFiles().map((file) => file.path).sort();
		expect(files).toContain("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题.md");
		expect(files).toContain("我的知识库/成文/2026-04-13 1234 - AI整理 - 整理标题 - beef.md");
		expect(files).toContain("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题.md");
		expect(files).toContain("我的知识库/原文/2026-04-13 1234 - 原文 - 整理标题 - beef.md");
	});

	it("creates a failed note when PDF preflight detects an oversized file", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"content-type": "application/pdf",
				"content-length": String(60 * 1024 * 1024),
			})),
		} as unknown as Fetcher;

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

		const failedPath = "我的知识库/状态/失败记录/2026-04-13 1234 - 失败 - example.com.md";
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
		} as unknown as Fetcher;

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

		const failedPath = "我的知识库/状态/失败记录/2026-04-13 1234 - 失败 - example.com.md";
		const content = vault.read(failedPath);
		expect(content).toContain("## 阶段\n\npreflight");
		expect(content).toContain("i.get is not a function");
	});

	it("creates a failed note when PDF text cannot be extracted locally", async () => {
		const {app, vault} = createFakeApp();
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"content-type": "application/pdf",
				"content-length": "1024",
			})),
			getBinaryUrl: vi.fn().mockResolvedValue(createResponse(200, "")),
		} as unknown as Fetcher;

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

		const failedPath = "我的知识库/状态/失败记录/2026-04-13 1234 - 失败 - private.md";
		expect(vault.read(failedPath)).toContain("无法在本地从 PDF 提取可读文本。");
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
		} as unknown as Fetcher;

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

		const failedPath = "我的知识库/状态/失败记录/2026-04-13 1234 - 失败 - example.com.md";
		expect(vault.read(failedPath)).toContain("# 导入失败");
	});
});
