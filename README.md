# Import URL

[中文说明](./README.zh-CN.md)

Import URL is an Obsidian community plugin that imports a public web page or direct PDF URL into your vault and turns it into a structured Markdown note with OpenAI.

## What it does

- Import public article pages and direct PDF links
- Extract readable content and generate structured Markdown notes
- Let you choose a model before each import
- Keep visible import history inside your vault
- Support per-model API base URLs for OpenAI-compatible endpoints
- Stay local-first, with optional third-party fallback fetch methods clearly exposed in settings

## Installation

### Manual install

Build the plugin, then copy these files into:

`<Vault>/.obsidian/plugins/import-url/`

- `manifest.json`
- `main.js`
- `styles.css`

Reload Obsidian, then enable **Settings → Community plugins → Import URL**.

## Usage

1. Open the command palette and run `Import URL`, or click the ribbon icon.
2. Paste a public URL.
3. Choose a model.
4. Wait for the plugin to create the final note and update the import history.

## Configuration

The plugin supports:

- secure API key storage through Obsidian secret storage
- a default OpenAI-compatible API base URL
- extra custom model IDs
- per-model API base URL overrides
- output, processing, failed, and history folders
- optional fallback fetchers

## Development

Install dependencies:

```bash
npm install
```

Start development build:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Run tests:

```bash
npm run test
```

## Release

For an Obsidian release, attach these files to the GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`

Make sure the Git tag exactly matches the plugin version in `manifest.json` without a leading `v`.
