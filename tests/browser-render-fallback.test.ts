import {Platform} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {Fetcher} from "../src/pipeline/fetcher";

type GlobalWithRequire = typeof globalThis & {
	require?: (moduleName: string) => unknown;
};

describe("browser render fallback support", () => {
	it("fails with a clear structured message on non-desktop environments", async () => {
		const globalWithRequire = globalThis as GlobalWithRequire;
		const requireSpy = vi.fn<(moduleName: string) => unknown>();
		const originalRequire = globalWithRequire.require;
		globalWithRequire.require = requireSpy as unknown as GlobalWithRequire["require"];

		const originalDesktop = Platform.isDesktopApp;
		const originalMac = Platform.isMacOS;
		Platform.isDesktopApp = false;
		Platform.isMacOS = false;

		const fetcher = new Fetcher(200, 200);
		await expect(fetcher.getBrowserRenderedHtml("https://example.com")).rejects.toThrow(
			/desktop app/i,
		);
		expect(requireSpy).not.toHaveBeenCalled();

		Platform.isDesktopApp = originalDesktop;
		Platform.isMacOS = originalMac;
		globalWithRequire.require = originalRequire;
	});

	it("fails with a macOS-specific message on unsupported desktop OS", async () => {
		const originalDesktop = Platform.isDesktopApp;
		const originalMac = Platform.isMacOS;
		Platform.isDesktopApp = true;
		Platform.isMacOS = false;

		const fetcher = new Fetcher(200, 200);
		await expect(fetcher.getBrowserRenderedHtml("https://example.com")).rejects.toThrow(
			/macOS desktop/i,
		);

		Platform.isDesktopApp = originalDesktop;
		Platform.isMacOS = originalMac;
	});
});
