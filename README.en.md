# dsh-stm32-toolchain

A DeepSeek Harness (DSH) plugin that folds **Keil + STM32CubeMX + a serial terminal + a flasher**
into one main-page panel and one set of agent tools - including flashing over Wi-Fi with no cable.

- Build headlessly with the Keil CLI you already licence (`UV4 -b`), and read structured diagnostics instead of a log wall.
- Flash three ways: the project's ST-Link (`UV4 -f`), the STM32 system bootloader over a USB-TTL (AN3155), or **the same bootloader through an ESP bridge over Wi-Fi**.
- Watch build, flash and serial output in one live stream; click a diagnostic to open that file:line in VS Code.
- Everything is also exposed as `mcp__stm32__*` tools, so the agent can build, flash and read logs by itself.

[中文说明](README.md)

## Requirements

| Component | Notes |
| --- | --- |
| DSH desktop >= 0.2 | plugin host |
| Keil MDK (uVision 5) | `UV4.exe`; your own licence is used exactly as the GUI would |
| Python 3 + pyserial | serial monitor and UART flashing (`pip install pyserial`) |
| STM32CubeMX | optional: `stm32_cube_gen`, the 打开 .ioc / 生成代码 buttons |
| arduino-cli + ESP8266 core | optional: only to build an ESP bridge firmware |
| ESP-12E / NodeMCU (recommended) or ESP-01S | optional: Wi-Fi flashing and wireless serial |
| ST-Link | optional: the `swd` transport |

## Install

