import {Platform, RequestUrlResponse, requestUrl} from "obsidian";

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
			reject(error);
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
			`HEAD request timed out after ${this.fetchTimeoutMs}ms.`,
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
			`GET request timed out after ${this.fetchTimeoutMs}ms.`,
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
			`POST request timed out after ${this.aiTimeoutMs}ms.`,
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
			`POST request timed out after ${this.aiTimeoutMs}ms.`,
		);
	}

	async getReaderTextUrl(url: string): Promise<RequestUrlResponse> {
		const normalizedUrl = url.replace(/^https?:\/\//iu, "");
		const targetUrl = `${READER_FALLBACK_BASE_URL}${normalizedUrl}`;
		const controller = new AbortController();
		const timeout = window.setTimeout(() => {
			controller.abort();
		}, this.fetchTimeoutMs);

		try {
			const response = await fetch(targetUrl, {
				method: "GET",
				headers: {
					Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
				},
				signal: controller.signal,
			});
			const text = await response.text();
			const normalizedHeaders: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				normalizedHeaders[key] = value;
			});

			return {
				status: response.status,
				text,
				headers: normalizedHeaders,
				json: null,
				arrayBuffer: new ArrayBuffer(0),
			} as RequestUrlResponse;
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				throw new TimeoutError("fetch", `GET request timed out after ${this.fetchTimeoutMs}ms.`);
			}

			throw error;
		} finally {
			window.clearTimeout(timeout);
		}
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
			`GET request timed out after ${this.fetchTimeoutMs}ms.`,
		);
	}

	async getBrowserRenderedHtml(url: string): Promise<RequestUrlResponse> {
		if (!Platform.isDesktopApp || process.platform !== "darwin") {
			throw new Error("Browser render fallback is only available on desktop macOS.");
		}

		const {spawn} = require("child_process") as typeof import("child_process");
		const script = `
on run argv
	set targetUrl to item 1 of argv
	set maxWait to (item 2 of argv) as integer
	tell application "Safari"
		set newDoc to make new document with properties {URL:targetUrl}
		set deadline to (current date) + maxWait
		repeat while (current date) is less than deadline
			delay 0.5
			try
				set readyState to do JavaScript "document.readyState" in newDoc
				if readyState is "complete" then exit repeat
			end try
		end repeat
		delay 1
		set pageHtml to do JavaScript "document.documentElement.outerHTML" in newDoc
		close newDoc
		return pageHtml
	end tell
end run`;

		const timeoutMs = Math.max(this.fetchTimeoutMs, 45000);
		const timeoutSeconds = Math.ceil(timeoutMs / 1000);

		return new Promise<RequestUrlResponse>((resolve, reject) => {
			const child = spawn("/usr/bin/osascript", ["-", url, String(timeoutSeconds)], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			const timer = window.setTimeout(() => {
				child.kill("SIGKILL");
				reject(new TimeoutError("fetch", `GET request timed out after ${timeoutMs}ms.`));
			}, timeoutMs);

			child.stdout.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			child.on("error", (error: Error) => {
				window.clearTimeout(timer);
				reject(error);
			});
			child.on("close", (code: number | null) => {
				window.clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(stderr.trim() || `Browser render fallback failed with exit code ${code ?? -1}.`));
					return;
				}

				resolve({
					status: 200,
					text: stdout,
					headers: {},
					json: null,
					arrayBuffer: new ArrayBuffer(0),
				} as RequestUrlResponse);
			});

			child.stdin.write(script);
			child.stdin.end();
		});
	}
}
