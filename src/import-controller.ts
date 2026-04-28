import {Notice, TFile} from "obsidian";
import type ImportUrlPlugin from "./main";
import {findActiveImportForUrl, normalizeRecentImports, updateRecentImport, upsertRecentImport, getPreferredImportOpenPath} from "./history";
import {getModelOptions, getPrimaryModel, normalizeCustomModels, normalizeModelApiBaseUrls, resolveModelApiBaseUrl} from "./model-catalog";
import {ImportUrlModal} from "./modal";
import {JobRunner} from "./pipeline/job-runner";
import {parseHttpUrl} from "./pipeline/url-validator";
import {buildHistoryFileName, renderHistoryNote} from "./render/history-note";
import {randomHexSuffix} from "./render/notes";
import {DEFAULT_SETTINGS, readSecretValue} from "./settings";
import {UserInputError} from "./types";
import type {ImportHistoryEntry, ImportUrlPluginSettings, JobProgressEvent, JobRunResult} from "./types";
import {applyConfigTomlOverrides, readImportUrlConfigToml, renderDefaultConfigToml} from "./config-toml";

export class ImportController {
	private effectiveSettings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private jobRunner!: JobRunner;

	constructor(private readonly plugin: ImportUrlPlugin) {}

	async initialize(): Promise<void> {
		await this.tryEnsureConfigTomlReady();
		await this.refreshEffectiveSettings();

		this.jobRunner = new JobRunner({
			app: this.plugin.app,
			getSettings: () => this.effectiveSettings,
			getApiKey: async (secretName: string) => readSecretValue(this.plugin.app, secretName),
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
			new Notice("Failed to create config.toml. Check the configured path.", 5000);
			return;
		}

		await this.plugin.app.workspace.getLeaf(true).openFile(file);
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
			onSubmit: (rawUrl: string, model: string) => this.startImport(rawUrl, model),
		}).open();
	}

	async importClipboardUrl(): Promise<void> {
		if (this.jobRunner.isBusy()) {
			new Notice("Another import is already running. Please wait.", 4000);
			return;
		}

		try {
			const clipboardText = await navigator.clipboard?.readText?.();
			const rawUrl = clipboardText?.trim();
			if (!rawUrl) {
				new Notice("No URL found in clipboard.", 3000);
				return;
			}

			const effectiveSettings = await this.refreshEffectiveSettings();
			await this.startImport(rawUrl, effectiveSettings.model);
		} catch {
			new Notice("Could not read clipboard. Paste manually.", 4000);
		}
	}

	loadStoredSettings(loaded: Partial<ImportUrlPluginSettings> | null): void {
		this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		this.plugin.settings.customModels = normalizeCustomModels(Array.isArray(this.plugin.settings.customModels) ? this.plugin.settings.customModels : []);
		this.plugin.settings.modelApiBaseUrls = normalizeModelApiBaseUrls(Array.isArray(this.plugin.settings.modelApiBaseUrls) ? this.plugin.settings.modelApiBaseUrls : []);
		this.plugin.settings.configTomlPath = this.plugin.settings.configTomlPath?.trim() || DEFAULT_SETTINGS.configTomlPath;
		this.plugin.settings.recentImports = normalizeRecentImports(this.plugin.settings.recentImports);
		this.effectiveSettings = this.plugin.settings;
	}

	private async tryEnsureConfigTomlReady(): Promise<void> {
		try {
			await this.ensureConfigTomlReady();
		} catch (error) {
			console.error("[import-url] failed to initialize config.toml", error);
			new Notice("Failed to initialize config.toml. The plugin will continue loading.", 7000);
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
		} catch (error) {
			console.error("[import-url] failed to read config.toml", error);
			this.effectiveSettings = applyConfigTomlOverrides(this.plugin.settings, null);
			new Notice("Failed to parse config.toml. Using values from the settings tab.", 6000);
		}

		return this.effectiveSettings;
	}

	private async startImport(rawUrl: string, selectedModel: string): Promise<void> {
		let historyEntry: ImportHistoryEntry | null = null;

		try {
			const effectiveSettings = await this.refreshEffectiveSettings();
			const normalizedUrl = parseHttpUrl(rawUrl).toString();
			const activeModel = getPrimaryModel(selectedModel, effectiveSettings.model);
			const resolvedApiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, activeModel) || effectiveSettings.apiBaseUrl;
			const existingActiveImport = findActiveImportForUrl(this.plugin.settings.recentImports, normalizedUrl, activeModel);
			if (existingActiveImport) {
				await this.revealActiveImport(existingActiveImport);
				return;
			}

			if (this.jobRunner.isBusy()) {
				throw new UserInputError("Another import is already running. Please wait.");
			}

			if (activeModel !== this.plugin.settings.model) {
				this.plugin.settings.model = activeModel;
			}

			historyEntry = await this.createHistoryEntry(normalizedUrl, activeModel, resolvedApiBaseUrl);
			await this.plugin.saveSettings();

			const result = await this.jobRunner.run({
				rawUrl: normalizedUrl,
				model: activeModel,
				apiBaseUrl: resolvedApiBaseUrl,
				historyId: historyEntry.id,
			});
			await this.applyJobResult(historyEntry.id, result);
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
						errorMessage: error instanceof Error ? error.message : "Unknown error",
					}),
				}));
				await this.plugin.saveSettings();
				if (updatedEntry) {
					await this.writeVisibleHistoryNote(updatedEntry);
				}
			}
			console.error("[import-url] unexpected import failure", error);
			new Notice("Import failed. Processing or failed notes were kept when possible.", 6000);
		}
	}

	private async revealActiveImport(entry: ImportHistoryEntry): Promise<void> {
		const preferredPath = getPreferredImportOpenPath(entry);
		if (preferredPath) {
			await this.openVaultPath(preferredPath);
		}

		new Notice("This URL is already being imported. Opened the current record.", 5000);
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
			progressMessage: "Queued",
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
				sourceType: result.sourceType,
				errorMessage: result.failure?.errorMessage,
				progressStage: result.status === "complete" ? "complete" : "failed",
				progressPercent: 100,
				progressMessage: result.status === "complete" ? "Import complete" : (result.failure?.errorMessage ?? "Import failed"),
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
				buildHistoryFileName(entry.host, suffix, new Date(entry.submittedAt)),
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

	private async openVaultPath(path: string): Promise<boolean> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path) as TFile | null;
		if (!file) {
			new Notice("Target note does not exist. It may have been moved or deleted.", 4000);
			return false;
		}

		await this.plugin.app.workspace.getLeaf(true).openFile(file);
		return true;
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
