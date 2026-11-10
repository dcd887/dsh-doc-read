# dsh-doc-read

给 DeepSeek Harness（dsh）的**省 token 文档读取器**。查一个数，不用把 300 页 PDF 整个读进来。

三个工具，按「越查越窄」排：

| 工具 | 干什么 | 什么时候用 |
|---|---|---|
| `doc_outline` | 列页码 + 每页一行预览 + 总页数与字节数 | 先看文档长什么样 |
| `doc_read` | 按页范围读纯文本，带页码标记 | 已经知道要看哪几页 |
| `doc_grep` | 只回命中行 + 页码（支持正则） | 只找一个事实 |

支持格式：`.pdf`、`.docx`、`.xlsx`、`.txt`、`.md`、`.csv`。

## 为什么值得装

一个 1,442 页的 PDF，整本读进来会把上下文吃光；用 `doc_grep` 找「违约金」三个字，回来的只有十几行。三个工具都带字符预算，结果里会告诉你「下一页从哪读」，不会一口气撑爆窗口。

## 安装

在 dsh profile 目录里：

```bash
dsh plugin add github:dcd887/dsh-doc-read
```

然后在 `cordis.patch.yml` 里启用它（插件自带 `cordis.patch.yml`，`:plugin` 名与本包一致）。依赖 `pdfjs-dist` 由 pnpm 自动装。

本地开发时也可以直接 link：

```yaml
# package.json
"dependencies": { "dsh-doc-read": "link:../dsh-doc-read" }
```

## 用法

### doc_outline

```json
{ "path": "D:/docs/report.pdf", "maxPages": 60 }
```

返回每页一行预览，例如：

```
p.12  | 第三章 违约责任 ............
p.13  | 3.1 甲方未按期交付的，每逾期一日……
```

### doc_read

```json
{ "path": "D:/docs/report.pdf", "from": 13, "to": 16, "maxChars": 6000, "pageChars": 1500 }
```

`maxChars` 是这次调用的总字符预算，`pageChars` 是单页上限。两个都给默认值，一般不用动。

### doc_grep

```json
{ "path": "D:/docs/report.pdf", "pattern": "违约金", "limit": 30, "snippet": 80 }
```

要正则就加 `"regex": true`；大小写默认不敏感（`ignoreCase` 默认 `true`）。`scanPages` 限制扫描页数，默认 300，长文档可以调大。

## 限制（先说清楚）

- 只读，不写、不改文档。
- PDF 只取文本层：扫描件（纯图片）拿不到字，需要 OCR 的话请先用别的工具转文本。
- `.xlsx` 按 sheet 摊平读，不保留合并单元格的结构。
- 单文件大小上限由配置 `maxBytes` 控制（默认见源码 `DEFAULTS`）。

## 自测

```bash
pnpm install      # 需要 pdfjs-dist
pnpm test         # node selftest.mjs
```

自测**自带样例**，不需要你准备文件：`test/fixtures/` 里有三个小文件（`sample.pdf` 两页、`sample.docx` 三段、`sample.txt` 三行），自测会对每个文件跑 `doc_outline` / `doc_read` / `doc_grep`，逐项断言并打印 PASS/FAIL，任一失败退出码为 1。

想用自己的大文件压测，设环境变量指向一个目录：

```bash
DOC_READ_SAMPLES=/path/to/pdfs pnpm test
```

自测会跑该目录下所有 `.pdf` / `.docx` / `.xlsx` / `.txt` / `.md` / `.csv`，断言用的是关键字 `fixture`——你自己的文件里没有这个词时，grep 断言会失败，这是预期行为（换成你文件里确实存在的词即可）。

## 许可

MIT

