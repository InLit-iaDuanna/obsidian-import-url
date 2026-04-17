import {Platform, RequestUrlResponse} from "obsidian";

type RequireFn = (moduleName: string) => unknown;

interface ChildProcessLike {
	stdin: {
		write: (chunk: string) => void;
		end: () => void;
	};
	stdout: {
		on: (event: "data", listener: (chunk: unknown) => void) => void;
	};
	stderr: {
		on: (event: "data", listener: (chunk: unknown) => void) => void;
	};
	on: {
		(event: "error", listener: (error: Error) => void): void;
		(event: "close", listener: (code: number | null) => void): void;
	};
}

interface ChildProcessModuleLike {
	spawn?: (
		command: string,
		args: string[],
		options: {
			stdio: ["pipe", "pipe", "pipe"];
		},
	) => ChildProcessLike;
}

interface BrowserRenderFallbackSupported {
	supported: true;
	requireFn: RequireFn;
}

interface BrowserRenderFallbackUnsupported {
	supported: false;
	reason: string;
}

export type BrowserRenderFallbackSupport = BrowserRenderFallbackSupported | BrowserRenderFallbackUnsupported;

export class BrowserRenderFallbackUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrowserRenderFallbackUnavailableError";
	}
}

function getDesktopRequire(): RequireFn | null {
	const candidate = (globalThis as {require?: unknown}).require;
	return typeof candidate === "function" ? candidate as RequireFn : null;
}

function toText(chunk: unknown): string {
	if (typeof chunk === "string") {
		return chunk;
	}

	if (chunk instanceof Uint8Array) {
		return new TextDecoder().decode(chunk);
	}

	return String(chunk);
}

export function getBrowserRenderFallbackSupport(): BrowserRenderFallbackSupport {
	if (!Platform.isDesktopApp) {
		return {
			supported: false,
			reason: "Browser render fallback is only available in the desktop app.",
		};
	}

	if (!Platform.isMacOS) {
		return {
			supported: false,
			reason: "Browser render fallback is currently only available on macOS desktop.",
		};
	}

	const requireFn = getDesktopRequire();
	if (!requireFn) {
		return {
			supported: false,
			reason: "Desktop Node APIs are unavailable in this environment.",
		};
	}

	return {
		supported: true,
		requireFn,
	};
}

export async function renderHtmlWithDesktopBrowser(
	url: string,
	maxWaitSeconds: number,
): Promise<RequestUrlResponse> {
	const support = getBrowserRenderFallbackSupport();
	if (!support.supported) {
		throw new BrowserRenderFallbackUnavailableError(support.reason);
	}

	const childProcess = support.requireFn("child_process") as ChildProcessModuleLike;
	if (typeof childProcess.spawn !== "function") {
		throw new BrowserRenderFallbackUnavailableError("Node child process APIs are unavailable in this environment.");
	}

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

	return new Promise<RequestUrlResponse>((resolve, reject) => {
		const child = childProcess.spawn!("/usr/bin/osascript", ["-", url, String(maxWaitSeconds)], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: unknown) => {
			stdout += toText(chunk);
		});
		child.stderr.on("data", (chunk: unknown) => {
			stderr += toText(chunk);
		});
		child.on("error", (error: Error) => {
			reject(error);
		});
		child.on("close", (code: number | null) => {
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
