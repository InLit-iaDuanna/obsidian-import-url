import {App, Notice, TFile} from "obsidian";
import {AiClient} from "./ai-client";
import {extractSiteJsonContent, extractWebpageContent, getSiteJsonFallbackUrl, truncateMarkdown} from "./extractor";
import {Fetcher, TimeoutError} from "./fetcher";
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
	WebpageExtractionResult,
} from "../types";
import {
	buildFailedFileName,
	buildProcessingFileName,
	buildSuccessFileName,
	ensureDisplayTitle,
	formatClippedAt,
	randomHexSuffix,
	renderFailureNote,
	renderProcessingNote,
	renderSuccessNote,
	sanitizeNoteTitle,
} from "../render/notes";

interface JobRunnerOptions {
	app: App;
	getSettings: () => ImportUrlPluginSettings;
	getApiKey: (secretName: string) => Promise<string | null>;
	deps?: {
		createFetcher?: (settings: ImportUrlPluginSettings) => Fetcher;
		createAiClient?: (fetcher: Fetcher, settings: ImportUrlPluginSettings, apiKey: string) => AiClient;
		onProgress?: (event: JobProgressEvent) => Promise<void> | void;
		now?: () => Date;
		randomSuffix?: () => string;
	};
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

function toFailureInfo(error: unknown): FailureInfo {
	if (error instanceof PipelineError) {
		return error.failureInfo;
	}

	if (error instanceof TimeoutError) {
		return {
			stage: error.stage,
			errorMessage: error.message,
			suggestion: error.stage === "fetch" ? "网页请求超时，请稍后重试。" : "OpenAI 请求超时，请稍后重试。",
		};
	}

	return {
		stage: "save",
		errorMessage: getErrorMessage(error),
		suggestion: "请检查目标文件夹是否可写，并重试导入。",
	};
}

export class JobRunner {
	private readonly app: App;
	private readonly getSettings: () => ImportUrlPluginSettings;
	private readonly getApiKey: (secretName: string) => Promise<string | null>;
	private readonly deps: JobRunnerOptions["deps"];
	private activeRun: Promise<JobRunResult> | null = null;

	constructor(options: JobRunnerOptions) {
		this.app = options.app;
		this.getSettings = options.getSettings;
		this.getApiKey = options.getApiKey;
		this.deps = options.deps;
	}

	isBusy(): boolean {
		return this.activeRun !== null;
	}

	async run(options: string | JobRunOptions): Promise<JobRunResult> {
		if (this.activeRun) {
			throw new UserInputError("已有导入任务正在进行，请稍候。");
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
			message: "任务已创建，等待预检",
			sourceType: sourceTypeGuess,
		});

		const processingFile = await this.createProcessingNote({
			settings,
			sourceUrl: sourceUrl.toString(),
			sourceType: sourceTypeGuess,
			sourceTitle: host,
			title: `Processing - ${host}`,
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
				message: "正在检查链接和文件类型",
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

			if (sourceType === "webpage") {
				new Notice("正在抓取页面内容…", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "fetching",
					progressPercent: 32,
					message: "正在抓取网页内容",
					sourceType,
					title: sourceTitle,
				});
				const webpage = await this.fetchWebpage(validated.url, fetcher, {
					siteJsonFallbackEnabled: settings.siteJsonFallbackEnabled,
					readerFallbackEnabled: settings.readerFallbackEnabled,
					browserRenderFallbackEnabled: settings.browserRenderFallbackEnabled,
				});
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "extracting",
					progressPercent: 48,
					message: "正在抽取正文并转换 Markdown",
					sourceType,
					title: sourceTitle,
				});
				const extracted = webpage.extracted ?? extractWebpageContent(webpage.content);
				sourceTitle = extracted.title || host;
				const truncated = truncateMarkdown(extracted.markdown, settings.maxContentTokens);
				upstreamWarnings = uniqueStrings([
					...extracted.warnings,
					...truncated.warnings,
						...(webpage.usedReaderFallback
							? ["原网页直连抓取失败，已通过公开阅读代理 r.jina.ai 获取正文；该第三方服务会接收原始 URL。"]
							: []),
						...(webpage.usedSiteJsonFallback
							? ["原网页 HTML 抓取失败，已改用站点专用 JSON 接口提取正文。"]
							: []),
						...(webpage.usedBrowserRenderFallback
							? ["原网页直连和常规回退均失败，已通过本地桌面浏览器渲染页面后提取正文。"]
							: []),
					]);

