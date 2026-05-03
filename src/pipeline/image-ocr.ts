import {Fetcher} from "./fetcher";
import {buildChatCompletionsApiUrl} from "./ai-client";
import {ImportUrlPluginSettings, PipelineError, WebpageImage} from "../types";

interface ChatCompletionMessagePart {
	type?: string;
	text?: string;
	image_url?: {
		url?: string;
	};
}

interface ChatCompletionMessage {
	content?: string | ChatCompletionMessagePart[] | null;
}

interface ChatCompletionChoice {
	message?: ChatCompletionMessage;
}

interface ChatCompletionResponse {
	choices?: ChatCompletionChoice[];
	error?: {
		message?: string;
	};
}

export interface ImageOcrResult {
	text: string;
	warning?: string;
}

function buildSystemPrompt(): string {
	return [
		"你是一个图片文字识别工具，只负责提取图片中可见的文字。",
		"不要总结，不要推断，不要补全看不清的内容。",
		"如果有无法识别的字，请用「□」或类似占位表示，并在 warning 字段说明。",
		"只输出 JSON 对象，不要输出 Markdown。",
		"JSON 字段必须是：text string，warning string。",
	].join("\n");
}

function buildUserPrompt(image: WebpageImage, sourceUrl: string, sourceTitle: string): string {
	return [
		`来源 URL: ${sourceUrl}`,
		`来源标题: ${sourceTitle || "未知"}`,
		`图片说明: ${[image.caption, image.alt, image.title].filter(Boolean).join(" / ") || "无"}`,
		"请输出图片中所有可见文字，并尽量保持原有顺序。",
	].join("\n");
}

function extractAssistantText(response: ChatCompletionResponse): string {
	const content = response.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return content.trim();
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => part.text ?? "")
			.join("")
			.trim();
	}

	return "";
}

function getErrorMessage(response: ChatCompletionResponse, responseText: string): string {
	return response.error?.message?.trim() || responseText || "图片文字识别接口返回失败。";
}

function isJsonResponseFormatUnsupported(message: string): boolean {
	return /response_format|json_object|unsupported parameter|not support/i.test(message);
}

function parseResultText(rawText: string): ImageOcrResult {
	const trimmed = rawText.trim();
	if (!trimmed) {
		return {text: "", warning: "图片文字识别接口返回了空内容。"};
	}

	try {
		const parsed = JSON.parse(trimmed) as {text?: unknown; warning?: unknown};
		if (typeof parsed.text === "string") {
			return {
				text: parsed.text.trim(),
				warning: typeof parsed.warning === "string" ? parsed.warning.trim() || undefined : undefined,
			};
		}
	} catch {
		// Fall back to raw text.
	}

	return {text: trimmed};
}

export class ImageOcrClient {
	constructor(
		private readonly fetcher: Fetcher,
		private readonly settings: ImportUrlPluginSettings,
		private readonly apiKey: string,
	) {}

	async ocrImage(params: {
		imageDataUrl: string;
		image: WebpageImage;
		sourceUrl: string;
		sourceTitle: string;
	}): Promise<ImageOcrResult> {
		if (!this.settings.imageOcrApiBaseUrl.trim() || !this.settings.imageOcrModel.trim()) {
			return {
				text: "",
				warning: "图片文字识别未配置视觉模型接口，已跳过。",
			};
		}

		const requestUrl = buildChatCompletionsApiUrl(this.settings.imageOcrApiBaseUrl);
		const headers = {
			Accept: "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
		const baseBody = {
			model: this.settings.imageOcrModel,
			messages: [
				{
					role: "system",
					content: buildSystemPrompt(),
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildUserPrompt(params.image, params.sourceUrl, params.sourceTitle),
						},
						{
							type: "image_url",
							image_url: {
								url: params.imageDataUrl,
							},
						},
					],
				},
			],
			response_format: {type: "json_object"},
			max_tokens: 1200,
		};

		const tryRequest = async (body: Record<string, unknown>): Promise<ImageOcrResult> => {
			const response = await this.fetcher.postJson(requestUrl, body, headers);
			if (response.status >= 400) {
				throw new PipelineError({
					stage: "ai_call",
					httpStatus: response.status,
					errorMessage: getErrorMessage(response.json as ChatCompletionResponse, response.text),
					suggestion: "图片文字识别接口调用失败，请检查视觉模型地址、模型名称和密钥。",
					model: this.settings.imageOcrModel,
					apiBaseUrl: this.settings.imageOcrApiBaseUrl,
					requestUrl,
				});
			}

			const payload = JSON.parse(response.text) as ChatCompletionResponse;
			const assistantText = extractAssistantText(payload);
			if (!assistantText) {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "图片文字识别接口没有返回可解析文本。",
					suggestion: "请确认视觉模型支持图片输入和 JSON 输出。",
					model: this.settings.imageOcrModel,
					apiBaseUrl: this.settings.imageOcrApiBaseUrl,
					requestUrl,
				});
			}

			return parseResultText(assistantText);
		};

		try {
			return await tryRequest(baseBody);
		} catch (error) {
			if (error instanceof PipelineError && error.failureInfo.stage === "ai_call" && isJsonResponseFormatUnsupported(error.failureInfo.errorMessage)) {
				const retryBody = {...baseBody};
				delete (retryBody as {response_format?: unknown}).response_format;
				return tryRequest(retryBody);
			}
			throw error;
		}
	}
}
