# 更新日志

本文件记录项目的所有重要变更。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件曾在开发中被误覆盖，0.1.0 的内容是依据当时的开发记录重建的：条目真实，
> 但原始措辞已不可考。

## [Unreleased]

### 新增

- **链路模式可选（三种都已实现）**：烧录设置里新增「链路模式」——流式（默认）/ 块级 ACK / 全量缓存。选择写进生成的 ESP 固件（`LINK_MODE`），固件在 `+READY`/`+STATUS` 里回报 `link=`。
  - 块级 ACK：ESP 自己完成写内存三段握手并本地重试，每块只占一次 TCP 往返；
  - 全量缓存：镜像先落到 ESP 文件系统（`#I/#S/#F`），再由 ESP 复位、同步、擦除（AN3155 `N=扇区数−1`）、按 256 字节写、GO，进度用 `+F` 回报；断网等于什么都没烧。
  - 三种板型（ESP-12E / ESP-01S / ESP32）× 三种链路共 **9 种组合全部编译通过**，详见 `docs/LINK-MODES.md`。
- 工程卡片新增 **「以 Keil 打开」**：用 UV4 图形界面打开当前工程（编译/烧录仍走 headless）。
- **打开 .ioc 变成下拉**：可选「打开当前工程的 .ioc」或「只打开 CubeMX（不打开工程）」。

### 变更

- 一键按钮改名 **「一键下载」**（编译 + 烧录），是否顺带抓 5 秒串口日志写在悬浮说明里，省出工具栏宽度。
- 压测包放大：板端回环缓冲 4 KB → **16 KB**，工具上限提到 16384 字节，面板「压测」按钮改为发 **4 KB**。


## [0.2.3] - 2026-10-24

### 新增

- **串口压测**：`stm32_serial_stress {bytes}`（面板「环境 → 压测」）发伪随机数据让板子原样回环，报告丢失字节、错字节与首个差异位置；板端协议为 `LT <n>`（回 `+LT <n>` 后进入二进制回显，2 秒无新字节自动退出），压测结论由面板回传一行 `R ...` 显示在 ST7735 上。
- **面板 → 会话投递修好**：宿主没有 `sessions.prompt`，改为 App 自己的做法 `agents.get(id).followup({id, role:'user', content, source:{kind:'user'}})`；发送成功后自动跳到该会话。
- **来源标记**：面板转发的消息带 `[来自stm32总管]` 前缀（幂等），接收会话可据此区分来源。
- **新会话提示词**补齐压测工具、面板「压测」入口与来源前缀的含义。

### 修复

- ESP 管道改用优雅 FIN 关闭，避免 `pipe=on` 僵尸客户端吞掉下一次写入。
- 管道已断开时写入立刻报「ESP 管道已断开（ESP 重启或网络中断）」，不再抛底层 `ERR_STREAM_DESTROYED`。

## [0.2.2] - 2026-10-24

### 新增

- **CI 发布**：`.github/workflows/publish.yml`（推 `v*` tag → 测试 → 校验 tag 与版本一致 → `npm publish --provenance`，OIDC 免令牌）与 `check.yml`（推 main / PR 跑语法与测试）。
- **兼容性巡检**：`scripts/check-dsh-version.mjs` + `docs/dsh-compat.md`，一条命令读出已安装的 DSH 版本、更新源最新版本，以及 `dsh-mcp-client` 的声明范围是否覆盖（退出码 0/2/3 供定时任务分流）。
- **串口监视波特率可选**：下拉含「自动检测」（逐个试常见速率、按可读字符比例挑最优）与 9600~921600 手选，与烧录用独立设置。
- **ESP↔STM32 串口速率可选**（默认 115200）：生成固件时写入 `wifi_creds.h` 的 `PIPE_BAUD`。
- **进程锁卡片**：显示是否有**别的 DSH 实例 / 桥接进程**正占用板子（pid、操作、持续时长），补满第二行。
- 无线串口断开时会明确报「无线串口已断开（ESP 重启或网络中断）」，不再假装仍连着。

### 修复

- **占用卡片从不点亮**：面板按 `lease.expiresAt` 算倒计时，而桥接只发 `expiresInSeconds` → 永远算出 0 → 一直显示「空闲」。
- **串口回显谎报成功**：原来先写日志再发送，管道已死（`ERR_STREAM_DESTROYED`）时也会显示 `→ 文字`；现在只在发送成功后回显，失败显示 `→ 发送失败：原因` 并关闭监视器。
- **中文乱码**：无线串口按 latin1 逐块解码，CJK 变成 `ï¼？`；改为保留字节、按 LF 切行后按 UTF-8 解码。
- **无线串口打开时静默失败**：勾「无线串口」后点「打开串口」会用旧 IP 直接报错；现在先连、失败即自动探测、找到后写回设置，并在状态灯旁/日志里逐步说明；完全找不到时给出可读原因。
- 写内存每块 256 → **128 字节**，每块失败**重试至多 4 次**（每次先重新同步），解决「写到 8 KB 就整次失败」。
- 握手失败时会**重新拉高 BOOT0 并复位**（最多 3 次）并记录 ESP 的 `boot0/nrst/rx/tx`，区分「字节没到芯片」和「芯片回了垃圾」。
- ESP 固件：`BOOTLOADER` 改为 **BOOT0 先稳 30 ms → 复位低 200 ms → 释放后 50 ms**，并**回读 BOOT0** 一起回报（线没接好会显示 `boot0=0`）。
- 自动探测提速：单地址超时 350 → 150 ms、并发 64 → 128、首次连接 8 → 2.5 秒，一个网段约 3 秒扫完。

