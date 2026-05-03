import {Notice, TFile} from "obsidian";
import type ImportUrlPlugin from "./main";
import {findActiveImportForUrl, normalizeRecentImports, updateRecentImport, upsertRecentImport, getPreferredImportOpenPath} from "./history";
import {getModelOptions, getPrimaryModel, normalizeCustomModels, normalizeModelApiBaseUrls, resolveModelApiBaseUrl} from "./model-catalog";
import {ImportUrlModal} from "./modal";
import {JobRunner} from "./pipeline/job-runner";
import {parseHttpUrl} from "./pipeline/url-validator";
import {buildHistoryFileName, renderHistoryNote} from "./render/history-note";
import {randomHexSuffix} from "./render/notes";
import {DEFAULT_SETTINGS, readApiKeyValue, readSecretValue} from "./settings";
import {UserInputError} from "./types";
import type {ImportHistoryEntry, ImportUrlPluginSettings, JobProgressEvent, JobRunResult} from "./types";
import {applyConfigTomlOverrides, readImportUrlConfigToml, renderDefaultConfigToml, updateConfigTomlModel} from "./config-toml";
import {ApplyGraphColorGroupsResult, applyImportUrlGraphColorGroups} from "./graph-colors";
import {
	approveActiveWikiCandidate,
	approveWikiCandidateByPath,
	cleanupLegacyConceptGraphLinks,
	getWikiOverview,
	openWikiIndex,
	rebuildWikiConceptGraph,
	rejectActiveWikiCandidate,
	rejectWikiCandidateByPath,
	setWikiConceptGraphVisibility,
	WikiConceptSortMode,
	WikiOverview,
} from "./wiki-artifacts";
import {WIKI_MANAGER_VIEW_TYPE} from "./wiki-manager-view";

const PREFERRED_DEEPSEEK_MODEL = "deepseek-v4-flash";
const LEGACY_GPT_MODEL_PATTERN = /^gpt(?:-|$)/iu;

const LEGACY_DEFAULT_PATHS: Partial<Record<keyof ImportUrlPluginSettings, string>> = {
	configTomlPath: "Inbox/Clippings/import-url.config.toml",
	outputFolder: "Inbox/Clippings",
	originalFolder: "Inbox/Clippings",
	processingFolder: "Inbox/Clippings/_processing",
	failedFolder: "Inbox/Clippings/_failed",
	historyFolder: "Inbox/Clippings/History",
	wikiFolder: "Inbox/Clippings/Wiki",
	wikiSourcesFolder: "Inbox/Clippings/Wiki/sources",
	wikiCandidatesFolder: "Inbox/Clippings/Wiki/_candidates",
	wikiConceptsFolder: "Inbox/Clippings/Wiki/concepts",
	wikiIndexPath: "Inbox/Clippings/Wiki/index.md",
};

const CHINESE_LEGACY_DEFAULT_PATHS: Partial<Record<keyof ImportUrlPluginSettings, string>> = {
	configTomlPath: "收件箱/剪藏/导入URL配置.toml",
	outputFolder: "收件箱/剪藏",
	originalFolder: "收件箱/剪藏",
	processingFolder: "收件箱/剪藏/处理中",
	failedFolder: "收件箱/剪藏/失败记录",
	historyFolder: "收件箱/剪藏/历史记录",
	wikiFolder: "收件箱/剪藏/知识库",
	wikiSourcesFolder: "收件箱/剪藏/知识库/来源",
	wikiCandidatesFolder: "收件箱/剪藏/知识库/候选概念",
	wikiConceptsFolder: "收件箱/剪藏/知识库/概念",
	wikiIndexPath: "收件箱/剪藏/知识库/索引.md",
};

const PATH_SETTING_KEYS = [
	"configTomlPath",
	"outputFolder",
	"originalFolder",
	"processingFolder",
	"failedFolder",
	"historyFolder",
	"wikiFolder",
	"wikiSourcesFolder",
	"wikiCandidatesFolder",
	"wikiConceptsFolder",
	"wikiIndexPath",
] as const;

export class ImportController {
	private effectiveSettings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private jobRunner!: JobRunner;
	private activeRunHistoryId: string | null = null;

	constructor(private readonly plugin: ImportUrlPlugin) {}

