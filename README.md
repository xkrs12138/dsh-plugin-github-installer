# @deepseek-ai/dsh-plugin-github-installer

从 GitHub 仓库直接安装 DSH 插件。

这个插件给 DeepSeek Harness 增加一个面向模型的工具 `github_install_plugin`：粘贴任意 GitHub 仓库地址（完整 URL、`github:owner/repo`、SSH 地址、`owner/repo`、或 `.tgz/.tar.gz` 压缩包链接），它会先校验仓库是否存在、确认它声明了 `dsh.bundle`，再通过 profile 内置的插件管理器完成安装——与官方 `plugin_manager install_bundle` 走完全相同的安装流水线。

## 功能

- **地址解析**：自动识别并规范化以下格式
  - `https://github.com/owner/repo`
  - `https://github.com/owner/repo.git`
  - `github:owner/repo`
  - `git@github.com:owner/repo.git`
  - 裸 `owner/repo`
  - GitHub 浏览链接 `https://github.com/owner/repo/tree/main/packages/foo`（自动识别分支与 monorepo 子目录）
  - `.tgz` / `.tar.gz` tarball 链接
- **monorepo 支持**：`#path=packages/foo` 或浏览链接的子目录会被转成 pnpm 的 git 依赖子目录安装
- **版本锁定**：`#ref=branch`、`#tag=v1.0.0`、`#commit=<sha>` 可锁定分支/标签/提交
- **安装前校验**（默认开启）：通过 GitHub API 确认仓库存在、读取仓库描述与 star 数、检查 `package.json` 是否声明 `dsh.bundle.patch`，避免误装普通 npm 包
- **复用官方流水线**：连通性检查、传输协议选择（HTTPS/SSH）、pnpm 安装、bundle 激活，全部复用内置 `pluginManager` 服务

## 安装

这个插件本身就是一个可通过 git URL 安装的 DSH 插件。在 Harness 里让 agent 执行：

```
plugin_manager install_bundle github:deepseek-ai/dsh-plugin-github-installer
```

或者直接对 agent 说：

> 帮我从 GitHub 安装插件 `deepseek-ai/dsh-plugin-github-installer`

安装需要 `danger-full-access` 权限（与所有插件安装一致）。

## 使用

安装后，agent 会获得 `github_install_plugin` 工具。你只需给出仓库地址：

> 帮我安装这个 GitHub 插件：https://github.com/someone/awesome-dsh-plugin

或指定 monorepo 子目录、锁定版本：

> 从 github:someone/monorepo#path=packages/my-plugin&ref=main 安装插件

### 工具参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `repo` | string | 是 | GitHub 仓库引用（URL / shorthand / SSH / owner/repo / tarball），可带 `#path=`、`#ref=`、`#tag=`、`#commit=` |
| `inspect` | boolean | 否 | 安装前是否用 GitHub API 校验（默认 `true`）。设为 `false` 跳过校验直接安装 |
| `enabled` | boolean | 否 | 是否在 profile 中激活已安装的 bundle（默认 `true`） |

### 输出

工具返回 JSON，包含：
- `spec` / `github`：规范化后的安装 spec 与是否指向 GitHub 仓库
- `inspection`：仓库描述、homepage、star 数、是否声明 `dsh.bundle`（仅在 `inspect:true` 时）
- 安装结果（复用 `pluginManager.installBundle` 的返回）：`application`、以及未生效时的 `nextStep`

如果 `inspection.declaresBundle === false`，工具会拒绝安装并提示原因，避免把普通 npm 包当插件装进 profile。

## 原理

```
用户粘贴地址
   │  normalizeGithubReference()
   │  识别格式 → 规范化为 pnpm install spec
   ▼
(可选) GitHub API 校验
   │  fetchRepoMeta() 仓库存在 + 描述
   │  fetchPackageManifest() 检查 dsh.bundle.patch
   ▼
ctx.pluginManager.installBundle(spec)
   │  与官方 plugin_manager 完全相同的流水线：
   │  parseInstallSpec → checkGithubConnection → pnpm install → reconcile → activate
   ▼
返回安装结果 / nextStep
```

## 目录结构

```
dsh-plugin-github-installer/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 声明插件行 plugin-github-installer
├── lib/
│   ├── index.js          # apply(ctx) + defineTool('github_install_plugin')
│   └── types/index.d.ts  # 类型声明
└── LICENSE
```

## 许可

MIT
