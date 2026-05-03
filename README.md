# Import URL

[中文说明](./README.zh-CN.md)

Import URL is an Obsidian community plugin that imports a public web page or direct PDF URL into your vault, saves the original Markdown, and creates linked knowledge-base notes with a DeepSeek-style model API.

## What it does

- Import public article pages and direct PDF links
- Extract readable content and generate a separate original-content note
- Download article images into a vault attachment folder by default and embed local images in the original note
- Optionally run image text recognition, disabled by default, only when a separate vision model endpoint and key are configured
- Generate an AI structured Markdown note
- Generate knowledge-base source records and reviewable concept candidates; pending candidates do not create graph links by default
- Approve or reject candidates in a knowledge-base manager, and choose whether approved concepts appear in plugin-generated graph links
- Sort concepts by initial letter, import time, or link count, with link counts shown in the manager
- Rebuild graph links conservatively so only approved concept pages link to genuinely related approved concepts
- Let you choose a model before each import
- Keep visible import history inside your vault
- Show latest match for the current URL and let you jump back to recent result/history notes
- Support per-model API base URLs for model endpoints
- Stay local-first, with optional third-party fallback fetch methods clearly exposed in settings

## Installation

### Manual install

Build the plugin, then copy these files into:

`<Vault>/.obsidian/plugins/import-url/`

- `manifest.json`
- `main.js`
- `styles.css`

Reload Obsidian, then enable **Settings → Community plugins → Import URL**.

## Default folders

By default, the plugin writes only under `我的知识库`:

- `我的知识库/成文`: model-organized structured notes.
- `我的知识库/原文`: extracted original Markdown from the web page or PDF.
- `我的知识库/状态/处理中`: temporary in-progress records.
- `我的知识库/状态/失败记录`: failure diagnostic notes.
- `我的知识库/状态/历史记录`: visible import history records.
- `我的知识库/附件/图片`: downloaded web-page image attachments.
- `我的知识库/概念库/来源`: per-import source records.
- `我的知识库/概念库/待入库`: concept pages waiting for review.
- `我的知识库/概念库/已入库`: approved concept pages.
- `我的知识库/概念库/索引.md`: generated knowledge-base index.

## Usage

1. Open the command palette and run `从 URL 导入` (`import`), or click the ribbon icon.
2. Paste a public URL.
3. Choose a model.
4. Check the summary tip to see the latest import status for the same URL, and optionally open the latest result/history note.
5. Wait for the plugin to create separate original and AI整理 notes, plus the source record and pending concept pages.
6. (Optional) Run `打开配置文件` (`open-config`) to edit `config.toml` directly in your vault.
7. (Optional) Run `打开知识库管理` (`open-wiki-manager`) to review candidates, toggle graph visibility, and inspect link counts.
8. (Optional) Run `批准当前知识库候选页` or `拒绝当前知识库候选页` while a candidate note is active.
9. (Optional) Select `清理旧图谱链接` in the manager to remove old pre-approval concept wikilinks from generated AI整理 notes.
10. (Optional) Select `重建真实关联` in the manager to remove noisy wikilinks from generated files and rebuild only approved concept-to-concept links.

## Pending and approved concepts

- Pending: a model-extracted draft from imported content. It is written to `我的知识库/概念库/待入库` for review, does not overwrite the formal knowledge base, and does not create formal concept wikilinks in the AI整理 note before approval.
- Approved: a formal knowledge-base page under `我的知识库/概念库/已入库`. The manager can mark it visible or hidden; hidden concepts are excluded from plugin-rebuilt relationship links.
- Graph rebuilds only use explicit `相关概念` sections in approved concept pages, so two terms merely appearing in the same body text no longer creates a relationship.

## Graph color groups

Obsidian’s core graph colors are configured in **Graph → Groups**. The plugin writes stable tags so you can color groups directly:

