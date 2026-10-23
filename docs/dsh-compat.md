# 与 DSH 版本的兼容性

插件对宿主的依赖只有两处（`lib/index.js`）：`@deepseek-ai/dsh-mcp-client`（挂载 MCP 服务器）
与 `@deepseek-ai/schemastery`（配置 schema）。只要这两处的 API 面不变，插件在 DSH 的新版本上就能继续工作；
面板侧（`lib/client.js`）只依赖浏览器全局与 `dsh.client.inject` 注入的槽位。

## 一键检查

```bash
node scripts/check-dsh-version.mjs          # 人类可读
node scripts/check-dsh-version.mjs --json   # 给自动化用
```

| 退出码 | verdict | 含义 | 该做什么 |
| --- | --- | --- | --- |
| **0** | `compatible` | 已安装的就是最新，或声明范围已经覆盖 | 什么都不做 |
| **2** | `widen-ranges` / `range-ok-but-untested` | 有更新的 DSH，但只需放宽 `dependencies` 范围并回归 | 放宽范围 → 跑 `pnpm test` → 打补丁版本 |
| **3** | 保留给「契约变了」 | 需要人工评估 | 不要自动改代码，把 diff 汇总给人看 |
| **1** | `check-failed` | 离线、读不到 `runtime.json` 等 | 只报告，不动代码 |

数据来源：
- 已安装版本：`~/.dsh/dsh-runtimes/*/runtime.json` 的 `desktopVersion`（连同 node 版本一起报告）；
- 最新版本：优先读官方更新源 `download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`，
  读不到再退回 npm `@deepseek-ai/dsh-mcp-client` 的 `dist-tags`。
- `@deepseek-ai/schemastery` 是独立的 3.x 库，不随 DSH 版本走，所以只做「是否被 import」的核对。

## 每周自动检查（DSH 官方定时任务）

在 DSH 侧边栏 **自动化任务** 里新建一个 **每周、周六 09:00**、绑定本会话的任务，
把下面的提示词整段粘进去（这是本仓库约定好的流程，脚本就位后无需再改）：

```text
每周六 09:00：检查 DSH 是否有新版本，并为 dsh-stm32-toolchain 做兼容性更新。

步骤：
1. cd 到插件仓库，git pull --ff-only；若工作区不干净先报告并停止。
2. 运行 node scripts/check-dsh-version.mjs --json，按退出码分流：
   - 0（compatible）：只报告，不改代码、不打 tag。
   - 2（widen-ranges / range-ok-but-untested）：
     a. 把 package.json 里 @deepseek-ai/dsh-mcp-client 的范围补上最新版本（保留旧范围，用 || 追加）；
     b. 在 CHANGELOG 的 [Unreleased] 里记一条「兼容 DSH <新版本>」；
     c. 从 npm 下载新版本 @deepseek-ai/dsh-mcp-client 的 tarball，核对我们用到的导出
        （mountServer/Config 字段等）是否仍存在，把结论写进提交信息；
     d. pnpm test 必须全绿（21 个测试串），node --check lib/index.js lib/bridge.mjs lib/client.js 通过；
     e. pnpm pack 确认产物仍只有约定文件（lib、firmware 草图、docs、两个 README、CHANGELOG、LICENSE）；
     f. 升一个补丁版本（例如 0.2.1 → 0.2.2），提交、git push origin main、再 git push origin v<版本>；
        CI 会跑 check + publish（OIDC），完成后用 npm view 确认 latest 就是新版本。
   - 3 或 1：不改代码，把原因和关键 diff 汇总到会话里给我看。

硬性要求：
- 验收必须包含真实功能验证：面板能渲染（node test/client.test.mjs）、桥接能起（test/bridge.test.mjs）、
  烧录协议单测（test/erase/sector-erase/write-memory）全过；有条件时向我要真机烧录确认。
- 发布失败（403/2FA/冻结）不重试，回退本地 tag 并写 docs/release-pending.md 记录待补发版本。
- 除这个例行流程外，不要主动打 tag；平时由我自己打 tag。
```

> 注意：DSH 的会话定时任务只在 DSH 运行且本会话可用时触发，停机期间错过的那次不会补跑。
> 如果希望「电脑没开也照查」，需要用 GitHub Actions 的 cron（只检测 + 开 issue，不发版）。

## 手动验证一次（不等待定时任务）

```bash
node scripts/check-dsh-version.mjs
pnpm test
```
