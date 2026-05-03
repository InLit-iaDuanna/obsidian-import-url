import {Notice} from "obsidian";
import type ImportUrlPlugin from "./main";

interface ImportUrlCommandHandlers {
	openImportModal: () => Promise<void>;
	openConfigToml: () => Promise<void>;
	openWikiIndex: () => Promise<void>;
	openWikiManager: () => Promise<void>;
	cleanupLegacyGraphLinks: () => Promise<number>;
	rebuildConceptGraph: () => Promise<{cleanedFiles: number; updatedConcepts: number; taggedFiles: number}>;
	approveCurrentWikiCandidate: () => Promise<void>;
	rejectCurrentWikiCandidate: () => Promise<void>;
	importClipboardUrl: () => Promise<void>;
}

export function registerImportUrlCommands(
	plugin: ImportUrlPlugin,
	handlers: ImportUrlCommandHandlers,
): void {
	plugin.addRibbonIcon("link", "导入 URL", () => {
		void handlers.openImportModal();
	});

	plugin.addRibbonIcon("network", "知识库管理", () => {
		void handlers.openWikiManager();
	});

	plugin.addCommand({
		id: "import",
		name: "从 URL 导入",
		callback: () => {
			void handlers.openImportModal();
		},
	});

	plugin.addCommand({
		id: "import-from-clipboard",
		name: "从剪贴板导入",
		callback: () => {
			void handlers.importClipboardUrl();
		},
	});

	plugin.addCommand({
		id: "open-config",
		name: "打开配置文件",
		callback: () => {
			void handlers.openConfigToml();
		},
	});

	plugin.addCommand({
		id: "open-wiki-index",
		name: "打开知识库索引",
		callback: () => {
			void handlers.openWikiIndex();
		},
	});

	plugin.addCommand({
		id: "open-wiki-manager",
		name: "打开知识库管理",
		callback: () => {
			void handlers.openWikiManager();
		},
	});

	plugin.addCommand({
		id: "rebuild-wiki-concept-graph",
		name: "重建知识库真实关联",
		callback: () => {
			void rebuildConceptGraphWithNotice(handlers);
		},
	});

	plugin.addCommand({
		id: "cleanup-legacy-wiki-links",
		name: "清理旧图谱链接",
		callback: () => {
			void cleanupLegacyGraphLinksWithNotice(handlers);
		},
	});

	plugin.addCommand({
		id: "approve-current-wiki-candidate",
		name: "批准当前知识库候选页",
		callback: () => {
			void handlers.approveCurrentWikiCandidate();
		},
	});

	plugin.addCommand({
		id: "reject-current-wiki-candidate",
		name: "拒绝当前知识库候选页",
		callback: () => {
			void handlers.rejectCurrentWikiCandidate();
		},
	});
}

async function rebuildConceptGraphWithNotice(handlers: ImportUrlCommandHandlers): Promise<void> {
	try {
		const result = await handlers.rebuildConceptGraph();
		new Notice(`图谱已重建：清理 ${result.cleanedFiles} 篇笔记，补充分组 ${result.taggedFiles} 篇，更新 ${result.updatedConcepts} 个概念。`, 5000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`重建失败：${message}`, 6000);
	}
}

async function cleanupLegacyGraphLinksWithNotice(handlers: ImportUrlCommandHandlers): Promise<void> {
	try {
		const changedCount = await handlers.cleanupLegacyGraphLinks();
		new Notice(changedCount > 0 ? `已清理 ${changedCount} 篇旧 AI 整理笔记。` : "没有发现需要清理的旧图谱链接。", 4000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`清理失败：${message}`, 6000);
	}
}
