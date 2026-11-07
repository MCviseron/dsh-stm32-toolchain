# 待发布：v0.2.7

- 版本：**0.2.7**
- 状态：**本地已提交，未推送、未打 tag、未发布到 npm**
- 时间：2026-11-07（每周例行检查）
- 原因：执行 `git push origin main` 时 GitHub 不可达 ——
  `fatal: unable to access 'https://github.com/MCviseron/dsh-stm32-toolchain.git/': Recv failure: Connection was reset`
  （本地网络/VPN 断开，非账号权限问题）

## 本次内容

1. 兼容 DSH **0.2.2-rc.1**：
   - `@deepseek-ai/dsh-mcp-client` 范围追加 `|| ^0.2.2-rc.1`；
   - 已核对 rc.1 的导出（`Config/apply/createMcpToolDefinition/inject/name`）与配置字段
     （`serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError/reconnect`）均在。
2. 修复：启动时回读**全部**已保存的面板设置（板型、链路模式等不再回默认）。
3. 修复：手机页不再从历史状态恢复旧令牌（地址回到 `/m`，无需 `?t=`）。

## 验收

| 项 | 结果 |
|---|---|
| `node --check` lib/index.js / bridge.mjs / client.js | 通过 |
| `pnpm test` | 全绿（suite=0） |
| client / bridge / erase / sector-erase / write-memory | 全 exit=0 |
| `pnpm pack` | 28 个文件，140.6 KB，顶层符合约定 |

## 网络恢复后要做的两步

```bash
git push origin main
git tag -a v0.2.7 -m "v0.2.7：兼容 DSH 0.2.2-rc.1 + 设置持久化修复"
git push origin v0.2.7
```

CI（check + publish，OIDC）跑完后用 `npm view dsh-stm32-toolchain version` 确认 latest 为 0.2.7。
