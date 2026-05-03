import {Notice, Plugin} from "obsidian";
import {registerImportUrlCommands} from "./commands";
import {ImportController} from "./import-controller";
import {DEFAULT_SETTINGS, ImportUrlSettingTab} from "./settings";
import {ImportUrlPluginSettings} from "./types";
import {WIKI_MANAGER_VIEW_TYPE, WikiManagerView} from "./wiki-manager-view";

export default class ImportUrlPlugin extends Plugin {
	settings: ImportUrlPluginSettings = DEFAULT_SETTINGS;
	private controller?: ImportController;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.getController().initialize();

		this.registerView(WIKI_MANAGER_VIEW_TYPE, (leaf) => new WikiManagerView(leaf, {
			loadOverview: (sortMode) => this.getController().getWikiOverview(sortMode),
			approveCandidate: (path, graphVisible) => this.getController().approveWikiCandidate(path, graphVisible),
			rejectCandidate: (path) => this.getController().rejectWikiCandidate(path),
			setConceptGraphVisibility: (path, graphVisible) => this.getController().setWikiConceptGraphVisibility(path, graphVisible),
			applyGraphColorGroups: () => this.getController().applyGraphColorGroups(),
			cleanupLegacyGraphLinks: () => this.getController().cleanupLegacyConceptGraphLinks(),
			rebuildConceptGraph: () => this.getController().rebuildWikiConceptGraph(),
			openPath: (path) => this.getController().openVaultPath(path),
		}));

		registerImportUrlCommands(this, {
			openImportModal: () => this.getController().openImportModal(),
			openConfigToml: () => this.getController().openConfigToml(),
			openWikiIndex: () => this.getController().openWikiIndex(),
			openWikiManager: () => this.getController().openWikiManager(),
			applyGraphColorGroups: () => this.getController().applyGraphColorGroups(),
			cleanupLegacyGraphLinks: () => this.getController().cleanupLegacyConceptGraphLinks(),
			rebuildConceptGraph: () => this.getController().rebuildWikiConceptGraph(),
			approveCurrentWikiCandidate: () => this.getController().approveCurrentWikiCandidate(),
			rejectCurrentWikiCandidate: () => this.getController().rejectCurrentWikiCandidate(),
			importClipboardUrl: () => this.getController().importClipboardUrl(),
		});

		this.addSettingTab(new ImportUrlSettingTab(this.app, this));
	}

	async getEffectiveSettings(): Promise<ImportUrlPluginSettings> {
		return this.getController().getEffectiveSettings();
	}

	async ensureConfigTomlReady(): Promise<void> {
		await this.getController().ensureConfigTomlReady();
	}

	async openConfigToml(): Promise<void> {
		await this.getController().openConfigToml();
	}

	async persistModelSelection(model: string): Promise<void> {
		await this.getController().persistModelSelection(model);
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.readStoredSettingsSafely();
		const migrated = this.getController().loadStoredSettings(loaded);
		if (migrated) {
			await this.saveSettings();
		}
	}

	private getController(): ImportController {
		if (!this.controller) {
			this.controller = new ImportController(this);
		}
		return this.controller;
	}

	private async readStoredSettingsSafely(): Promise<Partial<ImportUrlPluginSettings> | null> {
		try {
			return await this.loadData() as Partial<ImportUrlPluginSettings> | null;
		} catch (error) {
			console.error("[import-url] failed to read data.json, falling back to defaults", error);
			new Notice("设置文件无效，已自动恢复默认值。", 7000);

			this.settings = Object.assign({}, DEFAULT_SETTINGS);
			try {
				await this.saveData(this.settings);
			} catch (saveError) {
				console.error("[import-url] failed to rewrite default settings after data read error", saveError);
			}

			return null;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