- Concepts: `tag:#import-url/concept`
- Pending candidates: `tag:#import-url/candidate`
- AI整理 notes: `tag:#import-url/article`
- Original notes: `tag:#import-url/original`
- Source/index/history/status notes: `tag:#import-url/source`, `tag:#import-url/index`, `tag:#import-url/history`, `tag:#import-url/processing`, `tag:#import-url/failed`

Your own handwritten files do not receive these tags, so they stay in the graph’s default color unless you add separate groups. The plugin also writes a `graph_group` frontmatter field for property-based search or future filtering.

Recommended group order:

1. `tag:#import-url/concept`: concept pages, use a strong color.
2. `tag:#import-url/candidate`: pending candidates, keep separate from formal concepts.
3. `tag:#import-url/article`: AI整理 notes, use a lighter color.
4. `tag:#import-url/original`: original source notes, use gray or low-saturation color.
5. `tag:#import-url/source OR tag:#import-url/index OR tag:#import-url/history OR tag:#import-url/processing OR tag:#import-url/failed`: source and status files, use a faint color or filter them out.

Your own files do not carry `#import-url/...` tags, so they remain as the third category in the default graph color unless you create your own path/tag group.

## Configuration

Settings are grouped into `模型接口`, `模型`, `输出`, `图片`, and `抓取兜底`.

Runtime precedence remains:

- stored plugin settings as baseline
- `config.toml` overrides applied at runtime before modal open/import start

The plugin supports:

- secure API key storage through Obsidian secret storage
- a DeepSeek API address, defaulting to `https://api.deepseek.com`
- extra custom model names
- per-model API base URL overrides
- output, processing, failed, history, and knowledge-base folders
- image download folder; image attachments are saved as original evidence and do not participate in concept graph edges
- optional image text recognition through either an OpenAI-compatible vision endpoint or Baidu text recognition; missing text-recognition keys only skip recognition and do not fail the import
- optional fallback fetchers with clear disclosure

## Images and text recognition

- Web-page body images are saved by default to `我的知识库/附件/图片`, and original notes use local `![[...]]` embeds.
- Icons, avatars, emoji, ads, tiny decorations, and invalid URLs are skipped quietly; actual body-image download errors are listed in the original note.
- Image text recognition is off by default. When enabled, it only processes downloaded body images, with a default maximum of 8 images per import.
- The main organizing model still receives text Markdown, image alt/caption metadata, and optional text-recognition output; raw images are not sent through the DeepSeek text organizing path.
- Image text recognition uses separate settings and secret names so it does not silently reuse the main model key.
- Baidu text recognition is supported through a Baidu interface key and private key. The plugin stores those values in Obsidian secret storage, exchanges them for an access token, and calls Baidu's text-recognition endpoint only when recognition is enabled.

## Platform support

- Core import flow is compatible with desktop and mobile.
- `阅读模式兜底` is used when direct fetch fails or only returns a script shell. It sends the source URL to r.jina.ai and is off by default.
- `浏览器渲染兜底（实验）` is disabled by default and desktop-only (currently macOS-only).
- On unsupported environments, browser-render fallback fails clearly without touching desktop-only APIs.

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

Run lint:

```bash
npm run lint
```

## Troubleshooting

- Missing API key:
  Save the key in Settings under `模型接口` → `API 密钥`. Imports and connection tests both require a saved key.
- Missing model:
  Enter a model name in Settings under `模型` → `默认模型`, or choose a model in the import modal.
- `config.toml` seems ignored:
  Confirm the path in `模型接口` → `配置文件路径`, then reopen the modal or start a new import to reload runtime overrides.
- Import fails on mobile with browser fallback enabled:
  Disable `浏览器渲染兜底（实验）`. It is desktop-only and currently macOS-only.
- Import appears stuck:
  Check the visible history note under your configured `历史记录目录` to see stage, progress message, and last update time.

## Release

For an Obsidian release, attach these files to the GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`

Make sure the Git tag exactly matches the plugin version in `manifest.json` without a leading `v`.

Source of truth stays under `src/`; generated artifacts (such as `main.js`) are build outputs.