### 变更

- 操作栏按用途分组（编译烧录 / 串口 / CubeMX / 工具），组间竖线分隔；「清空日志」移入日志导航栏。
- 两个波特率改名以消除歧义：操作栏为「本地串口 N/自动」，烧录设置为「ESP↔STM32 串口速率」。
- 安装说明补充 `pnpm add dsh-stm32-toolchain`（npm 渠道），源码联接安装保留。

## [0.2.1] - 2026-10-24

### 变更

- 更新日志改为中文单份维护（`CHANGELOG.md`），英文版不再单独存在；`README.en.md` 指向它。
- 合并了 0.1.0 段落里重复的三个「新增」块。
- 补齐 `package.json` 的 `repository` / `homepage` / `bugs`（指向 `MCviseron/dsh-stm32-toolchain`）与 `publishConfig`。

## [0.2.0] - 2026-10-24

### 新增

- **Wi-Fi 烧录**：通过 ESP 桥接跑 AN3155（`transport: wifi`），全自动 —— 桥接自己拉高 BOOT0、
  给 NRST 一个脉冲，两根线接牢后**不需要按任何键**。
- ESP 固件默认改为 **ESP-12E / NodeMCU** 载板（D2 = BOOT0、D1 = NRST，两者都不是启动脚）；
  ESP-01S 仍可用 `BOARD_NODEMCU=0` 编译，面板新增板型选择。
- **无线串口**：面板的串口监视器可以接 ESP 的管道而不是 COM 口（勾「无线串口」）。
- **ESP 自动探测**（自动探测 ESP）：扫描本网段中在 3333 端口返回 `+STATUS` 的主机并自动填入地址。
- **环境清单**（右侧栏）：Keil、许可证、CubeMX、Python+pyserial、串口设备、ESP 桥接、arduino-cli
  与当前工程，共 8 项，每项给出修复建议；全绿时收起，有失败项自动展开。
- **CubeMX 卡片与操作栏**：「打开 .ioc」用图形界面打开工程对应的 `.ioc`，「生成代码」无界面重生成，
  按钮会变成「生成中…」，进度与结果由状态灯旁的文字和「系统」日志汇报。
- **最近工程**下拉：最近打开过的十个工程，最新在前，已删除的标 ✗。
- **快速上手弹窗**（标题栏「?」）：五步流程、ESP-12E 接线表、常见故障；插件提示词也补上了
  Wi-Fi 流程，新会话开局就知道怎么用。
- 串口 **HEX** 视图与「**显示发送**」开关；发出的行会以 `→` 回显到「串口」频道。
- 契约测试：`test/ui-contract.test.mjs`、`test/env-check.test.mjs`、`test/sector-erase.test.mjs`、
  `test/write-memory.test.mjs`、`test/discover.test.mjs`。

### 修复

- AN3155 按扇区擦除的计数应为 **N = 扇区数 − 1**（直接发扇区数会让 bootloader 继续等下一个扇区号，
  表现为静默 30 秒超时）；并且只擦镜像覆盖到的扇区。
- 写内存改为三次握手（命令 / 地址 / 数据各自等 ACK），数据补齐到 4 字节，符合 F4 bootloader 要求。
- 收到 NAK 后 bootloader 会退回"等待 0x7F"状态：命令现在会先重新同步再重试一次，而不是静默失败。
- `Get (0x00)` 在会拒答的芯片上改为可选（用 `GetID` 识别芯片）。
- 面板布局：卡片改为每行 5 张；日志区按实测可用高度铺满（不再用 `100vh` 估算）；
  环境清单可折叠，不再挤压「诊断」。
- `Card` 现在会渲染 children，卡片内的按钮不再被丢弃。
- 串口回显与「显示发送」开关真正生效（此前一次多行替换因换行符不匹配而静默失效）。

## [0.1.0] - 2026-10-23

### 新增

- DSH 宿主插件（`dsh-stm32-toolchain`）：以 MCP stdio 启动 `lib/bridge.mjs`，并把它的
  回环 HTTP/SSE 接口代理给浏览器端。
- 14 个 Agent 工具：doctor、status、project、build、flash、deploy、checkout、claim、serial、
  logs、chips、ports、open_vscode、cube_gen。
