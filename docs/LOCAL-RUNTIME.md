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

从 Finder 打开本地应用，或双击仓库内 `Start Local.command`，默认都是**并行测试模式**。
应用使用独立数据、缓存和二进制，禁止更改系统代理/PAC，隐藏系统代理与 TUN 控制，跳过全局快捷键和订阅 URL 协议注册。
退出也不会清理其他客户端的系统代理。
本地应用不设置开机自启。

`MCXD_DATA_DIR` 可指定独立数据目录；本地构建或指定独立目录时默认进入测试模式。
只有显式设置 `MCXD_PARALLEL_TEST=0` 才恢复官方系统控制能力。
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

本阶段没有切换系统代理或 TUN。准备好接管后，由用户操作：

1. 在 Sparkle 中关闭系统代理、PAC 和 TUN，并关闭其自动接管选项。
2. 退出本地测试应用，或运行 `node scripts/local/runtime.mjs stop`。
3. 运行 `node scripts/local/runtime.mjs start --normal`。
4. 在本地应用中手动开启系统代理；需要 TUN 时，再手动开启并完成 macOS 权限提示。

`start --normal` 会检查系统代理/PAC 和可访问的 Sparkle TUN 状态；仍在接管时拒绝启动，不替用户关闭 Sparkle。
正常模式的 TUN 使用官方 helper；**此次没有安装或验证特权 TUN 接管**。
从 Finder 重新启动仍默认测试模式，这一阶段不会持久化自动接管。

需要回到 Sparkle 时，先在正常模式本地应用中关闭系统代理/TUN并退出，再由用户重新开启 Sparkle。

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

还应实际验证：并行模式的启动/退出、主用节点、混合代理、规则集、WebSocket、配置版本，以及 Sparkle 和系统网络状态未被修改。