	async initialize(): Promise<void> {
		await this.tryEnsureConfigTomlReady();
		await this.refreshEffectiveSettings();

		this.jobRunner = new JobRunner({
			app: this.plugin.app,
			getSettings: () => this.effectiveSettings,
			getApiKey: async (secretName: string) => readApiKeyValue(this.plugin.app, secretName),
			getImageOcrApiKey: async (secretName: string) => readSecretValue(this.plugin.app, secretName),
			deps: {
				onProgress: (event) => this.handleJobProgress(event),
			},
		});
	}

	async getEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		return this.refreshEffectiveSettings();
	}

	async openConfigToml(): Promise<void> {
		await this.ensureConfigTomlReady();
		const configPath = this.plugin.settings.configTomlPath.trim() || DEFAULT_SETTINGS.configTomlPath;
		const file = this.plugin.app.vault.getAbstractFileByPath(configPath) as TFile | null;
		if (!file) {
			new Notice("无法创建 config.toml，请检查配置文件路径。", 5000);
			return;
		}

		await this.plugin.app.workspace.getLeaf(true).openFile(file);
	}

	async openWikiIndex(): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await openWikiIndex(this.plugin.app, effectiveSettings);
	}

	async openWikiManager(): Promise<void> {
		const workspace = this.plugin.app.workspace as typeof this.plugin.app.workspace & {
			getLeavesOfType?: (viewType: string) => Array<{setViewState?: (state: {type: string; active: boolean}) => Promise<void>}>;
			getRightLeaf?: (split: boolean) => {setViewState: (state: {type: string; active: boolean}) => Promise<void>} | null;
			getLeaf: (newLeaf?: boolean) => {setViewState: (state: {type: string; active: boolean}) => Promise<void>};
			revealLeaf?: (leaf: unknown) => Promise<void>;
		};
		const existingLeaf = workspace.getLeavesOfType?.(WIKI_MANAGER_VIEW_TYPE)[0];
		if (existingLeaf) {
			await workspace.revealLeaf?.(existingLeaf);
			return;
		}

		const leaf = workspace.getRightLeaf?.(false) ?? workspace.getLeaf(true);
		await leaf.setViewState({type: WIKI_MANAGER_VIEW_TYPE, active: true});
		await workspace.revealLeaf?.(leaf);
	}

	async getWikiOverview(sortMode: WikiConceptSortMode): Promise<WikiOverview> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		return getWikiOverview(this.plugin.app, effectiveSettings, sortMode);
	}

	async approveWikiCandidate(path: string, graphVisible: boolean): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await approveWikiCandidateByPath(this.plugin.app, effectiveSettings, path, {graphVisible});
	}

	async rejectWikiCandidate(path: string): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await rejectWikiCandidateByPath(this.plugin.app, effectiveSettings, path);
	}

	async setWikiConceptGraphVisibility(path: string, graphVisible: boolean): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await setWikiConceptGraphVisibility(this.plugin.app, effectiveSettings, path, graphVisible);
	}

	async cleanupLegacyConceptGraphLinks(): Promise<number> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		return cleanupLegacyConceptGraphLinks(this.plugin.app, effectiveSettings);
	}

	async rebuildWikiConceptGraph(): Promise<{cleanedFiles: number; updatedConcepts: number; taggedFiles: number}> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		return rebuildWikiConceptGraph(this.plugin.app, effectiveSettings);
	}

	async applyGraphColorGroups(): Promise<ApplyGraphColorGroupsResult> {
		return applyImportUrlGraphColorGroups(this.plugin.app);
	}

	async approveCurrentWikiCandidate(): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await approveActiveWikiCandidate(this.plugin.app, effectiveSettings);
	}

	async rejectCurrentWikiCandidate(): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		await rejectActiveWikiCandidate(this.plugin.app, effectiveSettings);
	}

	async openImportModal(): Promise<void> {
		const effectiveSettings = await this.refreshEffectiveSettings();
		new ImportUrlModal(this.plugin.app, {
			isBusy: () => this.jobRunner.isBusy(),
			modelOptions: getModelOptions(effectiveSettings),
			initialModel: effectiveSettings.model,
			recentImports: this.plugin.settings.recentImports,
			resolveApiBaseUrl: (model) => resolveModelApiBaseUrl(effectiveSettings, model),
			openVaultPath: (path) => this.openVaultPath(path),
			onModelChange: (model) => this.persistModelSelection(model),
			onClearRecentImports: () => this.clearRecentImports(),
			onSubmit: (rawUrl: string, model: string) => this.startImport(rawUrl, model),
		}).open();
	}

	async clearRecentImports(): Promise<boolean> {
		if (this.jobRunner.isBusy()) {
			new Notice("有导入任务正在运行，完成后再清空最近导入。", 4000);
			return false;
		}

		if (this.plugin.settings.recentImports.length === 0) {
			new Notice("最近导入列表已经是空的。", 2500);
			return true;
		}

		this.plugin.settings.recentImports = [];
		await this.plugin.saveSettings();
		new Notice("最近导入列表已清空。已生成的笔记不会被删除。", 4000);
		return true;
	}

	async importClipboardUrl(): Promise<void> {
		if (this.jobRunner.isBusy()) {
			new Notice("已有导入任务正在运行，请稍后。", 4000);
			return;
		}

		try {
			const clipboardText = await navigator.clipboard?.readText?.();
			const rawUrl = clipboardText?.trim();
			if (!rawUrl) {
				new Notice("剪贴板中没有 URL。", 3000);
				return;
			}

			const effectiveSettings = await this.refreshEffectiveSettings();
			await this.startImport(rawUrl, effectiveSettings.model);
		} catch {
			new Notice("无法读取剪贴板，请手动粘贴。", 4000);
		}
	}

	loadStoredSettings(loaded: Partial<ImportUrlPluginSettings> | null): boolean {
		this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		let migrated = false;
		for (const key of PATH_SETTING_KEYS) {
			if (this.plugin.settings[key] === LEGACY_DEFAULT_PATHS[key] || this.plugin.settings[key] === CHINESE_LEGACY_DEFAULT_PATHS[key]) {
				this.plugin.settings[key] = DEFAULT_SETTINGS[key];
				migrated = true;
			}
		}
		this.plugin.settings.customModels = normalizeCustomModels(Array.isArray(this.plugin.settings.customModels) ? this.plugin.settings.customModels : []);
		this.plugin.settings.modelApiBaseUrls = normalizeModelApiBaseUrls(Array.isArray(this.plugin.settings.modelApiBaseUrls) ? this.plugin.settings.modelApiBaseUrls : []);
		if (this.migrateLegacyDefaultModel()) {
			migrated = true;
		}
		this.plugin.settings.configTomlPath = this.plugin.settings.configTomlPath?.trim() || DEFAULT_SETTINGS.configTomlPath;
		this.plugin.settings.recentImports = normalizeRecentImports(this.plugin.settings.recentImports);
		this.effectiveSettings = this.plugin.settings;
		return migrated;
	}

	private async tryEnsureConfigTomlReady(): Promise<void> {
		try {
			await this.ensureConfigTomlReady();
		} catch (error) {
			console.error("[import-url] failed to initialize config.toml", error);
			new Notice("初始化 config.toml 失败，插件会继续加载。", 7000);
		}
	}

	async ensureConfigTomlReady(): Promise<void> {
		const configPath = this.plugin.settings.configTomlPath.trim() || DEFAULT_SETTINGS.configTomlPath;
		const folder = configPath.split("/").slice(0, -1).join("/");
		if (folder) {
			await this.ensureFolder(folder);
		}

		if (this.plugin.app.vault.getAbstractFileByPath(configPath)) {
			return;
		}

		await this.plugin.app.vault.create(configPath, renderDefaultConfigToml(this.plugin.settings));
	}

	private async refreshEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		try {
			const config = await readImportUrlConfigToml(this.plugin.app, this.plugin.settings.configTomlPath);
			this.effectiveSettings = applyConfigTomlOverrides(this.plugin.settings, config);
			if (this.migrateEffectiveLegacyDefaultModel()) {
				await this.persistModelSelection(this.effectiveSettings.model);
			}
			await this.persistModelSelection(this.effectiveSettings.model, {writeConfig: false});
		} catch (error) {
			console.error("[import-url] failed to read config.toml", error);
			this.effectiveSettings = applyConfigTomlOverrides(this.plugin.settings, null);
			new Notice("读取 config.toml 失败，已改用设置页中的值。", 6000);
		}

		return this.effectiveSettings;
	}

	private async startImport(rawUrl: string, selectedModel: string): Promise<void> {
		let historyEntry: ImportHistoryEntry | null = null;

		try {
			const effectiveSettings = await this.refreshEffectiveSettings();
			const normalizedUrl = parseHttpUrl(rawUrl).toString();
			const activeModel = getPrimaryModel(selectedModel, effectiveSettings.model);
			if (!activeModel.trim()) {
				throw new UserInputError("导入前请先选择模型名称。");
			}
			const resolvedApiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, activeModel) || effectiveSettings.apiBaseUrl;
			const existingActiveImport = findActiveImportForUrl(this.plugin.settings.recentImports, normalizedUrl, activeModel);
			if (existingActiveImport) {
				if (this.isCurrentActiveRun(existingActiveImport)) {
					await this.revealActiveImport(existingActiveImport);
					return;
				}

				await this.markStaleImportFailed(existingActiveImport);
			}

			if (this.jobRunner.isBusy()) {
				throw new UserInputError("已有导入任务正在运行，请稍后。");
			}

			await this.persistModelSelection(activeModel);

			historyEntry = await this.createHistoryEntry(normalizedUrl, activeModel, resolvedApiBaseUrl);
			await this.plugin.saveSettings();
			this.activeRunHistoryId = historyEntry.id;

			try {
				const result = await this.jobRunner.run({
					rawUrl: normalizedUrl,
					model: activeModel,
					apiBaseUrl: resolvedApiBaseUrl,
					historyId: historyEntry.id,
				});
				await this.applyJobResult(historyEntry.id, result);
			} finally {
				if (this.activeRunHistoryId === historyEntry.id) {
					this.activeRunHistoryId = null;
				}
			}
		} catch (error) {
			if (error instanceof UserInputError) {
				if (historyEntry) {
					this.removeHistoryEntry(historyEntry.id);
					await this.plugin.saveSettings();
				}
				new Notice(error.message, 5000);
				return;
			}

			if (historyEntry) {
				let updatedEntry: ImportHistoryEntry | null = null;
				this.plugin.settings.recentImports = updateRecentImport(this.plugin.settings.recentImports, historyEntry.id, (entry) => ({
					...(updatedEntry = {
						...entry,
						status: "failed",
						errorMessage: error instanceof Error ? error.message : "未知错误",
					}),
				}));
				await this.plugin.saveSettings();
				if (updatedEntry) {
					await this.writeVisibleHistoryNote(updatedEntry);
				}
			}
			console.error("[import-url] unexpected import failure", error);
			new Notice("导入失败。已尽量保留处理中或失败记录笔记。", 6000);
		}
	}

	private async revealActiveImport(entry: ImportHistoryEntry): Promise<void> {
		const preferredPath = getPreferredImportOpenPath(entry);
		const opened = preferredPath ? await this.openVaultPath(preferredPath) : false;
		new Notice(opened ? "这个 URL 正在导入，已打开当前记录。" : "这个 URL 正在导入。", 5000);
	}

	private isCurrentActiveRun(entry: ImportHistoryEntry): boolean {
		return this.jobRunner.isBusy() && this.activeRunHistoryId === entry.id;
	}

	private async markStaleImportFailed(entry: ImportHistoryEntry): Promise<void> {
		const staleMessage = "上一次导入没有完成。";
		let updatedEntry: ImportHistoryEntry | null = null;
		this.plugin.settings.recentImports = updateRecentImport(this.plugin.settings.recentImports, entry.id, (currentEntry) => ({
			...(updatedEntry = {
				...currentEntry,
				status: "failed",
				progressStage: "failed",
				progressPercent: 100,
				progressMessage: staleMessage,
				progressUpdatedAt: new Date().toISOString(),
				errorMessage: currentEntry.errorMessage ?? staleMessage,
			}),
		}));
		await this.plugin.saveSettings();
		if (updatedEntry) {
			await this.writeVisibleHistoryNote(updatedEntry);
		}
	}

	private async createHistoryEntry(url: string, model: string, apiBaseUrl: string): Promise<ImportHistoryEntry> {
		const host = new URL(url).host || "source";
		const entry: ImportHistoryEntry = {
			id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			url,
			host,
			apiBaseUrl,
			model,
			submittedAt: new Date().toISOString(),
			status: "processing",
			progressStage: "queued",
			progressPercent: 0,
			progressMessage: "已排队",
			progressUpdatedAt: new Date().toISOString(),
		};

		entry.historyNotePath = await this.createVisibleHistoryNote(entry);
		this.plugin.settings.recentImports = upsertRecentImport(this.plugin.settings.recentImports, entry);
		return entry;
	}

	private async applyJobResult(historyId: string, result: JobRunResult): Promise<void> {
		let updatedEntry: ImportHistoryEntry | null = null;
		this.plugin.settings.recentImports = updateRecentImport(this.plugin.settings.recentImports, historyId, (entry) => ({
			...(updatedEntry = {
				...entry,
				status: result.status,
				model: result.model,
				title: result.title,
				notePath: result.notePath,
				originalNotePath: result.originalNotePath,
				sourceType: result.sourceType,
				errorMessage: result.failure?.errorMessage,
				progressStage: result.status === "complete" ? "complete" : "failed",
				progressPercent: 100,
				progressMessage: result.status === "complete" ? "导入完成" : (result.failure?.errorMessage ?? "导入失败"),
				progressUpdatedAt: new Date().toISOString(),
			}),
		}));
		await this.plugin.saveSettings();
		if (updatedEntry) {
			await this.writeVisibleHistoryNote(updatedEntry);
		}
	}

	private removeHistoryEntry(historyId: string): void {
		this.plugin.settings.recentImports = this.plugin.settings.recentImports.filter((entry) => entry.id !== historyId);
	}

	private async handleJobProgress(event: JobProgressEvent): Promise<void> {
		if (!event.historyId) {
			return;
		}

		let updatedEntry: ImportHistoryEntry | null = null;
		this.plugin.settings.recentImports = updateRecentImport(this.plugin.settings.recentImports, event.historyId, (entry) => ({
			...(updatedEntry = {
				...entry,
				model: event.model,
				progressStage: event.stage,
				progressPercent: event.progressPercent,
				progressMessage: event.message,
				progressUpdatedAt: new Date().toISOString(),
				sourceType: event.sourceType ?? entry.sourceType,
				title: event.title ?? entry.title,
			}),
		}));
		await this.plugin.saveSettings();
		if (updatedEntry) {
			await this.writeVisibleHistoryNote(updatedEntry);
		}
	}

	private async createVisibleHistoryNote(entry: ImportHistoryEntry): Promise<string | undefined> {
		try {
			await this.ensureFolder(this.plugin.settings.historyFolder);
			const suffix = randomHexSuffix();
			const path = await this.resolveUniquePath(
				this.plugin.settings.historyFolder,
				buildHistoryFileName(entry.host, new Date(entry.submittedAt)),
				suffix,
			);
			await this.plugin.app.vault.create(path, renderHistoryNote(entry));
			return path;
		} catch (error) {
			console.error("[import-url] failed to create visible history note", error);
			return undefined;
		}
	}

	private async writeVisibleHistoryNote(entry: ImportHistoryEntry): Promise<void> {
		if (!entry.historyNotePath) {
			return;
		}

		try {
			await this.ensureFolder(this.plugin.settings.historyFolder);
			const file = this.plugin.app.vault.getAbstractFileByPath(entry.historyNotePath) as TFile | null;
			if (!file) {
				await this.plugin.app.vault.create(entry.historyNotePath, renderHistoryNote(entry));
				return;
			}

			await this.plugin.app.vault.modify(file, renderHistoryNote(entry));
		} catch (error) {
			console.error("[import-url] failed to update visible history note", error);
		}
	}

	async openVaultPath(path: string): Promise<boolean> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path) as TFile | null;
		if (!file) {
			new Notice("目标笔记不存在，可能已被移动或删除。", 4000);
			return false;
		}

		await this.plugin.app.workspace.getLeaf(true).openFile(file);
		return true;
	}

	async persistModelSelection(model: string, options: {writeConfig?: boolean} = {}): Promise<void> {
		const normalizedModel = model.trim();
		if (!normalizedModel) {
			return;
		}

		const writeConfig = options.writeConfig ?? true;
		let settingsChanged = false;
		if (this.plugin.settings.model !== normalizedModel) {
			this.plugin.settings.model = normalizedModel;
			settingsChanged = true;
		}

		const normalizedCustomModels = normalizeCustomModels(this.plugin.settings.customModels);
		if (normalizedCustomModels.length !== this.plugin.settings.customModels.length
			|| normalizedCustomModels.some((value, index) => value !== this.plugin.settings.customModels[index])) {
			this.plugin.settings.customModels = normalizedCustomModels;
			settingsChanged = true;
		}

		if (settingsChanged) {
			await this.plugin.saveSettings();
		}
		if (writeConfig) {
			await this.writeModelSelectionToConfigToml(normalizedModel);
		}
	}

	private migrateLegacyDefaultModel(): boolean {
		const savedModel = this.plugin.settings.model.trim();
		const apiBaseUrl = this.plugin.settings.apiBaseUrl.trim().replace(/\/+$/u, "");
		if (!savedModel || !LEGACY_GPT_MODEL_PATTERN.test(savedModel) || apiBaseUrl !== DEFAULT_SETTINGS.apiBaseUrl) {
			return false;
		}

		const preferredModel = this.plugin.settings.customModels.find((model) => model === PREFERRED_DEEPSEEK_MODEL) ?? PREFERRED_DEEPSEEK_MODEL;
		this.plugin.settings.model = preferredModel;
		this.plugin.settings.customModels = normalizeCustomModels([...this.plugin.settings.customModels, preferredModel]);
		return true;
	}

	private migrateEffectiveLegacyDefaultModel(): boolean {
		const effectiveModel = this.effectiveSettings.model.trim();
		const apiBaseUrl = this.effectiveSettings.apiBaseUrl.trim().replace(/\/+$/u, "");
		if (!effectiveModel || !LEGACY_GPT_MODEL_PATTERN.test(effectiveModel) || apiBaseUrl !== DEFAULT_SETTINGS.apiBaseUrl) {
			return false;
		}

		const preferredModel = this.plugin.settings.customModels.find((model) => model === PREFERRED_DEEPSEEK_MODEL) ?? PREFERRED_DEEPSEEK_MODEL;
		this.effectiveSettings = {
			...this.effectiveSettings,
			model: preferredModel,
			customModels: normalizeCustomModels([...this.effectiveSettings.customModels, preferredModel]),
		};
		return true;
	}

	private async writeModelSelectionToConfigToml(model: string): Promise<void> {
		try {
			await this.ensureConfigTomlReady();
			const configPath = this.plugin.settings.configTomlPath.trim() || DEFAULT_SETTINGS.configTomlPath;
			const file = this.plugin.app.vault.getAbstractFileByPath(configPath) as TFile | null;
			if (!file) {
				return;
			}

			const content = await this.readVaultFile(file);
			const nextContent = updateConfigTomlModel(content, model);
			if (nextContent !== content) {
				await this.plugin.app.vault.modify(file, nextContent);
			}
		} catch (error) {
			console.error("[import-url] failed to persist selected model to config.toml", error);
			new Notice("模型已保存到设置页，但写入配置文件失败。", 5000);
		}
	}

	private async readVaultFile(file: TFile): Promise<string> {
		const vault = this.plugin.app.vault as typeof this.plugin.app.vault & {
			cachedRead?: (file: TFile) => Promise<string>;
			read?: (file: TFile) => Promise<string>;
		};
		if (typeof vault.cachedRead === "function") {
			return vault.cachedRead(file);
		}
		if (typeof vault.read === "function") {
			return vault.read(file);
		}
		return "";
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			const existing = this.plugin.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.plugin.app.vault.createFolder(currentPath);
			}
		}
	}

	private async resolveUniquePath(folder: string, fileName: string, suffix: string): Promise<string> {
		let candidate = `${folder.replace(/\/+$/u, "")}/${fileName}`;

		if (!this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		const extension = ".md";
		const stem = candidate.endsWith(extension) ? candidate.slice(0, -extension.length) : candidate;
		candidate = `${stem} - ${suffix}${extension}`;

		if (!this.plugin.app.vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}

		let counter = 2;
		while (this.plugin.app.vault.getAbstractFileByPath(`${stem} - ${suffix}-${counter}${extension}`)) {
			counter += 1;
		}

		return `${stem} - ${suffix}-${counter}${extension}`;
	}
}