```bash
# inside your DSH profile (for example ~/.dsh/profiles/desktop)
pnpm add link:D:/path/to/dsh-stm32-toolchain
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

Reference the package in `package.json` -> `dsh.profile.bundles` and restart DSH: the
**STM32 总管** entry appears in the sidebar and the `mcp__stm32__*` tools appear.

## Settings (`Config`)

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Mount or unmount the whole plugin |
| `announceToAgent` | true | Inject the STM32 work rules into the system prompt |
| `project` | '' | Default `.uvprojx`; the chip is read from its `<Device>` field |
| `uv4Path` / `cubeMxPath` | '' | Empty means auto-detect |
| `pythonPath` | '' | Python with pyserial; empty means auto-detect |
| `httpPort` | 39021 | Loopback port of the bridge daemon (panel + SSE) |
| `toolCallTimeoutMs` | 300000 | Per-tool timeout |
| `cardOrder` | `chip,transport,port,firmware,cube,build,flash,lease,logs` | Card order (five per row) |
| `logFontSize` / `logLineHeight` / `logMaxLines` | 12 / 1.5 / 400 | Log text |
| `logWrap` / `logTimestamps` | true / false | Wrap long lines / prefix each line with its time |
| `logColorBuild` / `Flash` / `Serial` / `Sys` | '' | Per-channel colours; empty keeps the theme |
| `logBgGradient` / `logBgFrom` / `logBgTo` | false / #0d1117 / #161b22 | Gradient behind the log |

Flash parameters are **not** in the settings page - they live on the panel (烧录设置), because
they belong to the board in front of you. Both sides persist to `<plugin>/.state.json` and never
overwrite the profile.

## The panel

- **Cards, five per row** - chip, transport, port, firmware, CubeMX / build, flash, lease, logs.
- **Action bar** - 编译, 烧录, 一键编译 + 烧录 (+ 看日志), 打开串口, HEX, 无线串口,
  打开 .ioc, 生成代码, 选择 .ioc…, VSCode, 清空日志, 烧录设置.
- **Log stream** - tabs 全部/编译/烧录/串口/系统, text filter, follow-tail; the serial tab doubles
  as a sender and echoes what you send (显示发送).
- **Project card** - 选择文件夹… / 扫描工程 / 使用此路径 / **最近工程** (the last ten projects,
  newest first, missing ones marked ✗).
- **Environment card** - eight checks with fix hints: Keil, its licence, CubeMX, python+pyserial,
  serial ports, the ESP bridge (control-port ping), arduino-cli + ESP8266 core, current project.
  Collapsed when everything is ready, expanded when something is not.
- **Diagnostics** - one clickable row per build error/warning.
- Status is reported in exactly one place: the light next to the panel title and the text beside it.

## Wi-Fi flashing

| Half | What it does |
| --- | --- |
| Firmware (`firmware/esp01s`) | joins your Wi-Fi (or starts a provisioning AP), serves control port 3333 and a raw UART pipe on 3334, drives BOOT0/NRST |
| Panel rows | 烧录设置 -> Wi-Fi 名称 / Wi-Fi 密码 -> 生成固件 (bakes the credentials in and compiles) -> 烧到 ESP (USB-TTL) |
| Agent | `stm32_esp_firmware` with `build` / `flash` / `status` / `detect` / `discover` |

Wiring (ESP-12E / NodeMCU, recommended):

| ESP | STM32 | Purpose |
| --- | --- | --- |
| D2 (GPIO4) | BOOT0 | boot mode |
| D1 (GPIO5) | NRST | reset |
| TX | PA10 | USART1_RX |
| RX | PA9 | USART1_TX |
| GND | GND | common ground |

Once both control wires are solid a Wi-Fi flash needs **no button press**: the bridge sets BOOT0,
pulses NRST, the AN3155 handshake runs over the pipe, then BOOT0 drops and the board is reset into
the new application.

DHCP moves the ESP address; the panel's **自动探测 ESP** scans the private subnets for a host that
answers `+STATUS` on port 3333 and adopts it.

The same pipe doubles as a **wireless serial monitor**: enable 无线串口 and the monitor reads the
ESP socket instead of a COM port. The pipe serves one client, so a flash stops the monitor first.

Credentials live in `.state.json`, are never sent to the browser, and the generated `.bin`
(which contains the password in plain text) stays inside the gitignored `firmware/esp01s/build/`.

### Transports

| transport | path | needs |
| --- | --- | --- |
| `swd` | ST-Link via `UV4 -f` | a debugger wired to the board |
| `uart` | AN3155 over a USB-TTL | BOOT0/NRST access, a COM port |
| `wifi` | AN3155 through the ESP bridge | the ESP firmware, BOOT0/NRST wired to the ESP |

`lib/wifi.mjs` satisfies the same byte-pipe contract as the serial pipe, so `lib/bootloader.mjs`
(AN3155: sync, GetID, sector erase, three-step write with 4-byte padding, GO) is shared unchanged.

## Tools

| Tool | What it does |
| --- | --- |
| `stm32_doctor` | Keil path/version/licence, CubeMX, pyserial, COM ports, chip table |
| `stm32_status` | Phase, chip, transport, port, firmware size, last build/flash |
| `stm32_project` | Device -> chip family, bootloader pins, outputs |
| `stm32_build` | `UV4 -b` headless build, structured diagnostics |
| `stm32_flash` | `swd` / `uart` / `wifi` |
| `stm32_deploy` | build then flash; `watch:<ms>` returns the post-flash serial log |
| `stm32_checkout` | folder -> `.uvprojx` -> chip -> transport/port, one call |
| `stm32_claim` | exclusive lease on the board |
| `stm32_serial` | open/close/write/tail the serial monitor |
| `stm32_logs` | ring buffer query (channel, regex, since) |
| `stm32_chips` / `stm32_ports` | chip table / serial ports |
| `stm32_open_vscode` | open `file:line` in VS Code |
| `stm32_cube_gen` | headless CubeMX regeneration from an `.ioc` |
| `stm32_esp_firmware` | build / flash / status / detect / discover the ESP bridge |

## Concurrency: two sessions, one board

The board is a single resource and one plugin instance = one bridge process = all sessions share it.

| Layer | Mechanism |
| --- | --- |
| Same process | every mutating action runs through one job queue |
| Token-less callers | the panel and an agent that never claims share one implicit lease |
| Two owners | a lease: `BOARD_BUSY` with the holder name and age; TTL 180 s, renewed on call and every 15 s while a job runs |
| Two DSH instances | `.lock.json` (pid + kind + 5 min TTL) refuses the second instance |
| Serial port | Windows COM ports are exclusive, so the error is "port busy" rather than a timeout |

Knobs: `DSH_STM32_LEASE_TTL` (ms, default 180000) and `DSH_STM32_LEASE_HEARTBEAT` (ms, default 15000).

## Adding a board

`lib/chips.json` holds family defaults (bootloader UART pins, max baud, erase mode, flash page) and
per-device entries. Add a device, restart DSH, done. Unknown devices fall back to USART1/115200 and
the panel says so.

## Development

```bash
pnpm install
pnpm test        # unit + contract + bridge end-to-end
```

Layout: `lib/runtime.mjs` (Node selection), `lib/core.mjs` (project/Keil/chip logic),
`lib/serial.mjs` + `lib/serial-worker.py` (byte pipe over pyserial), `lib/bootloader.mjs` (AN3155),
`lib/wifi.mjs` (ESP control lines + TCP pipe), `lib/wifi-fw.mjs` (firmware generation),
`lib/bridge.mjs` (state machine + HTTP/SSE + MCP), `lib/index.js` (DSH host half),
`lib/client.js` (main-page panel).

## Licence

MIT
