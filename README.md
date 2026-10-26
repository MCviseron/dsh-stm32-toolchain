# dsh-stm32-toolchain

把 **Keil + STM32CubeMX + 串口终端 + 烧录器** 收进一个 DSH 主页面板、一整套 Agent 工具的 DeepSeek Harness（DSH）插件 —— 还包括**不插线的 Wi-Fi 烧录**。

- 用你已经授权的 Keil 命令行（`UV4 -b`）**无界面编译**，拿到结构化诊断而不是一屏日志。
- 三种烧录方式：工程自带的 ST-Link（`UV4 -f`）、USB-TTL 走 STM32 系统 bootloader（AN3155）、**同一套 bootloader 经 ESP 桥接走 Wi-Fi**。
- 编译 / 烧录 / 串口在**一个实时日志流**里；点一条诊断直接在 VS Code 跳到 file:line。
- 全部能力同时以 `mcp__stm32__*` 工具暴露，AI 能自己编译、烧录、读日志。

[English](README.en.md)

## 无线烧录（Wi-Fi）支持矩阵

| 桥接板 | Flash | 流式 | 块级 ACK | 全量缓存 |
|---|---|---|---|---|
| ESP-01S | 1 MB | ✅ | ⛔ | ⛔ |
| ESP-12E / NodeMCU | 4 MB | ✅ | ✅ | ✅ |
| ESP32 DevKit | 4 MB | ✅ | ✅ | ✅ |

全量缓存（镜像先存 ESP 再自烧）上限按板型：ESP32 DevKit 1.4 MB、ESP-12E 896 KB；
超出时面板直接拒绝并提示改用流式或块级 ACK。STM32 的 ROM 引导程序要求 **8E1 偶校验**，
固件按阶段切换（引导程序 8E1 / 用户程序 8N1）。

## 环境要求

| 组件 | 说明 |
| --- | --- |
| DSH desktop >= 0.2 | 插件宿主 |
| Keil MDK (uVision 5) | `UV4.exe`，用你自己的许可证，和 GUI 行为一致 |
| Python 3 + pyserial | 串口监视与串口烧录（`pip install pyserial`） |
| STM32CubeMX | 可选：`stm32_cube_gen`、面板的「打开 .ioc」「生成代码」 |
| arduino-cli + ESP8266 核心 | 可选：只有要编译 ESP 桥接固件时才需要 |
| ESP-12E / NodeMCU（推荐）或 ESP-01S | 可选：Wi-Fi 烧录与无线串口 |
| ST-Link | 可选：`swd` 传输 |

## 安装

从 npm（推荐，插件已发布为 `dsh-stm32-toolchain`）：

```bash
# 在你的 DSH profile 里（例如 ~/.dsh/profiles/desktop）
pnpm add dsh-stm32-toolchain
```

从源码（改代码时用，构建产物 `lib/` 已随仓库提交，克隆即用）：

```bash
pnpm add link:C:/Users/<你>/.dsh/stm32-toolchain-plugin   # 指向仓库的联接
# 或直接用本地路径：pnpm add link:D:/Program/DSH-Plugin-Class/dsh-stm32-toolchain
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: stm32-toolchain
  name: dsh-stm32-toolchain
  config:
    enabled: true
    project: 'D:/work/firmware/MDK-ARM/Project.uvprojx'
    transport: swd
```

在 `package.json` 的 `dsh.profile.bundles` 里引用这个包，重启 DSH：侧边栏出现 **STM32 总管**，工具列表出现 `mcp__stm32__*`。

