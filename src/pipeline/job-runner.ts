import {App, Notice, TFile} from "obsidian";
import {AiClient} from "./ai-client";
import {BrowserRenderFallbackUnavailableError} from "./browser-render-fallback";
import {extractPdfTextContent, extractSiteJsonContent, extractWebpageContent, getSiteJsonFallbackUrl, truncateMarkdown} from "./extractor";
import {Fetcher, TimeoutError} from "./fetcher";
import {BaiduImageOcrClient, ImageOcrClient} from "./image-ocr";
import {validateUrl, parseHttpUrl} from "./url-validator";
import {
	FailureInfo,
	JobProgressEvent,
	ImportUrlPluginSettings,
	JobRunOptions,
	JobRunResult,
	PipelineError,
	SourceType,
	StructuredDigest,
	UserInputError,
	WebpageImage,
	WebpageExtractionResult,
} from "../types";
import {writeWikiArtifacts} from "../wiki-artifacts";
import {
	buildFailedFileName,
	buildOriginalFileName,
	buildProcessingFileName,
	buildSuccessFileName,
	ensureDisplayTitle,
	formatClippedAt,
	randomHexSuffix,
	renderFailureNote,
	renderOriginalNote,
	renderProcessingNote,
	renderSuccessNote,
	sanitizeNoteTitle,
} from "../render/notes";
import {normalizeConceptDrafts} from "../wiki-links";

interface JobRunnerOptions {
	app: App;
	getSettings: () => ImportUrlPluginSettings;
	getApiKey: (secretName: string) => Promise<string | null>;
	getImageOcrApiKey?: (secretName: string) => Promise<string | null>;
	getImageOcrBaiduApiKey?: (secretName: string) => Promise<string | null>;
	getImageOcrBaiduSecretKey?: (secretName: string) => Promise<string | null>;
	deps?: {
		createFetcher?: (settings: ImportUrlPluginSettings) => Fetcher;
		createAiClient?: (fetcher: Fetcher, settings: ImportUrlPluginSettings, apiKey: string) => AiClient;
		createImageOcrClient?: (fetcher: Fetcher, settings: ImportUrlPluginSettings, apiKey: string) => ImageOcrClient | null;
		createBaiduImageOcrClient?: (fetcher: Fetcher, settings: ImportUrlPluginSettings, apiKey: string, secretKey: string) => BaiduImageOcrClient | null;
		onProgress?: (event: JobProgressEvent) => Promise<void> | void;
		now?: () => Date;
		randomSuffix?: () => string;
	};
}

interface WebpageFetchResult {
	content: string;
	extracted?: WebpageExtractionResult;
	usedReaderFallback: boolean;
	usedSiteJsonFallback: boolean;
	usedBrowserRenderFallback: boolean;
}

interface ImageDownloadResult extends WebpageImage {
	localPath?: string;
	binary?: ArrayBuffer;
	contentType?: string;
}

interface OcrBlock {
	image?: ImageDownloadResult;
	text: string;
	warning?: string;
}

function uniqueStrings(values: string[]): string[] {
	const unique = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed) {
			unique.add(trimmed);
		}
	}
	return [...unique];
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shouldTryReaderFallback(error: unknown): boolean {
	if (error instanceof TimeoutError && error.stage === "fetch") {
		return true;
	}

	if (!(error instanceof PipelineError) || error.failureInfo.stage !== "fetch") {
		return false;
	}

	const status = error.failureInfo.httpStatus;
	return status === undefined || [403, 408, 409, 425, 429, 451, 500, 502, 503, 504].includes(status);
}

function shouldTrySiteJsonFallback(error: unknown): boolean {
	if (error instanceof TimeoutError && error.stage === "fetch") {
		return true;
	}

	if (!(error instanceof PipelineError) || error.failureInfo.stage !== "fetch") {
		return false;
	}

	const status = error.failureInfo.httpStatus;
	return status === undefined || [403, 404, 408, 409, 425, 429, 451, 500, 502, 503, 504].includes(status);
}

function joinVaultPath(folder: string, fileName: string): string {
	return `${folder.replace(/\/+$/u, "")}/${fileName}`;
}

function basenameFromUrl(url: URL): string {
	const segment = url.pathname.split("/").filter(Boolean).pop();
	if (!segment) {
		return url.host || "source";
	}

	try {
		return decodeURIComponent(segment).replace(/\.pdf$/i, "");
	} catch {
		return segment.replace(/\.pdf$/i, "");
	}
}

function getImageExtensionFromContentType(contentType: string | undefined): string {
	const normalized = contentType?.split(";")[0]?.trim().toLowerCase() || "";
	switch (normalized) {
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/avif":
			return ".avif";
		default:
			return ".img";
	}
}

