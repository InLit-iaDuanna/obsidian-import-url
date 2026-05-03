import {RequestUrlResponse, requestUrl} from "obsidian";
import {renderHtmlWithDesktopBrowser} from "./browser-render-fallback";

const READER_FALLBACK_BASE_URL = "https://r.jina.ai/http://";

export class TimeoutError extends Error {
	readonly stage: "fetch" | "ai_call";

	constructor(stage: "fetch" | "ai_call", message: string) {
		super(message);
		this.name = "TimeoutError";
		this.stage = stage;
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	stage: "fetch" | "ai_call",
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			reject(new TimeoutError(stage, message));
		}, timeoutMs);

		void promise.then((value) => {
			window.clearTimeout(timer);
			resolve(value);
		}).catch((error: unknown) => {
			window.clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

export class Fetcher {
	private readonly fetchTimeoutMs: number;
	private readonly aiTimeoutMs: number;

	constructor(fetchTimeoutMs: number, aiTimeoutMs: number) {
		this.fetchTimeoutMs = fetchTimeoutMs;
		this.aiTimeoutMs = aiTimeoutMs;
	}

	headUrl(url: string): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "HEAD",
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`HEAD 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
		);
	}

	getTextUrl(url: string): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`GET 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
		);
	}

	getBinaryUrl(url: string): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "application/pdf,*/*;q=0.8",
				},
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`GET 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
			);
	}

	getImageUrl(url: string): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8",
				},
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`GET 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
		);
	}

	postJson(
		url: string,
		body: unknown,
		headers: Record<string, string>,
	): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(body),
				headers,
				throw: false,
			}),
			this.aiTimeoutMs,
			"ai_call",
			`POST 请求在 ${this.aiTimeoutMs}ms 后超时。`,
		);
	}

	postForm(
		url: string,
		body: Record<string, string>,
		headers: Record<string, string> = {},
	): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: new URLSearchParams(body).toString(),
				headers,
				throw: false,
			}),
			this.aiTimeoutMs,
			"ai_call",
			`POST 请求在 ${this.aiTimeoutMs}ms 后超时。`,
		);
	}

	async postJsonStream(
		url: string,
		body: unknown,
		headers: Record<string, string>,
	): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "POST",
				contentType: "application/json",
				body: JSON.stringify(body),
				headers: {
					...headers,
					Accept: "text/event-stream,application/json;q=0.9,*/*;q=0.1",
				},
				throw: false,
			}),
			this.aiTimeoutMs,
			"ai_call",
			`POST 请求在 ${this.aiTimeoutMs}ms 后超时。`,
		);
	}

	async getReaderTextUrl(url: string): Promise<RequestUrlResponse> {
		const normalizedUrl = url.replace(/^https?:\/\//iu, "");
		const targetUrl = `${READER_FALLBACK_BASE_URL}${normalizedUrl}`;
		return withTimeout(
			requestUrl({
				url: targetUrl,
				method: "GET",
				headers: {
					Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
				},
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`GET 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
		);
	}

	getJsonUrl(url: string): Promise<RequestUrlResponse> {
		return withTimeout(
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
				},
				throw: false,
			}),
			this.fetchTimeoutMs,
			"fetch",
			`GET 请求在 ${this.fetchTimeoutMs}ms 后超时。`,
		);
	}

	async getBrowserRenderedHtml(url: string): Promise<RequestUrlResponse> {
		const timeoutMs = Math.max(this.fetchTimeoutMs, 45000);
		return withTimeout(
			renderHtmlWithDesktopBrowser(url, Math.ceil(timeoutMs / 1000)),
			timeoutMs,
			"fetch",
			`GET 请求在 ${timeoutMs}ms 后超时。`,
		);
	}
}
