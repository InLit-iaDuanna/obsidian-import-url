import {vi} from "vitest";

export class App {}
export class TAbstractFile {
	path = "";
}

export class TFile extends TAbstractFile {
	content = "";
}

export class Notice {
	message: string;
	timeout?: number;

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}
}

export class Plugin {
	app: App;

	constructor(app: App) {
		this.app = app;
	}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl = document.createElement("div");

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}
}

export class Setting {
	constructor(public containerEl: HTMLElement) {}
	setName(): this { return this; }
	setDesc(): this { return this; }
	addText(callback: (component: TextComponent) => void): this {
		callback(new TextComponent(this.containerEl));
		return this;
	}
	addButton(callback: (component: ButtonComponent) => void): this {
		callback(new ButtonComponent(this.containerEl));
		return this;
	}
	addExtraButton(callback: (component: ButtonComponent) => void): this {
		callback(new ButtonComponent(this.containerEl));
		return this;
	}
	addToggle(callback: (component: ToggleComponent) => void): this {
		callback(new ToggleComponent(this.containerEl));
		return this;
	}
	addDropdown(callback: (component: DropdownComponent) => void): this {
		callback(new DropdownComponent(this.containerEl));
		return this;
	}
	addTextArea(callback: (component: TextAreaComponent) => void): this {
		callback(new TextAreaComponent(this.containerEl));
		return this;
	}
}

export class Modal {
	contentEl = document.createElement("div");
	constructor(public app: App) {}
	open(): void {}
	close(): void {}
}

export class TextComponent {
	inputEl = document.createElement("input");

	constructor(_containerEl?: HTMLElement) {}
	setPlaceholder(): this { return this; }
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
	setDisabled(): this { return this; }
	getValue(): string { return this.inputEl.value; }
}

export class ButtonComponent {
	constructor(_containerEl?: HTMLElement) {}
	setButtonText(): this { return this; }
	setCta(): this { return this; }
	onClick(): this { return this; }
	setDisabled(): this { return this; }
}

export class ToggleComponent {
	constructor(_containerEl?: HTMLElement) {}
	setValue(): this { return this; }
	onChange(): this { return this; }
}

export function htmlToMarkdown(html: string): string {
	return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export class DropdownComponent {
	selectEl = document.createElement("select");

	constructor(_containerEl?: HTMLElement) {}
	addOption(value: string, label: string): this {
		const optionEl = document.createElement("option");
		optionEl.value = value;
		optionEl.text = label;
		this.selectEl.appendChild(optionEl);
		return this;
	}
	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
}

export class TextAreaComponent {
	inputEl = document.createElement("textarea");

	constructor(_containerEl?: HTMLElement) {}
	setPlaceholder(): this { return this; }
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
}

export const requestUrl = vi.fn();