- 无界面 Keil 编译（`UV4 -b`）并返回结构化诊断；ST-Link 下载（`UV4 -f`）；
  任意串口管道上的 AN3155 系统 bootloader 烧录。
- 主页面板：两行状态卡、操作栏、SSE 实时日志（通道标签）、诊断列表、工程选择、串口发送框。
- 设置卡片：四类分组（常规 / 工具链 / 日志文字 / 日志颜色）、细线分隔行、官方 `Switch` 与
  `Menu` 组件、单列 1–8 拖拽的状态卡排序。
- 日志文字选项（字号、行高、行数、换行、时间戳）、各通道颜色、可选渐变背景与实时预览。
- 板级租约：持有者标签、TTL 180 秒、任务运行中每 15 秒心跳、强制释放、跨进程 `.lock.json`；
  `/state` 汇报持有者与时长。
- 会话绑定：`conversation.session.header.actions` 里的控件（和「打开 MATLAB」同一位置），
  三种状态——未绑定 / 绑定本会话 / 绑定在别处，状态存于 `.state.json`；面板通过宿主
  `POST /ask` 发送提示。
- 测试：runtime、settings、client、client-primitives、jump、vscode、lease、presentation、
  paths、no-project、smoke、bridge。
- **ESP-01S Wi-Fi 桥接固件**（`firmware/esp01s/`）：两个 TCP 服务（3333 控制行、3334 裸串口管道）、
  BOOT0/NRST 驱动（`BOOTLOADER`/`RUN`）、EEPROM 凭据存储与配网 AP + 强制门户，
  凭据优先级为 EEPROM → 编译内置 → 配网。
- **生成固件流程**：面板的 Wi-Fi 输入交给 `gen-firmware`，它把 `wifi_creds.h` 写进临时 sketch 副本
  再用 Arduino ESP8266 核心编译（命令行上不出现凭据），随后 `flash-esp` 通过 USB-TTL 写入 ESP。
  对 Agent 暴露为 `stm32_esp_firmware`；Wi-Fi 密码始终留在桥接进程内（`/state` 只报 `hasPass`）。
- **`transport: wifi`**：`lib/wifi.mjs` 用 ESP 桥接实现了 AN3155 的字节管道契约（3333 控制、
  3334 裸串口），`flashImage` 原样复用：BOOTLOADER（BOOT0 高 + 复位）→ 握手 → 分块写入 →
  RUN（BOOT0 低 + 复位）。

### 变更

- 设置尽可能即时生效：表现类走客户端 store，工具链路径用 `set-tools` 推送，扫描根目录随每次扫描发送；
  只有「启用插件 / 注入工作规范 / 桥接端口 / 单次工具超时」需要重启宿主，界面里也写明了。
- 选目录使用应用原生选择器，失败回退到 Vista+ 的 `IFileOpenDialog`，最后才是 `FolderBrowserDialog`。
- 扫描工程会看当前工程的父目录加桌面/文档/下载，可用 `searchRoots` 扩展，并汇报扫描范围。
- 清空日志改为菜单：清空当前日志（当前标签，全部标签则清空所有）与清空所有日志。
- `transport: swd | uart`；ESP 相关字段为 0.2.0 的 Wi-Fi 传输预留。

### 修复

- 设置不生效：DSH 把 `volatile` 配置字段作为实时引用传入，导致所有值回落到默认；`apply()` 现在会解包。
- 陈旧的展示层覆盖了已保存的值；移除后宿主配置为唯一权威，客户端 store 在保存时应用。
- 保存会擦掉表单不再持有的值；`buildOps`/`mergeForm` 现在只写表单自己的字段。
- 被拒绝的操作（例如没选工程）会留下板级占用：工程校验现在提前到租约之前，任务失败时释放隐式租约。
- 「释放」看起来无效（没有状态推送、面板又合并了动作结果）。
- 第二个面板动作被误判为 BOARD_BUSY；无令牌调用者现在共享同一个隐式租约。
- 桥接重启后日志行键重复；现在按进程实例打标，新实例会重置日志流。
- PowerShell 对话框返回的中文路径乱码（`D:\ʵ���Ҿ���`）导致扫描一无所获；
  路径现在以 UTF-8 文件传递，`repairPath` 可还原 latin1 误解码。
- 打开一条诊断会把文件清空：构建日志里是相对路径，`code -g` 按 VS Code 的工作目录解析；
  现在按工程目录解析，文件不存在则拒绝打开；VSCode 按钮打开的是工程**根目录**（从 MDK-ARM/Objects 上溯）。
- 「交给 AI」因 `Cannot destructure property 'source' of 'options'` 崩溃；改为绑定，不再创建会话。

### 已知限制

- 无线 SWD 调试需要 ESP32-S3 跑 CMSIS-DAP over TCP。
- 未暴露页级擦除、选项字节与读保护操作。
