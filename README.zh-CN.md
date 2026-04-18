# Import URL

[English README](./README.md)

Import URL 是一个 Obsidian 社区插件，可以把公开网页或直链 PDF 导入到你的库中，并借助 OpenAI 生成结构化 Markdown 笔记。

## 功能简介

- 导入公开文章页面和直链 PDF
- 提取可读正文并生成结构化 Markdown 笔记
- 每次导入前都可以选择模型
- 在库内保留可见的导入历史
- 支持为不同模型单独配置 OpenAI 兼容 API 地址
- 默认偏本地使用，可选第三方抓取回退方式，并在设置中明确说明

## 安装

### 手动安装

先构建插件，然后把这些文件复制到：

`<Vault>/.obsidian/plugins/import-url/`

- `manifest.json`
- `main.js`
- `styles.css`

重新加载 Obsidian，然后在 **设置 → 第三方插件 → Import URL** 中启用插件。

## 使用方法

1. 打开命令面板，执行 `Import from URL`（命令 ID：`import`），或点击侧边栏图标。
2. 粘贴一个公开 URL。
3. 选择模型。
4. 等待插件创建最终笔记并更新导入历史。
5. （可选）执行 `Open config file`（命令 ID：`open-config`）直接编辑库内 `config.toml`。

## 配置项

设置页按 `Connection`、`Models`、`Output`、`Fallbacks` 分组。

运行时优先级保持不变：

- 已保存的插件设置作为基线
- 导入时读取 `config.toml` 并覆盖对应项

插件支持以下配置：

- 通过 Obsidian 安全存储保存 API Key
- 配置默认 OpenAI 兼容 API 地址
- 添加额外的自定义模型 ID
- 为特定模型单独覆盖 API 地址
- 配置输出、处理中、失败和历史目录
- 启用可选抓取回退（并在设置中明确披露）

## 平台支持说明

- 核心导入流程兼容桌面和移动端。
- `Site JSON fallback` 与 `Reader fallback` 行为保持不变。
- `Browser render fallback (experimental)` 默认关闭，仅限桌面环境，当前仅 macOS。
- 在不支持环境中会清晰失败，不会触发桌面专用 API。

## 开发

安装依赖：

```bash
npm install
```

启动开发构建：

```bash
npm run dev
```

生成生产构建：

```bash
npm run build
```

运行测试：

```bash
npm run test
```

运行 Lint：

```bash
npm run lint
```

## 常见问题排查

- 提示缺少 API Key：
  在设置 `Connection` → `API key` 保存密钥后再执行导入或连接测试。
- `config.toml` 看起来没生效：
  先确认 `Connection` → `Config file path` 路径正确，再重新打开导入弹窗或发起一次新导入触发重载。
- 移动端开启浏览器渲染回退后失败：
  关闭 `Browser render fallback (experimental)`；该能力仅限桌面端，当前仅 macOS。
- 感觉导入卡住：
  到你配置的 `History folder` 查看可见历史笔记，确认阶段、进度信息和最近更新时间。

## 发布

发布到 Obsidian 时，请将以下文件作为 GitHub Release 附件上传：

- `manifest.json`
- `main.js`
- `styles.css`

请确保 Git 标签与 `manifest.json` 中的版本号完全一致，且不要添加前导 `v`。

源码事实来源保持在 `src/`；`main.js` 等为构建产物。
