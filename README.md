# dsh-stm32-toolchain

A DeepSeek Harness (DSH) plugin that turns **Keil + STM32CubeMX + a serial terminal + a flasher** into one
main-page panel and one set of agent tools.

- Build headlessly with the Keil CLI you already licence (`UV4 -b`), read structured diagnostics instead of a log wall.
- Flash with the project's ST-Link (`UV4 -f`) **or** with the STM32 system bootloader over UART (AN3155) - the same code path a Wi-Fi bridge will use.
- Watch the serial port, the build log and the flash log in one live stream; jump from an error to the exact VS Code line.
- Everything is also exposed as `mcp__stm32__*` tools, so the agent can build, flash and read logs itself.

## Requirements

| Component | Notes |
| --- | --- |
| DSH desktop \>= 0.2 | plugin host; 0.1.5 also works |
| Keil MDK (uVision 5) | `UV4.exe`; a commercial/Lite licence is used exactly as the GUI would |
| Python 3 + pyserial | serial monitor and UART flashing (`pip install pyserial`) |
| STM32CubeMX | optional, for `stm32_cube_gen` |
| ST-Link | optional, for the `swd` transport |

## Install

```bash
# inside your DSH profile (for example ~/.dsh/profiles/desktop)
pnpm add link:D:/path/to/dsh-stm32-toolchain
```

Then add the row to the profile so the host half actually loads:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: stm32-toolchain
  name: dsh-stm32-toolchain
  config:
    enabled: true
    project: 'D:/work/firmware/Project.uvprojx'
    transport: swd
