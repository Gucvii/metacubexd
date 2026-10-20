# 本地独立运行与迁移

这是 `Gucvii/metacubexd` 的首阶段迁移底座，基于上游 v1.273.1。
沿用官方 Electron 桌面端、共享 TypeScript Agent、Mihomo supervisor 和权限 helper。
没有额外启动 Go 服务、Docker 容器或另一套 launchd 内核管理器。

## 当前运行方式

- 应用：`~/Applications/MetaCubeXD Local.app`。
- 数据：`~/Library/Application Support/MetaCubeXD Local/`，目录权限 0700。
- 内核：独立下载的官方 Mihomo v1.19.32，校验 GitHub release 的 SHA-256；不引用 Sparkle.app。
- 网页/Agent、内核控制器、HTTP/SOCKS 混合代理从 21000 起寻找三个可用端口，均监听回环地址。
- DNS 测试监听 `127.0.0.1:15353`，没有更改系统 DNS。
- 查看实际端口：`node scripts/local/runtime.mjs status`。不会输出口令。

从 Finder 打开本地应用，或双击仓库内 `Start Local.command`，直接进入官方桌面界面。
系统代理开关在「控制中心 → 系统」，TUN 开关在「配置 → TUN」；菜单栏也可操作。
**默认不接管网络**，由用户在界面手动开启，不需要命令切换运行模式。
启动不会把其他客户端的代理当成本应用恢复；退出只释放本应用本次手动启用且仍指向本应用端口的 macOS 代理。
TUN 自动恢复默认关闭，后续可在官方桌面设置中主动开启。
本地应用不设置开机自启，也不注册订阅 URL 协议处理器。

`MCXD_DATA_DIR` 可指定独立数据目录。
`MCXD_PARALLEL_TEST=1`（开发命令 `start --test`）仅用于内部严格测试，会禁用系统接管能力；日常使用不需要。
没有这些本地选项的原版应用保留上游默认行为。

## 配置来源和边界

首阶段从 Sparkle **实际生成的生效配置**导入一个本地 profile：

`mihomo-home/profiles/sparkle-snapshot.yaml`

节点、策略组、规则及规则集均来自该快照；没有导入覆写脚本或远程可视化覆写。
同时复制规则集缓存和静态 Geo 数据，**没有复制运行中的 cache.db**。
手动策略选择通过新内核 API 恢复到独立缓存，不更改 Sparkle。

为并行运行调整了监听地址、端口、DNS 监听、物理出口接口，以及禁用 TUN 的相关开关；移除了可能冲突的外部控制 socket/额外监听器。
Mihomo 1.19.32 已移除的 `global-client-fingerprint` 被转为受支持协议节点的 `client-fingerprint`，已有节点级设置优先。
Agent 在启动时明确拥有控制器地址、控制密钥和混合端口；它们记录于私有 `local-session.json`，会随会话更新。
其他配置来自这个本地 profile。

当前是**静态迁移快照**，尚未迁移多订阅自动聚合、线路编辑、防回环生成和手机订阅发布。
原有规则集仍由 Mihomo 按各自周期更新。
完整的源模型与 GUI/AI 共编将在后续阶段实现；不要把这一阶段当成全部管理功能已迁移。

口令、订阅、原始节点定义、会话密钥与验证图片都只保存在上述私有目录。
不要将它加入 Git；仓库的 `.local/` 也已忽略。

## 本机命令

在仓库根目录执行：

```sh
node scripts/local/runtime.mjs start
node scripts/local/runtime.mjs status
node scripts/local/verify.mjs
node scripts/local/runtime.mjs stop
```

`verify.mjs --restore-selections` 仅恢复**独立内核**中的手动选择。
验证报告保存在私有目录的 `audit/`，输出不包含节点口令。
`audit/health-policy.json` 支持按节点名称排除已知过期节点；本机已按用户说明排除 SGP 出口。
规则筛选结果为 `COMPATIBLE` 的空策略组按原样保留，报告会提示，不伪装成已具备对应地区或内网节点。

## 用户手动切换

本次安装与验收没有切换系统代理或 TUN，Sparkle 继续运行。准备好接管后，由用户操作：

1. 在 Sparkle 中关闭系统代理、PAC 和 TUN，并关闭其自动接管选项。
2. 打开 `~/Applications/MetaCubeXD Local.app`。
3. 在「控制中心 → 系统」开启系统代理；需要接管不遵循系统代理的应用时，在「配置 → TUN」开启 TUN。
4. 首次启用 TUN 按官方流程完成 macOS 权限提示，安装官方 helper。

不需要退出重启、切换模式或执行命令。系统代理和 TUN 按需选择，日常一般先用系统代理即可。
**此次没有安装或实机验证特权 TUN 接管**；GUI 验收通过拦截写请求检验控件，不改系统网络。
需要回到 Sparkle 时，先在本地应用中关闭系统代理/TUN，再由用户重新开启 Sparkle。

## 从源码复现

需要 Apple Silicon macOS、Node.js、pnpm 与已认证的 GitHub CLI。
首次网络下载可以给对应命令设置 `HTTPS_PROXY`，不需要修改系统代理。

```sh
pnpm install --frozen-lockfile --filter @metacubexd/desktop... --filter @metacubexd/ui...
node scripts/local/install-kernel.mjs
node scripts/local/runtime.mjs prepare
pnpm --filter @metacubexd/ui generate:desktop
pnpm --filter @metacubexd/desktop copy:renderer
pnpm --filter @metacubexd/desktop build
node scripts/local/package.mjs
node scripts/local/runtime.mjs start
```

`prepare` 只用于首次导入，发现已有 profile 时拒绝覆盖。
安装脚本默认保留已有本地应用。升级时先退出应用，再显式使用 `--replace-local`；旧包保存在私有目录的 `previous-apps/`，复制失败会恢复旧包。
本地包具有独立应用 ID `app.gucvii.metacubexd.local`，沿用官方打包与 fuses hook。
本地打包配置不声明订阅 URL 协议，保持 Sparkle 的默认链接处理器。
所有构建产物忽略提交。后续开发先退出本地应用，再使用带隔离参数的官方 HMR 工作流，无须每次重新打包：

```sh
MCXD_DATA_DIR="$HOME/Library/Application Support/MetaCubeXD Local" MCXD_PARALLEL_TEST=1 pnpm dev:desktop
```

工具链沿用 TypeScript 7 的 `tsc`，为 ESLint 等依赖编译器 API 的工具提供 TypeScript 6 兼容包；这是 [TypeScript 官方的并行安装方案](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)。

## 跟随上游

`origin` 指向个人 fork，`upstream` 指向 MetaCubeX/metacubexd。
本地功能集中在 `local/independent-runtime` 分支，基线为上游 v1.273.1。
首次克隆为浅克隆，必要时先 `git fetch --unshallow upstream` 补齐历史。
上游更新先合并到集成分支，完成下面的检查后再升级应用，不自动替换正在运行的版本：

```sh
pnpm --filter @metacubexd/desktop typecheck
pnpm --filter @metacubexd/desktop test
pnpm --filter @metacubexd/agent test
```

还应实际验证：默认手动接管状态下的启动/退出、系统代理和 TUN 开关、主用节点、混合代理、规则集、WebSocket、配置版本，以及 Sparkle 和系统网络状态未被修改。
