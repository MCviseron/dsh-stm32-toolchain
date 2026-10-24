# 链路模式（主机 ↔ ESP）

同一份草图（`firmware/esp01s/esp01s.ino`）可以编译成三种链路，由生成固件时写入
`wifi_creds.h` 的 `LINK_MODE` 决定；三种模式都支持 **ESP-12E / ESP-01S / ESP32** 三块板。

| 模式 | 面板选项 | 谁驱动 AN3155 | 一次 15 KB 的 TCP 往返 | 断网后果 |
|---|---|---|---|---|
| `stream` | 流式 | 主机（逐块发、逐块等 ACK） | 约 350 次 | 烧到一半 |
| `block` | 块级 ACK | 主机发块，ESP 执行三段握手并重试 | 约 120 次 | 烧到一半 |
| `spool` | 全量缓存 | **ESP**（镜像先落到 ESP 文件系统） | 上传 60 次 + 1 次触发 | **什么都没烧** |

## stream

3334 是透明管道：主机把 AN3155 的每个字节发过去，ESP 原样转发。

## block

主机发 `#B <addr-hex> <len>\n` + len 字节；ESP 自己完成「命令 / 地址 / 数据」三段握手，
失败先重新同步再整块重试（最多 4 次），回 `+B ok <tries>` 或 `+B err`。

## spool

主机先把镜像写进 ESP 的文件系统（LittleFS），再让 ESP 自己烧：

```
#I <bytes>                        开始接收      -> +I ok <bytes> | +I err
#S <offset> <len> + len 字节       写入片段      -> +S ok <end>   | +S err
#F <base> <eraseCmd> <n> <s0,..>  复位+同步+擦除+写+GO
                                  -> +F reset / +F sync ok / +F erase ok
                                     +F write <done> <total> / +F ok <ms> / +F err <stage>
#Q                               查询状态      -> +Q <state> <have>
#A                               放弃          -> +A ok
```

- 扇区表由**主机**算好（F4 扇区：0–3 号 16 KB、4 号 64 KB、5–11 号 128 KB），ESP 只负责执行，
  固件里不重复芯片知识；
- 擦除帧遵守 AN3155 的 `N = 扇区数 − 1`；
- 目前 spool 的擦除只针对 **STM32F4**（其它系列请用 stream）；
- 镜像大小受文件系统限制：ESP-01S（1 MB flash）约 64 KB，ESP-12E / ESP32 更宽裕。

## 板型差异

| 项目 | ESP-12E / ESP-01S | ESP32 DevKit |
|---|---|---|
| STM32 串口 | `Serial`（UART0） | `Serial2`（GPIO16 RX2 / GPIO17 TX2） |
| USB 调试 | 与 STM32 共用（不可用） | UART0 独立，`DBG()` 打印启动/入网日志 |
| BOOT0 / NRST | D2 / D1（ESP-01S：GPIO2 / GPIO0） | GPIO25 / GPIO26 |

## 编译矩阵（已在本机验证）

```
esp8266:esp8266:nodemcuv2                mode=1/2/3  OK
esp8266:esp8266:generic:eesz=1M,xtal=80  mode=1/2/3  OK
esp32:esp32:esp32                        mode=1/2/3  OK
```

命令示例：

```powershell
arduino-cli compile -b esp32:esp32:esp32 \
  --build-property "compiler.cpp.extra_flags=-DLINK_MODE=3" firmware/esp01s
```