```

and reference the package in `package.json` -> `dsh.profile.bundles`. Restart DSH;
the panel shows up on the main page and `mcp__stm32__*` tools appear.

## Settings (`Config`)

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Mount or unmount the whole plugin |
| `announceToAgent` | true | Inject the STM32 work rules into the system prompt |
| `project` | '' | Default `.uvprojx`; the chip is read from its `<Device>` field |
| `uv4Path` / `cubeMxPath` | '' | Empty means auto-detect (`D:\Keli_v5\UV4\UV4.exe`, registry, PATH) |
| `transport` | `swd` | `swd` = ST-Link via `UV4 -f`; `uart` = system bootloader |
| `serialPort` / `baud` | '' / 115200 | Port for monitoring and UART flashing |
| `espHost` / `espPort` | '' / 23 | ESP-01S Wi-Fi bridge address (reserved for 0.2.0) |
| `pythonPath` | '' | Python with pyserial; empty means auto-detect |
| `httpPort` | 39021 | Loopback port of the bridge daemon (panel + SSE) |
| `retry` | 3 | Bootloader sync retries |
| `toolCallTimeoutMs` | 300000 | Per-tool timeout |
| `cardOrder` | `chip,transport,port,firmware,build,flash,lease,logs` | Card order, position 1-8 (1-4 = first row) |
| `logFontSize` / `logLineHeight` | 12 / 1.5 | Log text size and line height |
| `logMaxLines` | 400 | Rendered log rows |
| `logWrap` / `logTimestamps` | true / false | Wrap long lines / prefix each line with its time |
| `logColorBuild` / `logColorFlash` / `logColorSerial` / `logColorSys` | '' | Per-channel text colours; empty keeps the theme default |
| `logBgGradient` / `logBgFrom` / `logBgTo` | false / #0d1117 / #161b22 | Linear gradient behind the log panel |

In the card the six colour pickers are folded into a two-column grid (3 rows) to
keep the section short; the gradient stops dim out while the gradient is off.

## The panel (main page)

Open the **STM32 总管** entry in the sidebar; the panel fills the page:

- **Stat cards, four per row** - row 1 is identity (chip from the project's
  `<Device>` -> transport -> serial port -> firmware size/time); row 2 is
  activity (last build -> last flash -> current lease holder -> log volume and
  bridge port).
- **Action bar** - 编译 / 烧录 / 一键编译+烧录 / 打开串口 / VSCode / 清空日志
  (dropdown: 清空当前日志 = only the selected tab, 全部 counts as everything; 清空所有日志 = the whole ring),
  plus a transport switch and a serial-port picker (CH340, ST-Link VCP, ...).
- **Log stream** - live SSE feed with tabs (全部/编译/烧录/串口/系统), text filter,
  follow-tail toggle; the serial tab doubles as a sender (type + Enter).
- **烧录设置** (toggle in the action bar) - transport, baud, bootloader retries,
  ESP host/port; changes apply immediately and persist in `.state.json`.
- **Project card** - 扫描工程 walks the usual roots for `.uvprojx` files, or paste
  a path; the choice is remembered in `.state.json`.
- **Officially styled controls** - every boolean uses the DSH `Switch` primitive
  from `@deepseek-ai/dsh-client-ui-primitives` (injected via `dsh.client.inject`),
  so the card matches the rest of the app; a plain checkbox is only a fallback
  for a host without that package. The three dropdowns (serial port, transport,
  discovered projects) use the same package's `Menu`, so their popup is drawn by
  the app - rounded, themed, keyboard navigable - instead of the OS list.
- **Diagnostics** - one clickable row per build error/warning; the click opens
  VS Code at that file:line.

Panel choices (project, transport, port, baud) persist in `<plugin>/.state.json`
and never overwrite the profile settings.

## Settings page

`设置 → 插件 → STM32 工具链` renders a card that edits **only this plugin's
namespace**. Every option is one row - label plus a one-line hint on the left, control on the
right - separated by a hairline using the official `--dsw-alias-border-l` token
(falling back to a neutral rgba when the host does not define it). The card keeps four categories - 常规 (the two switches), 工具链, 日志文字 and
状态卡排序 - each heading sitting on the rule drawn by the row above, so a
group boundary is still exactly one line. 保存 closes the card. The card edits **only this plugin's
namespace** (`stm32-toolchain`): Keil/CubeMX/Python paths, default project,
bridge port, tool timeout, enable + prompt-announcement switches. The
auto-generated form is switched off (`configure({ auto: false })`) so there is
exactly one page, and a stale revision surfaces as `SETTINGS_CONFLICT` instead
of silently overwriting.

Log text (size, line height, row cap, wrap, timestamps), the four channel colours,
the optional background gradient and the **状态卡排序**
list live on this card too; a **日志预览** block sits right under the log groups (before 状态卡排序) and
renders four sample lines from the values currently in the form, so you see the
effect before saving: eight numbered slots in **one** column, each
moveable by the `≡` handle on the right (positions 1-4 render on row 1, 5-8 on
row 2 of the panel). Dragging
moves a slot rather than swapping two, and the drop target is highlighted while
you hover. Saving re-applies the plugin, which is what pushes the new order to
the running bridge.

Flash parameters are deliberately **not** there - they live on the MCU page:

| Where | What |
| --- | --- |
| Settings card | toolchain paths, default project, bridge port, timeout, enable/announce |
| STM32 总管 → 烧录设置 | transport (ST-Link / UART bootloader), baud, bootloader retries, ESP host/port |

Both sides talk over the same two routes: `GET /settings/describe` (this
namespace only) and `POST /settings/mutate` (`{ops, revision}`).

On DSH >= 0.2 the profile entry's `volatile` fields arrive as live references;
`apply()` unwraps them (`unwrapConfig`) before any consumer reads them.

Presentation settings (card order, log text/colours/gradient) are additionally
served by the host as `GET /api/dsh-stm32-toolchain/config` and projected from the
live plugin config on every apply. The panel resyncs that route on mount, on SSE
reconnect, every 5 s and after every action, so a saved setting shows up even if
the bridge child never restarted.

### When a setting takes effect

| Setting | Applied by | Restart? |
| --- | --- | --- |
| 状态卡顺序, 日志字号/行高/行数/换行/时间戳, 通道颜色, 渐变 | client store, on save | no |
| 扫描根目录 | sent with each scan, read from the live config | no |
| Keil / CubeMX / Python 路径, 默认工程 | `set-tools` posted to the bridge on save | no |
| 传输 / 串口 / 波特率 / 重试 / ESP 主机端口 | panel actions, persisted in `.state.json` | no |
| 启用插件, 注入工作规范, 桥接端口, 单次工具超时 | host load time (mount, prompt, routes, mcp client) | **yes** |

## Tools

| Tool | What it does |
| --- | --- |
| `stm32_doctor` | Keil path/version/licence, CubeMX, pyserial, COM ports, chip table, transports |
| `stm32_status` | Phase, chip, transport, port, firmware size, last build/flash |
| `stm32_project` | Device -> chip family, bootloader pins, outputs, ST-Link usage |
| `stm32_build` | `UV4 -b` headless build, structured diagnostics |
| `stm32_flash` | `swd` (UV4 -f) or `uart` (AN3155 mass erase + write + go) |
| `stm32_deploy` | build then flash; `watch:<ms>` returns the post-flash serial log |
| `stm32_checkout` | folder -> `.uvprojx` -> chip -> transport/port, one call |
| `stm32_claim` | exclusive lease on the board (owner label, token, release/force) |
| `stm32_serial` | open/close/write/tail the serial monitor |
| `stm32_logs` | ring buffer query (channel, regex, since) |
| `stm32_chips` | family table or one device resolution |
| `stm32_ports` | serial ports with descriptions |
| `stm32_open_vscode` | open `file:line` in VS Code |
| `stm32_cube_gen` | headless `STM32CubeMX -q` regeneration from an `.ioc` |

## Concurrency: two sessions, one board

The board is a single physical resource, and one plugin instance = one bridge
process = **all sessions share it** (`@deepseek-ai/dsh-mcp-client` carries no
session identity, so per-session state is not possible at the MCP boundary).

What is enforced instead:

| Layer | Mechanism |
| --- | --- |
| Same process | every mutating action runs through one job `queue` (build/flash never overlap) |
| Token-less callers | the panel (and an agent that never claims) share one implicit lease, so repeated buttons work; an explicit claim is protected from them and may take over an idle implicit lease, never a running one |
| Same process, two owners | a **lease**: first caller claims implicitly; a different owner gets `BOARD_BUSY` with the holder name and age; TTL 180 s, renewed on every call **and every 15 s while a job runs**, so a slow build cannot be mistaken for an idle board; `GET /state` reports `lease{owner, heldSeconds, expiresInSeconds}` and the panel shows a real countdown (本地每秒重算) plus 强制释放 |
| Two DSH instances | a `.lock.json` (pid + kind + 5 min TTL, pid liveness checked) refuses the second instance |
| Serial port | Windows already makes COM ports exclusive; the error surfaces as "port busy" instead of a timeout |

The agent is told (system prompt) to `stm32_claim` before a multi-step run and
to pass the returned token to every mutating call.

Knobs: `DSH_STM32_LEASE_TTL` (ms, default 180000) and
`DSH_STM32_LEASE_HEARTBEAT` (ms, default 15000). An idle lease drops on its own
and takes its owner label with it; a lease whose job is still running does not
expire.

## Adding a board

`lib/chips.json` holds family defaults (bootloader UART pins, max baud, erase
mode, flash page) and per-device entries. Add a device, restart DSH, done - no
code change. Unknown devices fall back to USART1/115200 and the panel says so.

## Wiring a Wi-Fi bridge

See [`docs/WIRING.md`](docs/WIRING.md): ESP-01S power, BOOT0/NRST control and
the reset-then-flash sequence.

## Development

```bash
pnpm install
pnpm test        # core smoke test + bridge end-to-end (MCP + HTTP)
```

Layout: `lib/runtime.mjs` (picks Node vs the desktop-bundled Node), `lib/core.mjs` (project/Keil/chip logic), `lib/serial.mjs` + `lib/serial-worker.py`
(byte pipe over pyserial), `lib/bootloader.mjs` (AN3155), `lib/bridge.mjs`
(state machine + HTTP/SSE + MCP), `lib/index.js` (DSH host half),
`lib/client.js` (main-page panel).

## Licence

MIT