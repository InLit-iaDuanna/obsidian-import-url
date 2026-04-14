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

1. 打开命令面板，执行 `Import URL`，或者点击侧边栏图标。
2. 粘贴一个公开 URL。
3. 选择模型。
4. 等待插件创建最终笔记并更新导入历史。

## 配置项

插件支持以下配置：

- 通过 Obsidian 安全存储保存 API Key
- 配置默认 OpenAI 兼容 API 地址
- 添加额外的自定义模型 ID
- 为特定模型单独覆盖 API 地址
- 配置输出、处理中、失败和历史目录
- 启用可选的抓取回退方式

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

## 发布

发布到 Obsidian 时，请将以下文件作为 GitHub Release 附件上传：

- `manifest.json`
- `main.js`
- `styles.css`

请确保 Git 标签与 `manifest.json` 中的版本号完全一致，且不要添加前导 `v`。