## 设置（`Config`）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | true | 挂载/卸载整个插件 |
| `announceToAgent` | true | 把 STM32 工作规范注入系统提示词 |
| `project` | '' | 默认 `.uvprojx`；芯片型号取自它的 `<Device>` |
| `uv4Path` / `cubeMxPath` | '' | 留空自动探测 |
| `pythonPath` | '' | 带 pyserial 的 Python；留空自动探测 |
| `httpPort` | 39021 | 桥接守护进程的回环端口（面板 + SSE） |
| `toolCallTimeoutMs` | 300000 | 单次工具超时 |
| `cardOrder` | `chip,transport,port,firmware,cube,build,flash,lease,logs` | 卡片顺序（每行 5 张） |
| `logFontSize` / `logLineHeight` / `logMaxLines` | 12 / 1.5 / 400 | 日志文字 |
| `logWrap` / `logTimestamps` | true / false | 自动换行 / 每行带时间 |
| `logColorBuild` / `Flash` / `Serial` / `Sys` | '' | 各通道文字颜色，留空用主题色 |
| `logBgGradient` / `logBgFrom` / `logBgTo` | false / #0d1117 / #161b22 | 日志区渐变背景 |

**烧录参数不在设置页**，而在面板的「烧录设置」里 —— 它们属于"眼前这块板"。两侧都写进
`<plugin>/.state.json`，永不覆盖 profile 配置。

## 面板

- **卡片每行 5 张**：芯片、传输、端口、固件、CubeMX / 编译、烧录、占用、日志。
- **操作栏**：编译、烧录、一键编译 + 烧录（+ 看日志）、打开串口、HEX、无线串口、
  打开 .ioc、生成代码、选择 .ioc…、VSCode、清空日志、烧录设置。
- **日志流**：全部 / 编译 / 烧录 / 串口 / 系统 五个标签 + 过滤 + 跟随；串口标签同时是发送框，
  发出的行会回显（「显示发送」开关）。
- **工程卡片**：选择文件夹… / 扫描工程 / 使用此路径 / **最近工程**（最近十个，最新在前，
  已删除的标 ✗）。
- **环境卡片**：8 项检查并给出修复建议 —— Keil、许可证、CubeMX、Python+pyserial、串口设备、
  ESP 桥接（控制端口 PING）、arduino-cli + ESP8266 核心、当前工程。全绿时收起，有失败项自动展开。
- **诊断**：每条编译错误/警告一行，点击跳到 VS Code。
- 状态只在一个地方显示：标题旁的状态灯和它右边的文字。

## Wi-Fi 烧录

| 组成 | 作用 |
| --- | --- |
| 固件（`firmware/esp01s`） | 连接你的 Wi-Fi（失败则开配网热点），提供控制端口 3333 与裸串口管道 3334，驱动 BOOT0/NRST |
| 面板 | 烧录设置 → Wi-Fi 名称 / 密码 → 生成固件（把凭据编进固件并编译）→ 烧到 ESP（USB-TTL） |
| Agent | `stm32_esp_firmware` 的 `build` / `flash` / `status` / `detect` / `discover` |

接线（ESP-12E / NodeMCU，推荐）：

| ESP | STM32 | 用途 |
| --- | --- | --- |
| D2（GPIO4） | BOOT0 | 启动模式 |
| D1（GPIO5） | NRST | 复位 |
| TX | PA10 | USART1_RX |
| RX | PA9 | USART1_TX |
| GND | GND | 共地 |

两根控制线接好后，Wi-Fi 烧录**不需要按任何键**：桥接拉高 BOOT0、给 NRST 一个脉冲、AN3155 握手
在管道上跑完，随后 BOOT0 释放并复位进入新程序。

热点会重新分配地址，面板的「**自动探测 ESP**」会扫描本网段中在 3333 端口返回 `+STATUS` 的主机并自动填入。

同一条管道也当**无线串口**用：勾上「无线串口」，串口监视器读的是 ESP 的 socket 而不是 COM 口。
管道同时只服务一个客户端，所以烧录前会自动关闭监视器。

Wi-Fi 凭据存在 `.state.json` 里，不会发到浏览器；生成的 `.bin` 含明文密码，只留在被 gitignore 的
`firmware/esp01s/build/` 内。

