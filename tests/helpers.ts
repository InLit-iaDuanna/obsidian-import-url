import {App, RequestUrlResponse} from "obsidian";

export interface FakeFile {
	path: string;
	content: string;
	binary?: ArrayBuffer;
}

interface FakeFolder {
	path: string;
}

type Entry = FakeFile | FakeFolder;
export const FAKE_CONFIG_DIR = [".", "obsidian"].join("");

function isFakeFile(entry: Entry): entry is FakeFile {
	return "content" in entry;
}

export class FakeVault {
	private readonly entries = new Map<string, Entry>();
	readonly adapter = {
		exists: async (path: string): Promise<boolean> => this.entries.has(path),
		read: async (path: string): Promise<string> => this.read(path),
		write: async (path: string, content: string): Promise<void> => {
			const existing = this.entries.get(path);
			if (existing && isFakeFile(existing)) {
				existing.content = content;
				this.entries.set(path, existing);
				return;
			}
			this.entries.set(path, {path, content});
		},
	};
	readonly configDir = FAKE_CONFIG_DIR;

	getAbstractFileByPath(path: string): Entry | null {
		return this.entries.get(path) ?? null;
	}

	async createFolder(path: string): Promise<void> {
		if (!this.entries.has(path)) {
			this.entries.set(path, {path});
		}
	}

	async create(path: string, content: string): Promise<FakeFile> {
		if (this.entries.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}

		const file: FakeFile = {path, content};
		this.entries.set(path, file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<FakeFile> {
		if (this.entries.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}

		const file: FakeFile = {path, content: "", binary: data};
		this.entries.set(path, file);
		return file;
	}

	async modify(file: FakeFile, content: string): Promise<void> {
		file.content = content;
		delete file.binary;
		this.entries.set(file.path, file);
	}

	async modifyBinary(file: FakeFile, data: ArrayBuffer): Promise<void> {
		file.binary = data;
		file.content = "";
		this.entries.set(file.path, file);
	}

	async cachedRead(file: FakeFile): Promise<string> {
		return file.content;
	}

	async readBinary(file: FakeFile): Promise<ArrayBuffer> {
		return file.binary ?? new ArrayBuffer(0);
	}

	async rename(file: FakeFile, targetPath: string): Promise<void> {
		const existing = this.entries.get(targetPath);
		if (existing && existing !== file) {
			throw new Error(`Target already exists: ${targetPath}`);
		}

		this.entries.delete(file.path);
		file.path = targetPath;
		this.entries.set(targetPath, file);
	}

	listFiles(): FakeFile[] {
		return [...this.entries.values()].filter(isFakeFile);
	}

	read(path: string): string {
		const entry = this.entries.get(path);
		if (!entry || !isFakeFile(entry)) {
			throw new Error(`No file at path: ${path}`);
		}

		return entry.content;
	}
}

export class FakeWorkspace {
	readonly openedFiles: FakeFile[] = [];
	private activeFile: FakeFile | null = null;

	getLeaf(): {openFile: (file: FakeFile) => Promise<void>} {
		return {
			openFile: async (file: FakeFile) => {
				this.openedFiles.push(file);
				this.activeFile = file;
			},
		};
	}

	getActiveFile(): FakeFile | null {
		return this.activeFile;
	}

	setActiveFile(file: FakeFile): void {
		this.activeFile = file;
	}
}

export function createFakeApp(): {app: App; vault: FakeVault; workspace: FakeWorkspace} {
	const vault = new FakeVault();
	const workspace = new FakeWorkspace();
	return {
		app: {vault, workspace} as unknown as App,
		vault,
		workspace,
	};
}

export function createResponse(status: number, text: string, headers: Record<string, string> = {}): RequestUrlResponse {
	let parsedJson: unknown = null;
	try {
		parsedJson = JSON.parse(text);
	} catch {
		parsedJson = null;
	}

	return {
		status,
		text,
		headers,
		arrayBuffer: new ArrayBuffer(0),
		json: parsedJson,
	} as RequestUrlResponse;
}

export function createBinaryResponse(status: number, arrayBuffer: ArrayBuffer, headers: Record<string, string> = {}): RequestUrlResponse {
	return {
		status,
		text: "",
		headers,
		arrayBuffer,
		json: null,
	} as RequestUrlResponse;
}