				new Notice("正在 AI 整理，请稍候…", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "ai_call",
					progressPercent: 72,
					message: "正在调用模型整理内容",
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
					markdown: truncated.markdown,
					warnings: upstreamWarnings,
				});
			} else {
				new Notice("正在 AI 整理，请稍候…", 3000);
				await this.emitProgress(options, {
					url: validated.url,
					model: settings.model,
					stage: "ai_call",
					progressPercent: 58,
					message: "正在调用模型读取并整理 PDF",
					sourceType,
					title: sourceTitle,
				});
				digest = await aiClient.digestPdf({
					sourceUrl: validated.url,
					sourceTitle,
				});
			}

			const mergedDigest: StructuredDigest = {
				...digest,
				warnings: uniqueStrings([...upstreamWarnings, ...digest.warnings]),
				suggestedTags: uniqueStrings(digest.suggestedTags),
			};

			const finalTitle = ensureDisplayTitle(mergedDigest.title, sourceTitle, host);
			const successPath = await this.resolveUniquePath(
				settings.outputFolder,
				buildSuccessFileName(finalTitle, now),
				suffix,
			);
			await this.emitProgress(options, {
				url: validated.url,
				model: settings.model,
				stage: "saving",
				progressPercent: 90,
				message: "正在写入最终笔记",
				sourceType,
				title: finalTitle,
			});

			workingFile = await this.moveAndWrite(
				workingFile,
				successPath,
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
						tags: mergedDigest.suggestedTags,
					},
					sourceType,
					sourceUrl: validated.url,
					digest: mergedDigest,
				}),
				false,
			);

			if (settings.openNoteAfterCreate) {
				await this.app.workspace.getLeaf(true).openFile(workingFile);
			}

			new Notice(`笔记已生成：${finalTitle}`, 5000);
			await this.emitProgress(options, {
				url: validated.url,
				model: settings.model,
				stage: "complete",
				progressPercent: 100,
				message: "任务完成",
				sourceType,
				title: finalTitle,
			});
			return {
				status: "complete",
				url: validated.url,
				model: settings.model,
				title: finalTitle,
				notePath: workingFile.path,
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
				buildFailedFileName(sourceTitle || host, suffix, now),
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
						tags: [],
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
				errorMessage: error instanceof Error ? error.message : "Failed to read API key from Secret storage.",
				suggestion: "无法读取系统安全存储中的 API key。请重新保存密钥，或检查当前设备是否支持 Secret storage。",
			});
		}

		if (!apiKey) {
			throw new PipelineError({
				stage: "preflight",
				errorMessage: "OpenAI API key is missing.",
				suggestion: "请在插件设置中保存 OpenAI API key。",
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
	): Promise<{
		content: string;
		extracted?: WebpageExtractionResult;
		usedReaderFallback: boolean;
		usedSiteJsonFallback: boolean;
		usedBrowserRenderFallback: boolean;
	}> {
		try {
			const response = await fetcher.getTextUrl(url);
			if (response.status >= 400) {
				throw new PipelineError({
					stage: "fetch",
					httpStatus: response.status,
					errorMessage: `Failed to fetch webpage (${response.status}).`,
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
			const fallbackErrors: unknown[] = [error];
			if (options.siteJsonFallbackEnabled && shouldTrySiteJsonFallback(error)) {
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
							errorMessage: `Site JSON fallback failed (${siteJsonResponse.status}).`,
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
								errorMessage: `Reader JSON fallback failed (${readerJsonResponse.status}).`,
								suggestion: "站点 JSON 和阅读代理都已尝试，但仍未拿到可用正文。",
							}));
						} catch (readerJsonError) {
							fallbackErrors.push(readerJsonError);
						}
					}
				}
			}

			if (options.readerFallbackEnabled && shouldTryReaderFallback(error)) {
				try {
					const readerResponse = await fetcher.getReaderTextUrl(url);
					if (readerResponse.status >= 400) {
						throw new PipelineError({
							stage: "fetch",
							httpStatus: readerResponse.status,
							errorMessage: `Reader fallback failed (${readerResponse.status}).`,
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
							errorMessage: `Browser render fallback failed (${browserResponse.status}).`,
							suggestion: "本地浏览器渲染回退失败，请关闭该回退或改用其它抓取方式。",
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
					fallbackErrors.push(browserError);
				}
			}

			throw fallbackErrors[fallbackErrors.length - 1] ?? error;
		}
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
		const fileName = buildProcessingFileName(input.sourceTitle, input.suffix, input.date);
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
				tags: [],
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
				suggestion: "无法写入笔记内容，请检查 Vault 是否可写。",
			});
		}
	}
}