### 传输方式

| transport | 路径 | 前提 |
| --- | --- | --- |
| `swd` | ST-Link，`UV4 -f` | 接线到板子的调试器 |
| `uart` | USB-TTL 上的 AN3155 | 能碰到 BOOT0/NRST，有 COM 口 |
| `wifi` | 经 ESP 桥接的 AN3155 | ESP 固件，BOOT0/NRST 接到 ESP |

`lib/wifi.mjs` 满足与串口管道相同的字节契约，所以 `lib/bootloader.mjs`（AN3155：同步、GetID、
按扇区擦除、三次握手写入并补齐 4 字节、GO）**一行不改**地复用。

## 工具

| 工具 | 作用 |
| --- | --- |
| `stm32_doctor` | Keil 路径/版本/许可证、CubeMX、pyserial、COM 口、芯片表 |
| `stm32_status` | 阶段、芯片、传输、端口、固件大小、上次编译/烧录 |
| `stm32_project` | Device → 芯片系列、bootloader 引脚、输出目录 |
| `stm32_build` | `UV4 -b` 无界面编译 + 结构化诊断 |
| `stm32_flash` | `swd` / `uart` / `wifi` |
| `stm32_deploy` | 先编译再烧录；`watch:<ms>` 返回烧录后的串口输出 |
| `stm32_checkout` | 文件夹 → `.uvprojx` → 芯片 → 传输/端口，一次调用 |
| `stm32_claim` | 板级独占租约 |
| `stm32_serial` | 串口监视器 open/close/write/tail |
| `stm32_logs` | 环形日志查询（通道、正则、since） |
| `stm32_chips` / `stm32_ports` | 芯片表 / 串口列表 |
| `stm32_open_vscode` | 打开 `file:line` |
| `stm32_cube_gen` | 从 `.ioc` 无界面重生成代码 |
| `stm32_esp_firmware` | 编译 / 烧写 / 状态 / 检测 / 探测 ESP 桥接 |

## 并发：两个会话，一块板

板子是独占资源，一个插件实例 = 一个桥接进程 = 所有会话共享。

| 层次 | 机制 |
| --- | --- |
| 同进程 | 所有写操作走同一个任务队列，编译/烧录不会重叠 |
| 无令牌调用 | 面板与未 claim 的 Agent 共享一个隐式租约 |
| 两个持有者 | 租约：`BOARD_BUSY` 带上持有者与时长；TTL 180 秒，调用时续期，任务运行中每 15 秒续期 |
| 两个 DSH 实例 | `.lock.json`（pid + 类型 + 5 分钟 TTL）拒绝第二个实例 |
| 串口 | Windows 的 COM 口本身独占，报错是"端口被占用"而不是超时 |

可调：`DSH_STM32_LEASE_TTL`（毫秒，默认 180000）、`DSH_STM32_LEASE_HEARTBEAT`（毫秒，默认 15000）。

## 增加新芯片

`lib/chips.json` 里是系列默认值（bootloader 串口引脚、最高波特率、擦除方式、页大小）与逐型号条目。
加一条、重启 DSH 即可，无需改代码。未知型号回退到 USART1/115200，面板会明确提示。

## 开发

```bash
pnpm install
pnpm test        # 单元 + 契约 + 桥接端到端
```

目录：`lib/runtime.mjs`（Node 选择）、`lib/core.mjs`（工程/Keil/芯片逻辑）、
`lib/serial.mjs` + `lib/serial-worker.py`（pyserial 字节管道）、`lib/bootloader.mjs`（AN3155）、
`lib/wifi.mjs`（ESP 控制行 + TCP 管道）、`lib/wifi-fw.mjs`（固件生成）、
`lib/bridge.mjs`（状态机 + HTTP/SSE + MCP）、`lib/index.js`（DSH 宿主侧）、
`lib/client.js`（主页面板）。

## 许可证

MIT
