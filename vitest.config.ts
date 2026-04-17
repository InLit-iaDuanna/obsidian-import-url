import {defineConfig} from "vitest/config";

const obsidianMockPath = decodeURIComponent(new URL("./tests/obsidian-mock.ts", import.meta.url).pathname);

export default defineConfig({
	resolve: {
		alias: {
			obsidian: obsidianMockPath,
		},
	},
	test: {
		environment: "jsdom",
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/setup.ts"],
	},
});
