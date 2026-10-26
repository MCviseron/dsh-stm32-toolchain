# 接线全集（ESP 桥接板 ↔ STM32F407）

> 本文按固件里**实际编译生效的引脚**整理（`firmware/esp01s/esp01s.ino`）。
> 换线后务必用 `PINS` / `PULL` / `IN` 命令复测，别靠记忆。

## 1. 必须要接的 5 根线

| # | 信号 | ESP 侧 | STM32 侧 | 说明 |
|---|---|---|---|---|
| 1 | STM32 TX → ESP RX | ESP 的 RX | **PA9（USART1_TX）** | STM32 的输出 |
| 2 | STM32 RX ← ESP TX | ESP 的 TX | **PA10（USART1_RX）** | STM32 的输入 |
| 3 | GND | GND | GND | **共地，最容易松的一根** |
| 4 | BOOT0 | 见下表 | **BOOT0**（STM32 的 BOOT0 引脚） | 高电平 = 进系统引导程序 |
| 5 | NRST | 见下表 | **NRST** | 低电平 = 复位 |

电源：ESP 自身按板型供电（ESP32/ESP-12E 用 USB 5 V；ESP-01S 需 3.3 V、峰值 ≥ 300 mA）。
ESP-01S 用 STM32 板上的 3.3 V LDO 供电**常常带不动**，会导致反复重启。

## 2. 各板型的引脚分配（固件默认值）

### ESP32 DevKit（当前实测使用的板子）

| 功能 | ESP32 引脚 | 丝印 | 接 STM32 |
|---|---|---|---|
| 与 STM32 串口 RX | **GPIO16** | RX2 | ← PA9 |
| 与 STM32 串口 TX | **GPIO17** | TX2 | → PA10 |
| BOOT0 驱动 | **GPIO4** | D4 | → BOOT0 |
| NRST 驱动 | **GPIO5** | D5 | → NRST |
| USB 调试口 | GPIO1/GPIO3 | TX0/RX0 | 不接（115200 8N1） |

⚠ 实测注意：这块 30-pin 板上丝印 D25/D26 的两个孔**并不通到 GPIO25/26**，驱动不了任何东西，
所以 BOOT0/NRST 改用了 D4/D5。

### ESP-12E / NodeMCU（推荐作为桥接板）

| 功能 | ESP8266 引脚 | 丝印 | 接 STM32 |
|---|---|---|---|
| 串口 RX | GPIO3 | RX | ← PA9 |
| 串口 TX | GPIO1 | TX | → PA10 |
| BOOT0 驱动 | **GPIO4** | D2 | → BOOT0 |
| NRST 驱动 | **GPIO5** | D1 | → NRST |

D1/D2 不带启动 strap，用来驱动 STM32 不会把 ESP 自己带进下载模式，所以这块板最省心。

### ESP-01S（只支持流式）

| 功能 | 引脚 | 接 STM32 |
|---|---|---|
| 串口 RX | GPIO3 | ← PA9 |
| 串口 TX | GPIO1 | → PA10 |
| BOOT0 驱动 | **GPIO2** | → BOOT0 |
| NRST 驱动 | **GPIO0** | → NRST（**建议串二极管**，见下） |

⚠ GPIO0 同时是 ESP 自己的下载 strap：上电瞬间 STM32 把 NRST 拉低会连带把 GPIO0 拉低，
ESP 就会静默进入 UART 下载模式（没有 AP、没有任何输出）。两种防御：

1. **硬件**：NRST →（阳极）二极管（阴极）→ GPIO0，并在 GPIO0 加 10 kΩ 上拉，
   让 STM32 只能把 GPIO0 拉低而不能反向拖住；
2. **固件**：运行起来后会主动把 BOOT0 拉低并脉冲 NRST，让 STM32 重新按正确模式启动。

## 3. 串口参数（关键）

| 对象 | 参数 | 原因 |
|---|---|---|
| STM32 系统引导程序（AN3155） | **115200 8E1（偶校验）** | 8N1 时「1 的个数为偶数」的字节会被静默丢弃（`0x44`/`0xBB`/`0xCE`），擦除与写内存必失败 |
| 用户程序（Flash 里的应用） | **115200 8N1** | 你自己的 `main.c` 用的是普通 8N1 |

固件按阶段自动切换：收到 `BOOTLOADER` → 8E1；收到 `RUN` → 8N1。
面板的「链路模式」与「管道波特率」都在设置里，重新生成固件才生效。

## 4. 端口（Wi-Fi）

| 端口 | 用途 |
|---|---|
| TCP **3333** | 行式控制：`PING`/`STATUS`/`BOOT`/`NRST`/`PULSE`/`BOOTLOADER`/`RUN`/`PINS`/`PULL`/`IN`/`PIN`/`PINSET`/`REBOOT` |
| TCP **3334** | 原始字节管道：主机与 STM32 之间的双向数据（流式/块级/全量缓存） |

## 5. 上电后自检（面板里也能点）

```
PINS              → +PINS boot0=0 nrst=1 rx2=1 tx2=1
                     rx2/tx2 读的是串口线空闲电平，应为 1（高）
BOOT 1 / NRST 0    → 单独驱动某根线，便于用万用表量
PULL 4 1 / IN 4    → 把某个 GPIO 切上拉再读回，验证某根线是否真的连到 MCU
PULSE 200          → 拉低 NRST 200 ms，然后放开
```

判据：`BOOT 1` 后 `PINS` 应显示 `boot0=1`；`NRST 0` 后显示 `nrst=0`。
读不到就说明那根线没接通或接错脚。

## 6. 三种烧录方式各自的接线

### A. Wi-Fi（ESP 桥接，本文主体）

上面 5 根线全接，ESP 与电脑同一网络（或电脑开热点）。**不需要**插 ST-Link。

### B. ST-Link（SWD）

| ST-Link | STM32 |
|---|---|
| SWDIO | PA13 |
| SWCLK | PA14 |
| GND | GND |
| 3.3V | 3.3V（可只接 GND/SWDIO/SWCLK，板子自己供电） |
| NRST（可选） | NRST |

面板里把「传输」选 **ST-Link**，点「编译」「烧录」或「一键下载」。

### C. UART 引导程序（USB-TTL 直连，不经 ESP）

| USB-TTL | STM32 |
|---|---|
| TX | PA10 |
| RX | PA9 |
| GND | GND |
| — | BOOT0 手动接 3.3 V（进引导程序），烧完接回 GND 并复位 |

面板里「传输」选 UART、端口选 USB-TTL 的 COM 口。主机侧同样使用 **8E1**。

## 7. 常见故障对照

| 现象 | 先查 |
|---|---|
| `RUN` 后 MCU 不动、串口无输出 | 第 3 根线（GND）是否接好；`PULSE` 是否真的复位了 MCU |
| 同步（`0x7F`）无应答 | BOOT0 是否真的是高；TX/RX 是否交叉接反 |
| 同步 OK、擦除失败 | 校验位是否 8E1（见第 3 节） |
| ESP 不出现 AP/不联网、毫无输出 | ESP-01S 的 GPIO0 被 NRST 拖低（见 ESP-01S 一节） |
| ESP 反复重启 | 供电不足（尤其 ESP-01S 用 3.3 V LDO） |
| 烧完程序不跑、灯不闪 | BOOT0 是否仍为高（用 `BOOT 0` + `PULSE` 放开） |