function getImageBaseName(sourceUrl: string, index: number): string {
	try {
		const url = new URL(sourceUrl);
		const segment = url.pathname.split("/").filter(Boolean).pop() || "image";
		const decoded = decodeURIComponent(segment).replace(/\.[a-z0-9]+$/iu, "");
		return sanitizeNoteTitle(decoded || "image") || `image-${index + 1}`;
	} catch {
		return `image-${index + 1}`;
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

function toFailureInfo(error: unknown): FailureInfo {
	if (error instanceof PipelineError) {
		return error.failureInfo;
	}

	if (error instanceof TimeoutError) {
		return {
			stage: error.stage,
			errorMessage: error.message,
			suggestion: error.stage === "fetch" ? "网页请求超时，请稍后重试。" : "模型接口请求超时，请稍后重试。",
		};
	}

	return {
		stage: "save",
		errorMessage: getErrorMessage(error),
		suggestion: "请检查目标文件夹是否可写，并重试导入。",
	};
}

function getImageDataUrl(contentType: string | undefined, buffer: ArrayBuffer): string {
	const mime = contentType?.split(";")[0]?.trim() || "image/jpeg";
	return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

export class JobRunner {
	private readonly app: App;
	private readonly getSettings: () => ImportUrlPluginSettings;
	private readonly getApiKey: (secretName: string) => Promise<string | null>;
	private readonly getImageOcrApiKey?: (secretName: string) => Promise<string | null>;
	private readonly getImageOcrBaiduApiKey?: (secretName: string) => Promise<string | null>;
	private readonly getImageOcrBaiduSecretKey?: (secretName: string) => Promise<string | null>;
	private readonly deps: JobRunnerOptions["deps"];
	private activeRun: Promise<JobRunResult> | null = null;

	constructor(options: JobRunnerOptions) {
		this.app = options.app;
		this.getSettings = options.getSettings;
		this.getApiKey = options.getApiKey;
		this.getImageOcrApiKey = options.getImageOcrApiKey;
		this.getImageOcrBaiduApiKey = options.getImageOcrBaiduApiKey;
		this.getImageOcrBaiduSecretKey = options.getImageOcrBaiduSecretKey;
		this.deps = options.deps;
	}

	isBusy(): boolean {
		return this.activeRun !== null;
	}

	async run(options: string | JobRunOptions): Promise<JobRunResult> {
		if (this.activeRun) {
			throw new UserInputError("已有导入任务正在运行，请稍后。");
		}

		const task = this.runInternal(typeof options === "string" ? {rawUrl: options} : options);
		this.activeRun = task.finally(() => {
			this.activeRun = null;
		});
		return this.activeRun;
	}

	private async runInternal(options: JobRunOptions): Promise<JobRunResult> {
		const settings = {
			...this.getSettings(),
			model: options.model?.trim() || this.getSettings().model,
			apiBaseUrl: options.apiBaseUrl?.trim() || this.getSettings().apiBaseUrl,
		};
		if (!settings.model.trim()) {
			throw new UserInputError("导入前请先选择模型名称。");
		}
		const now = this.deps?.now?.() ?? new Date();
		const suffix = this.deps?.randomSuffix?.() ?? randomHexSuffix();
		const sourceUrl = parseHttpUrl(options.rawUrl);
		const host = sanitizeNoteTitle(sourceUrl.host) || "source";
		const sourceTypeGuess: SourceType = sourceUrl.pathname.toLowerCase().endsWith(".pdf") ? "pdf" : "webpage";
		const fetcher = this.deps?.createFetcher?.(settings) ?? new Fetcher(settings.fetchTimeoutMs, settings.aiTimeoutMs);
		await this.emitProgress(options, {
			url: sourceUrl.toString(),
			model: settings.model,
			stage: "queued",
			progressPercent: 5,
			message: "导入已排队，正在等待预检。",
			sourceType: sourceTypeGuess,
		});

		const processingFile = await this.createProcessingNote({
			settings,
			sourceUrl: sourceUrl.toString(),
			sourceType: sourceTypeGuess,
			sourceTitle: host,
			title: `处理中 - ${host}`,
			date: now,
			suffix,
		});

		let workingFile: TFile = processingFile;
		let sourceType: SourceType = sourceTypeGuess;
		let sourceTitle = host;

		try {
			await this.emitProgress(options, {
				url: sourceUrl.toString(),
				model: settings.model,
				stage: "preflight",
				progressPercent: 15,
				message: "正在检查 URL 和来源类型。",
				sourceType,
				title: sourceTitle,
			});
			const validated = await validateUrl(sourceUrl, fetcher);
			sourceType = validated.sourceType;
			sourceTitle = sourceType === "pdf" ? basenameFromUrl(sourceUrl) : host;

			const apiKey = await this.requireApiKey(settings.openAiSecretName);
			const aiClient = this.deps?.createAiClient?.(fetcher, settings, apiKey) ?? new AiClient(fetcher, settings, apiKey);

			let digest: StructuredDigest;
			let upstreamWarnings: string[] = [];
			let originalMarkdown = "";
			let webpageImages: ImageDownloadResult[] = [];
			let imageOcrBlocks: OcrBlock[] = [];

			if (sourceType === "webpage") {
				new Notice("正在抓取网页内容...", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "fetching",
					progressPercent: 32,
					message: "正在抓取网页内容。",
					sourceType,
					title: sourceTitle,
				});
				let webpage = await this.fetchWebpage(validated.url, fetcher, {
					siteJsonFallbackEnabled: settings.siteJsonFallbackEnabled,
					readerFallbackEnabled: settings.readerFallbackEnabled,
					browserRenderFallbackEnabled: settings.browserRenderFallbackEnabled,
				});
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "extracting",
					progressPercent: 48,
					message: "正在提取正文并转换为 Markdown。",
					sourceType,
					title: sourceTitle,
				});
				const extraction = await this.extractWebpageContentWithFallback(validated.url, fetcher, {
					readerFallbackEnabled: settings.readerFallbackEnabled,
					browserRenderFallbackEnabled: settings.browserRenderFallbackEnabled,
				}, webpage);
				webpage = extraction.webpage;
				const extracted = extraction.extracted;
				sourceTitle = extracted.title || host;
				const truncated = truncateMarkdown(extracted.markdown, settings.maxContentTokens);
				webpageImages = await this.downloadWebpageImages({
					settings,
					fetcher,
					sourceUrl: validated.url,
					sourceTitle,
					images: extracted.images,
					suffix,
					now,
				});
				imageOcrBlocks = await this.runImageOcr({
					settings,
					fetcher,
					sourceUrl: validated.url,
					sourceTitle,
					images: webpageImages,
				});
				originalMarkdown = truncated.markdown;
				upstreamWarnings = uniqueStrings([
					...extracted.warnings,
					...truncated.warnings,
					...webpageImages.flatMap((image) => image.downloadStatus === "failed" && image.warning ? [image.warning] : []),
					...imageOcrBlocks.flatMap((block) => block.warning ? [block.warning] : []),
					...(webpage.usedReaderFallback
						? ["网页正文已通过 r.jina.ai 阅读模式获取；该服务会收到来源 URL。"]
						: []),
					...(webpage.usedSiteJsonFallback
						? ["内容已从站点 JSON 接口提取。"]
						: []),
					...(webpage.usedBrowserRenderFallback
						? ["网页正文已从桌面浏览器渲染后的 HTML 提取。"]
						: []),
				]);

				new Notice("正在调用模型整理内容...", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "ai_call",
					progressPercent: 72,
					message: "正在调用模型整理内容。",
					sourceType,
					title: sourceTitle,
				});
				digest = await aiClient.digestWebpage({
					metadata: {
						sourceUrl: validated.url,
						sourceTitle,
						byline: extracted.byline,
						excerpt: extracted.excerpt,
					},
					markdown: this.composeAiMarkdown(truncated.markdown, webpageImages, imageOcrBlocks),
					warnings: upstreamWarnings,
				});
			} else {
				new Notice("正在抓取 PDF 内容...", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "fetching",
					progressPercent: 32,
					message: "正在抓取 PDF 内容。",
					sourceType,
					title: sourceTitle,
				});
				const pdfResponse = await fetcher.getBinaryUrl(validated.url);
				if (pdfResponse.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: pdfResponse.status,
						errorMessage: `PDF 抓取失败（${pdfResponse.status}）。`,
						suggestion: "请确认 PDF 链接公开可访问，且不是需要登录或临时授权的地址。",
					});
				}
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "extracting",
					progressPercent: 45,
					message: "正在本地提取 PDF 文本。",
					sourceType,
					title: sourceTitle,
				});
				const extractedPdf = extractPdfTextContent(pdfResponse.arrayBuffer);
				const truncated = truncateMarkdown(extractedPdf.markdown, settings.maxContentTokens);
				originalMarkdown = truncated.markdown;
				upstreamWarnings = uniqueStrings([
					...extractedPdf.warnings,
					...truncated.warnings,
				]);
				new Notice("正在调用模型整理内容...", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "ai_call",
					progressPercent: 58,
					message: "正在调用模型整理提取出的 PDF 文本。",
					sourceType,
					title: sourceTitle,
				});
				digest = await aiClient.digestPdf({
					sourceUrl: validated.url,
					sourceTitle,
					markdown: truncated.markdown,
					warnings: upstreamWarnings,
				});
			}

			const mergedDigest: StructuredDigest = {
				...digest,
				warnings: uniqueStrings([...upstreamWarnings, ...digest.warnings]),
				concepts: normalizeConceptDrafts(digest.concepts),
				suggestedTags: uniqueStrings(digest.suggestedTags),
			};

			const finalTitle = ensureDisplayTitle(mergedDigest.title, sourceTitle, host);
			const structuredPath = await this.resolveUniquePath(
				settings.outputFolder,
				buildSuccessFileName(finalTitle, now),
				suffix,
			);
			const originalPath = await this.resolveUniquePath(
				settings.originalFolder,
				buildOriginalFileName(finalTitle, now),
				suffix,
			);
			await this.emitProgress(options, {
				url: validated.url,
				model: settings.model,
				stage: "saving",
				progressPercent: 90,
				message: "正在写入原文和 AI 整理笔记。",
				sourceType,
				title: finalTitle,
			});

			const originalFile = await this.app.vault.create(
				originalPath,
				renderOriginalNote({
					frontmatter: {
						sourceUrl: validated.url,
						sourceType,
						sourceTitle,
						status: "complete",
						title: `原文 - ${finalTitle}`,
						clippedAt: formatClippedAt(now),
						model: settings.model,
						language: settings.defaultLanguage,
						tags: ["import-url/original", "import-url/generated"],
						graphGroup: "import-url-original",
					},
					sourceType,
					sourceUrl: validated.url,
					markdown: originalMarkdown,
					images: webpageImages,
					imageOcrBlocks: this.renderImageOcrBlocks(imageOcrBlocks),
					warnings: upstreamWarnings,
					structuredNotePath: structuredPath,
				}),
			);

			workingFile = await this.moveAndWrite(
				workingFile,
				structuredPath,
				renderSuccessNote({
					frontmatter: {
						sourceUrl: validated.url,
						sourceType,
						sourceTitle,
						status: "complete",
						title: finalTitle,
						clippedAt: formatClippedAt(now),
						model: settings.model,
						language: settings.defaultLanguage,
						tags: uniqueStrings(["import-url/article", "import-url/generated", ...mergedDigest.suggestedTags]),
						graphGroup: "import-url-article",
					},
					sourceType,
					sourceUrl: validated.url,
					wikiConceptsFolder: settings.wikiConceptsFolder,
					digest: mergedDigest,
					originalNotePath: originalFile.path,
				}),
				false,
			);

			try {
				await writeWikiArtifacts(this.app, settings, {
					sourceUrl: validated.url,
					sourceType,
					sourceTitle,
					notePath: workingFile.path,
					digest: mergedDigest,
					model: settings.model,
					date: now,
					suffix,
				});
			} catch (error) {
				console.error("[import-url] failed to write wiki artifacts", error);
				new Notice("笔记已生成，但知识库候选文件写入失败。", 7000);
			}

			if (settings.openNoteAfterCreate) {
				await this.app.workspace.getLeaf(true).openFile(workingFile);
			}

			new Notice(`笔记已生成：${finalTitle}`, 5000);
			await this.emitProgress(options, {
				url: validated.url,
				model: settings.model,
				stage: "complete",
				progressPercent: 100,
				message: "导入完成。",
				sourceType,
				title: finalTitle,
			});
			return {
				status: "complete",
				url: validated.url,
				model: settings.model,
				title: finalTitle,
				notePath: workingFile.path,
				originalNotePath: originalFile.path,
				sourceType,
			};
		} catch (error) {
			if (error instanceof UserInputError) {
				throw error;
			}

			const failure = toFailureInfo(error);
			await this.emitProgress(options, {
				url: sourceUrl.toString(),
				model: settings.model,
				stage: "failed",
				progressPercent: 100,
				message: failure.errorMessage,
				sourceType,
				title: sourceTitle,
			});
			const failedPath = await this.resolveUniquePath(
				settings.failedFolder,
					buildFailedFileName(sourceTitle || host, now),
				suffix,
			);

			workingFile = await this.moveAndWrite(
				workingFile,
				failedPath,
				renderFailureNote({
					frontmatter: {
						sourceUrl: sourceUrl.toString(),
						sourceType,
						sourceTitle,
						status: "failed",
						title: ensureDisplayTitle(sourceTitle, host),
						clippedAt: formatClippedAt(now),
						model: settings.model,
						language: settings.defaultLanguage,
						tags: ["import-url/failed", "import-url/generated"],
						graphGroup: "import-url-status",
					},
					sourceUrl: sourceUrl.toString(),
					failure,
				}),
				true,
			);

			if (!(error instanceof PipelineError)) {
				console.error("[import-url] unexpected pipeline failure", error);
			}

			return {
				status: "failed",
				url: sourceUrl.toString(),
				model: settings.model,
				title: ensureDisplayTitle(sourceTitle, host),
				notePath: workingFile.path,
				sourceType,
				failure,
			};
		}
	}

	private async emitProgress(options: JobRunOptions, event: Omit<JobProgressEvent, "historyId">): Promise<void> {
		await this.deps?.onProgress?.({
			...event,
			historyId: options.historyId,
		});
	}

	private async requireApiKey(secretName: string): Promise<string> {
		let apiKey: string | null = null;
		try {
			apiKey = (await this.getApiKey(secretName))?.trim() ?? null;
		} catch (error) {
			throw new PipelineError({
				stage: "preflight",
				errorMessage: error instanceof Error ? error.message : "读取模型接口密钥失败。",
				suggestion: "无法读取系统安全存储中的模型接口密钥。请重新保存密钥，或检查当前设备是否支持安全存储。",
			});
		}

		if (!apiKey) {
			throw new PipelineError({
				stage: "preflight",
				errorMessage: "模型接口密钥缺失。",
				suggestion: "请在插件设置中保存模型接口密钥。",
			});
		}

		return apiKey;
	}

	private async fetchWebpage(
		url: string,
		fetcher: Fetcher,
		options: {
			siteJsonFallbackEnabled: boolean;
			readerFallbackEnabled: boolean;
			browserRenderFallbackEnabled: boolean;
		},
	): Promise<WebpageFetchResult> {
		let directFetchError: unknown = null;
		try {
			const response = await fetcher.getTextUrl(url);
			if (response.status >= 400) {
				throw new PipelineError({
					stage: "fetch",
					httpStatus: response.status,
					errorMessage: `网页抓取失败（${response.status}）。`,
					suggestion: "请确认链接公开可访问，且不是需要登录或反爬验证的页面。",
				});
			}

			// Discourse (e.g. linux.do) often serves a crawler-friendly HTML shell that includes
			// long site policy text. Readability can mistakenly pick that policy as the "article".
			// Prefer the official topic JSON API when possible.
			if (options.siteJsonFallbackEnabled) {
				const siteJsonUrl = getSiteJsonFallbackUrl(url);
				if (siteJsonUrl) {
					try {
						const siteJsonResponse = await fetcher.getJsonUrl(siteJsonUrl);
						if (siteJsonResponse.status < 400) {
							const extracted = extractSiteJsonContent(url, siteJsonResponse.text);
							if (extracted) {
								return {
									content: siteJsonResponse.text,
									extracted,
									usedReaderFallback: false,
									usedSiteJsonFallback: true,
									usedBrowserRenderFallback: false,
								};
							}
						}
					} catch {
						// Ignore and fall back to HTML extraction. We only treat this as a hard failure
						// when the initial HTML fetch fails too (handled below).
					}
				}
			}

			return {
				content: response.text,
				extracted: undefined,
				usedReaderFallback: false,
				usedSiteJsonFallback: false,
				usedBrowserRenderFallback: false,
			};
		} catch (error) {
			directFetchError = error;
		}

		const fallbackErrors: unknown[] = [directFetchError];
		if (options.siteJsonFallbackEnabled && shouldTrySiteJsonFallback(directFetchError)) {
			const siteJsonUrl = getSiteJsonFallbackUrl(url);
			if (siteJsonUrl) {
				try {
					const siteJsonResponse = await fetcher.getJsonUrl(siteJsonUrl);
					if (siteJsonResponse.status < 400) {
						const extracted = extractSiteJsonContent(url, siteJsonResponse.text);
						if (extracted) {
							return {
								content: siteJsonResponse.text,
								extracted,
								usedReaderFallback: false,
								usedSiteJsonFallback: true,
								usedBrowserRenderFallback: false,
							};
						}
					}
					fallbackErrors.push(new PipelineError({
						stage: "fetch",
						httpStatus: siteJsonResponse.status,
						errorMessage: `站点 JSON 兜底失败（${siteJsonResponse.status}）。`,
						suggestion: "站点 JSON 接口已响应，但没能提供可用正文。",
					}));
				} catch (siteJsonError) {
					fallbackErrors.push(siteJsonError);
				}

				if (options.readerFallbackEnabled) {
					try {
						const readerJsonResponse = await fetcher.getReaderTextUrl(siteJsonUrl);
						if (readerJsonResponse.status < 400) {
							const extracted = extractSiteJsonContent(url, readerJsonResponse.text);
							if (extracted) {
								return {
									content: readerJsonResponse.text,
									extracted,
									usedReaderFallback: true,
									usedSiteJsonFallback: true,
									usedBrowserRenderFallback: false,
								};
							}
						}
						fallbackErrors.push(new PipelineError({
							stage: "fetch",
							httpStatus: readerJsonResponse.status,
							errorMessage: `阅读模式 JSON 兜底失败（${readerJsonResponse.status}）。`,
							suggestion: "站点 JSON 和阅读代理都已尝试，但仍未拿到可用正文。",
						}));
					} catch (readerJsonError) {
						fallbackErrors.push(readerJsonError);
					}
				}
			}
		}

		if (options.readerFallbackEnabled && shouldTryReaderFallback(directFetchError)) {
			try {
				const readerResponse = await fetcher.getReaderTextUrl(url);
				if (readerResponse.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: readerResponse.status,
						errorMessage: `阅读模式兜底失败（${readerResponse.status}）。`,
						suggestion: "原网页直连抓取失败，阅读代理回退也失败了。请稍后重试，或关闭代理回退后换网络再试。",
					});
				}

				return {
					content: readerResponse.text,
					extracted: undefined,
					usedReaderFallback: true,
					usedSiteJsonFallback: false,
					usedBrowserRenderFallback: false,
				};
			} catch (readerError) {
				fallbackErrors.push(readerError);
			}
		}

		if (options.browserRenderFallbackEnabled) {
			try {
				const browserResponse = await fetcher.getBrowserRenderedHtml(url);
				if (browserResponse.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: browserResponse.status,
						errorMessage: `浏览器渲染兜底失败（${browserResponse.status}）。`,
						suggestion: "浏览器渲染兜底失败。请关闭该兜底，或换用其他抓取路径。",
					});
				}

				return {
					content: browserResponse.text,
					extracted: undefined,
					usedReaderFallback: false,
					usedSiteJsonFallback: false,
					usedBrowserRenderFallback: true,
				};
			} catch (browserError) {
				if (browserError instanceof BrowserRenderFallbackUnavailableError) {
					fallbackErrors.push(new PipelineError({
						stage: "fetch",
						errorMessage: browserError.message,
						suggestion: "浏览器渲染兜底是实验功能，仅支持桌面端 macOS。请在不支持的设备上关闭该兜底。",
					}));
					throw fallbackErrors[fallbackErrors.length - 1];
				}
				fallbackErrors.push(browserError);
			}
		}

		const finalError = fallbackErrors[fallbackErrors.length - 1] ?? directFetchError;
		if (finalError instanceof Error) {
			throw finalError;
		}
		throw new Error(finalError ? getErrorMessage(finalError) : "网页抓取失败。");
	}

	private async extractWebpageContentWithFallback(
		url: string,
		fetcher: Fetcher,
		options: {
			readerFallbackEnabled: boolean;
			browserRenderFallbackEnabled: boolean;
		},
		webpage: WebpageFetchResult,
	): Promise<{extracted: WebpageExtractionResult; webpage: WebpageFetchResult}> {
		if (webpage.extracted) {
			return {
				extracted: webpage.extracted,
				webpage,
			};
		}

		const fallbackErrors: unknown[] = [];
		try {
			return {
				extracted: extractWebpageContent(webpage.content, url),
				webpage,
			};
		} catch (error) {
			fallbackErrors.push(error);
		}

		if (options.readerFallbackEnabled && !webpage.usedReaderFallback) {
			try {
				new Notice("正文提取失败，正在尝试阅读模式兜底...", 3000);
				const readerResponse = await fetcher.getReaderTextUrl(url);
				if (readerResponse.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: readerResponse.status,
						errorMessage: `阅读模式兜底失败（${readerResponse.status}）。`,
						suggestion: "网页能打开但未提取出正文，阅读模式兜底也失败了。请换一个公开正文页，或开启浏览器渲染兜底。",
					});
				}
				const extracted = extractWebpageContent(readerResponse.text, url);
				return {
					extracted,
					webpage: {
						content: readerResponse.text,
						extracted,
						usedReaderFallback: true,
						usedSiteJsonFallback: webpage.usedSiteJsonFallback,
						usedBrowserRenderFallback: false,
					},
				};
			} catch (readerError) {
				fallbackErrors.push(readerError);
			}
		}

		if (options.browserRenderFallbackEnabled && !webpage.usedBrowserRenderFallback) {
			try {
				new Notice("正文提取失败，正在尝试浏览器渲染兜底...", 3000);
				const browserResponse = await fetcher.getBrowserRenderedHtml(url);
				if (browserResponse.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: browserResponse.status,
						errorMessage: `浏览器渲染兜底失败（${browserResponse.status}）。`,
						suggestion: "网页能打开但未提取出正文，浏览器渲染兜底也失败了。请换一个公开正文页。",
					});
				}
				const extracted = extractWebpageContent(browserResponse.text, url);
				return {
					extracted,
					webpage: {
						content: browserResponse.text,
						extracted,
						usedReaderFallback: webpage.usedReaderFallback,
						usedSiteJsonFallback: webpage.usedSiteJsonFallback,
						usedBrowserRenderFallback: true,
					},
				};
			} catch (browserError) {
				if (browserError instanceof BrowserRenderFallbackUnavailableError) {
					fallbackErrors.push(new PipelineError({
						stage: "fetch",
						errorMessage: browserError.message,
						suggestion: "浏览器渲染兜底是实验功能，仅支持桌面端 macOS。请在不支持的设备上关闭该兜底。",
					}));
				} else {
					fallbackErrors.push(browserError);
				}
			}
		}

		const finalError = fallbackErrors[fallbackErrors.length - 1] ?? fallbackErrors[0] ?? new PipelineError({
			stage: "extract",
			errorMessage: "无法从网页提取可读 Markdown 内容。",
			suggestion: "请确认链接是公开网页正文页，而不是需要登录或只返回脚本壳的页面。",
		});
		if (finalError instanceof Error) {
			throw finalError;
		}
		if (typeof finalError === "string") {
			throw new Error(finalError);
		}
		throw new Error("网页正文提取失败，所有兜底路径也失败。");
	}

	private async createProcessingNote(input: {
		settings: ImportUrlPluginSettings;
		sourceUrl: string;
		sourceType: SourceType;
		sourceTitle: string;
		title: string;
		date: Date;
		suffix: string;
	}): Promise<TFile> {
		await this.ensureFolder(input.settings.processingFolder);
		const fileName = buildProcessingFileName(input.sourceTitle, input.date);
		const targetPath = await this.resolveUniquePath(input.settings.processingFolder, fileName, input.suffix);

		return this.app.vault.create(
			targetPath,
			renderProcessingNote({
				sourceUrl: input.sourceUrl,
				sourceType: input.sourceType,
				sourceTitle: input.sourceTitle,
				status: "processing",
				title: input.title,
				clippedAt: formatClippedAt(input.date),
				model: input.settings.model,
				language: input.settings.defaultLanguage,
				tags: ["import-url/processing", "import-url/generated"],
				graphGroup: "import-url-status",
			}),
		);
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	private async resolveUniquePath(folder: string, fileName: string, suffix: string): Promise<string> {
		await this.ensureFolder(folder);
		let candidate = joinVaultPath(folder, fileName);

		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		const extension = ".md";
		const stem = candidate.endsWith(extension) ? candidate.slice(0, -extension.length) : candidate;
		candidate = `${stem} - ${suffix}${extension}`;

		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(`${stem} - ${suffix}-${counter}${extension}`)) {
			counter += 1;
		}

		return `${stem} - ${suffix}-${counter}${extension}`;
	}

	private async moveAndWrite(
		file: TFile,
		targetPath: string,
		content: string,
		allowStayInPlace: boolean,
	): Promise<TFile> {
		try {
			if (file.path !== targetPath) {
				await this.app.vault.rename(file, targetPath);
			}
		} catch (error) {
			if (!allowStayInPlace) {
				throw new PipelineError({
					stage: "save",
					errorMessage: getErrorMessage(error),
					suggestion: "无法移动笔记到目标目录，请检查文件夹路径和权限。",
				});
			}
		}

		try {
			await this.app.vault.modify(file, content);
			return file;
		} catch (error) {
			throw new PipelineError({
				stage: "save",
				errorMessage: getErrorMessage(error),
				suggestion: "无法写入笔记内容，请检查当前库是否可写。",
			});
		}
	}

	private composeAiMarkdown(markdown: string, images: ImageDownloadResult[], ocrBlocks: OcrBlock[]): string {
		const segments = [markdown.trim()];
		const metadataLines = images
			.filter((image) => image.downloadStatus !== "skipped" && (image.caption || image.alt || image.title))
			.map((image) => `- 图片说明：${[image.caption, image.alt, image.title].filter(Boolean).join(" · ")}`);
		const ocrLines = ocrBlocks
			.filter((block) => block.text.trim())
			.map((block) => `- 图片文字识别：${block.text.trim()}`);

		if (metadataLines.length > 0 || ocrLines.length > 0) {
			segments.push("", "## 图片补充证据", "", ...metadataLines, ...ocrLines);
		}

		return segments.filter((segment) => segment.trim()).join("\n");
	}

	private renderImageOcrBlocks(ocrBlocks: OcrBlock[]): string[] {
		const rendered: string[] = [];
		let resultIndex = 0;

		for (const block of ocrBlocks) {
			const text = block.text.trim();
			const warning = block.warning?.trim();
			if (!text && !warning) {
				continue;
			}

			if (!text) {
				rendered.push(`- ${warning}`);
				continue;
			}

			resultIndex += 1;
			const lines = [`### 识别结果 ${resultIndex}`, ""];
			if (block.image?.localPath) {
				lines.push(`图片：![[${block.image.localPath}]]`, "");
			} else if (block.image?.url) {
				lines.push(`图片：${block.image.url}`, "");
			}
			lines.push(text);
			if (warning) {
				lines.push("", `警告：${warning}`);
			}
			rendered.push(lines.join("\n").trim());
		}

		return rendered;
	}

	private async downloadWebpageImages(input: {
		settings: ImportUrlPluginSettings;
		fetcher: Fetcher;
		sourceUrl: string;
		sourceTitle: string;
		images: WebpageImage[];
		suffix: string;
		now: Date;
	}): Promise<ImageDownloadResult[]> {
		if (!input.settings.imageDownloadEnabled) {
			return input.images.map((image) => ({
				...image,
				downloadStatus: image.downloadStatus === "skipped" ? "skipped" : "skipped",
				warning: image.warning ?? "图片下载已关闭。",
			}));
		}

		await this.ensureFolder(input.settings.imageAttachmentFolder);
		const results: ImageDownloadResult[] = [];
		for (const image of input.images) {
			if (image.downloadStatus === "skipped") {
				results.push({...image});
				continue;
			}

			try {
				const response = await input.fetcher.getImageUrl(image.url);
				if (response.status >= 400) {
					throw new PipelineError({
						stage: "fetch",
						httpStatus: response.status,
						errorMessage: `图片下载失败（${response.status}）。`,
						suggestion: "图片资源可能已失效、受防盗链限制，或不是可直接访问的图片链接。",
					});
				}

				const binary = response.arrayBuffer;
				const contentType = response.headers["content-type"] || response.headers["Content-Type"];
				const extension = getImageExtensionFromContentType(contentType);
				const fileBase = getImageBaseName(image.url, image.index);
				const fileName = `${fileBase}${extension}`;
				const uniquePath = await this.resolveUniqueBinaryPath(input.settings.imageAttachmentFolder, fileName, input.suffix);
				await this.app.vault.createBinary(uniquePath, binary);
				results.push({
					...image,
					localPath: uniquePath,
					binary,
					contentType,
					downloadStatus: "downloaded",
				});
			} catch (error) {
				results.push({
					...image,
					downloadStatus: "failed",
					warning: image.warning || `图片下载失败：${getErrorMessage(error)}`,
				});
			}
		}

		return results;
	}

	private async runImageOcr(input: {
		settings: ImportUrlPluginSettings;
		fetcher: Fetcher;
		sourceUrl: string;
		sourceTitle: string;
		images: ImageDownloadResult[];
	}): Promise<OcrBlock[]> {
		if (!input.settings.imageOcrEnabled) {
			return [];
		}
		if (input.settings.imageOcrProvider !== "baidu" && (!input.settings.imageOcrApiBaseUrl.trim() || !input.settings.imageOcrModel.trim())) {
			return [];
		}

		const downloadedImages = input.images.filter((image) => image.downloadStatus === "downloaded" && image.binary);
		if (downloadedImages.length === 0) {
			return [];
		}

		const clientResult = await this.createImageOcrClient(input.fetcher, input.settings);
		if ("warning" in clientResult) {
			return [{
				text: "",
				warning: clientResult.warning,
			}];
		}

		const client = clientResult.client;
		if (!client) {
			return [{
				text: "",
				warning: "图片文字识别已跳过：OCR 客户端不可用。",
			}];
		}

		const maxImages = Math.max(1, Math.floor(input.settings.imageOcrMaxImages || 8));
		const limited = downloadedImages.slice(0, maxImages);
		const blocks: OcrBlock[] = [];
		if (downloadedImages.length > limited.length) {
			blocks.push({
				text: "",
				warning: `图片文字识别已按上限处理前 ${limited.length} 张，剩余 ${downloadedImages.length - limited.length} 张已跳过。`,
			});
		}

		for (const image of limited) {
			if (!image.binary) {
				continue;
			}
			try {
				const result = await client.ocrImage({
					imageDataUrl: getImageDataUrl(image.contentType, image.binary),
					image,
					sourceUrl: input.sourceUrl,
					sourceTitle: input.sourceTitle,
				});
				if (result.text.trim()) {
					blocks.push({
						image,
						text: result.text.trim(),
						warning: result.warning,
					});
				} else if (result.warning) {
					blocks.push({
						image,
						text: "",
						warning: result.warning,
					});
				}
			} catch (error) {
				blocks.push({
					image,
					text: "",
					warning: `图片文字识别失败：${getErrorMessage(error)}`,
				});
			}
		}

		return blocks;
	}

	private async createImageOcrClient(
		fetcher: Fetcher,
		settings: ImportUrlPluginSettings,
	): Promise<{client: ImageOcrClient | BaiduImageOcrClient | null} | {warning: string}> {
		if (settings.imageOcrProvider === "baidu") {
			if (!this.getImageOcrBaiduApiKey || !this.getImageOcrBaiduSecretKey) {
				return {warning: "百度图片文字识别已跳过：未提供百度密钥读取器。"};
			}

			let apiKey: string | null = null;
			let secretKey: string | null = null;
			try {
				apiKey = (await this.getImageOcrBaiduApiKey(settings.imageOcrBaiduApiKeySecretName))?.trim() ?? null;
				secretKey = (await this.getImageOcrBaiduSecretKey(settings.imageOcrBaiduSecretKeySecretName))?.trim() ?? null;
			} catch (error) {
				return {warning: `百度图片文字识别已跳过：读取百度密钥失败：${getErrorMessage(error)}`};
			}

			if (!apiKey || !secretKey) {
				return {warning: "百度图片文字识别已跳过：未保存百度 API Key 或 Secret Key。"};
			}

			return {
				client: this.deps?.createBaiduImageOcrClient
					? this.deps.createBaiduImageOcrClient(fetcher, settings, apiKey, secretKey)
					: new BaiduImageOcrClient(fetcher, settings, apiKey, secretKey),
			};
		}

		if (!this.getImageOcrApiKey) {
			return {warning: "图片文字识别已跳过：未提供视觉模型密钥读取器。"};
		}

		const secret = settings.imageOcrSecretName || "import-url-image-ocr-api-key";
		let apiKey: string | null = null;
		try {
			apiKey = (await this.getImageOcrApiKey(secret))?.trim() ?? null;
		} catch (error) {
			return {warning: `图片文字识别已跳过：读取视觉模型密钥失败：${getErrorMessage(error)}`};
		}
		if (!apiKey) {
			return {warning: "图片文字识别已跳过：未保存视觉模型密钥。"};
		}

		return {
			client: this.deps?.createImageOcrClient
				? this.deps.createImageOcrClient(fetcher, settings, apiKey)
				: new ImageOcrClient(fetcher, settings, apiKey),
		};
	}

	private async resolveUniqueBinaryPath(folder: string, fileName: string, suffix: string): Promise<string> {
		await this.ensureFolder(folder);
		let candidate = joinVaultPath(folder, fileName);
		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
		const stem = extension ? candidate.slice(0, -extension.length) : candidate;
		candidate = `${stem} - ${suffix}${extension}`;
		if (!this.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(`${stem} - ${suffix}-${counter}${extension}`)) {
			counter += 1;
		}

		return `${stem} - ${suffix}-${counter}${extension}`;
	}
}
