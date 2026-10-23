# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> This file was accidentally overwritten during development and rebuilt from the
> change log of the work that produced 0.1.0. Entries below summarise real
> changes; the original wording is lost.

## [0.2.0] - 2026-10-24

### Added
- **Wi-Fi flashing**: AN3155 over an ESP bridge (`transport: wifi`), fully automatic - the bridge sets BOOT0 and pulses NRST, so no button press is needed once both wires are solid.
- ESP firmware now defaults to the **ESP-12E / NodeMCU** carrier (D2 = BOOT0, D1 = NRST - neither is a boot strap); the ESP-01S still builds with `BOARD_NODEMCU=0`, and the panel has a board selector.
- **Wireless serial monitor**: the panel can open its monitor on the ESP pipe instead of a COM port (无线串口).
- **ESP discovery** (自动探测 ESP): scans the private subnets for a control port that answers `+STATUS` and adopts the address.
- **Environment checklist** in the sidebar: Keil, licence, CubeMX, python+pyserial, serial ports, ESP bridge, arduino-cli and the current project, each with a fix hint.
- **CubeMX card and toolbar actions**: open the project's `.ioc` in the GUI or regenerate code headlessly, with progress and result reporting.
- **Recent projects** dropdown (last ten, newest first).
- **Quick-start help** dialog (`?`) with the five-step flow, the ESP-12E wiring table and the usual failures; the entry prompt now documents the Wi-Fi flow for new sessions.
- Serial **HEX** view and a **显示发送** toggle; sent lines are echoed with an arrow.
- Contract tests (`test/ui-contract.test.mjs`, `test/env-check.test.mjs`, `test/sector-erase.test.mjs`, `test/write-memory.test.mjs`, `test/discover.test.mjs`).

### Fixed
- AN3155 sector erase sends **N = sectors - 1** (the plain count made the bootloader wait for another sector code: a silent 30 s timeout), and only the sectors the image touches are erased.
- Write memory uses the three ACK boundaries and pads the payload to four bytes, as the F4 bootloader requires.
- A NAK sends the bootloader back to "waiting for 0x7F"; commands now re-sync and retry once instead of silently failing.
- `Get (0x00)` is optional on parts that NAK it (`GetID` identifies the chip).
- Panel layout: cards five per row, the log area fills the space below the panel (measured, not `100vh`), the environment checklist collapses so it stops squeezing the diagnostics.
- `Card` renders its children, so buttons are no longer dropped.
- Serial echo and the 显示发送 toggle actually work (an earlier multi-line edit silently matched nothing).

## [0.1.0] - 2026-10-23

### Added

- DSH host plugin (`dsh-stm32-toolchain`) that spawns `lib/bridge.mjs` as an MCP
  stdio server and proxies its loopback HTTP/SSE surface to the browser half.
- 14 agent tools: doctor, status, project, build, flash, deploy, checkout, claim,
  serial, logs, chips, ports, open_vscode, cube_gen.
- Headless Keil build (`UV4 -b`) with structured diagnostics; ST-Link download
  (`UV4 -f`); AN3155 system-bootloader flasher over any serial pipe.
- Main-page panel: two rows of stat cards, action bar, live SSE log stream with
  channel tabs, diagnostic list, project picker, serial send box.
- Settings card with four categories (常规 / 工具链 / 日志文字 / 日志颜色), hairline
  rows, official `Switch` and `Menu` primitives, and a single-column 1-8 drag
  list for card order.
- Log text options (size, line height, row cap, wrap, timestamps), per-channel
  colours, an optional background gradient and a live preview.
- Board lease: owner label, TTL 180 s, 15 s heartbeat while a job runs, forced
  release, cross-process `.lock.json`; `/state` reports the holder and age.
- Session binding: a control in `conversation.session.header.actions` (the same
  spot as 打开 MATLAB) with three states - unbound / bound to this session /
  bound elsewhere - persisted in `.state.json`; the panel sends prompts through
  the host `POST /ask` route.
- Tests: runtime, settings, client, client-primitives, jump, vscode, lease,
  presentation, paths, no-project, smoke, bridge.

### Added

- **ESP-01S Wi-Fi bridge firmware** (`firmware/esp01s/`): two TCP servers (3333 control
  lines, 3334 raw UART pipe), BOOT0/NRST driving (`BOOTLOADER`/`RUN`), EEPROM credential
  storage with a provisioning AP + captive portal, and a three-step credential priority
  (EEPROM → baked-in → provisioning).
- **Generated-firmware flow**: the panel's Wi-Fi fields feed `gen-firmware`, which writes
  `wifi_creds.h` into a temporary sketch copy and compiles it with the Arduino ESP8266 core
  (no credentials on a command line), then `flash-esp` writes that `.bin` to the ESP over
  USB-TTL. Exposed to the agent as `stm32_esp_firmware`.
- The Wi-Fi password never leaves the bridge (`/state` reports `hasPass` only).
### Added

- **`transport: wifi`**: `lib/wifi.mjs` implements the AN3155 byte-pipe contract over the
  ESP-01S bridge (3333 control, 3334 raw UART), so `flashImage` runs unchanged over
  Wi-Fi: BOOTLOADER (BOOT0 high + reset) → handshake → blocks → RUN (BOOT0 low + reset).
  The panel offers the transport and the log channel records every control round-trip.

### Changed

- Settings apply immediately where possible: presentation goes through a
  client-side store, toolchain paths are pushed with `set-tools`, scan roots are
  sent with each scan. Only 启用插件 / 注入工作规范 / 桥接端口 / 单次工具超时 need a
  host reload and say so in the UI.
- The folder picker uses the app's native picker, falling back to a Vista+
  `IFileOpenDialog` and only then to `FolderBrowserDialog`.
- 扫描工程 looks at the current project's parent plus Desktop/Documents/Downloads,
  optionally extended by `searchRoots`, and reports its scope.
- 清空日志 became a menu: 清空当前日志 (selected tab, and everything on 全部) and
  清空所有日志.
- `transport: swd | uart`; ESP fields reserved for the 0.2.0 Wi-Fi transport.

### Fixed

- Settings never applied: DSH hands `volatile` config fields over as live
  references, so every value fell back to its default. `apply()` unwraps them.
- A stale presentation overlay shadowed the saved value; removed - the host
  config is authoritative and the client store applies it on save.
- Saves erased values the form no longer held (describe omits default-equal
  keys); `buildOps`/`mergeForm` only write what the form owns.
- A refused action (no project) left the board claimed; project validation now
  runs before the lease and an implicit lease is released when its job fails.
- 释放 looked broken (no state push, and the panel merged action results).
- A second panel action was refused as BOARD_BUSY; token-less callers share one
  implicit lease.
- Stale log rows with duplicate keys after a bridge restart; entries are tagged
  with a per-process instance and a new instance resets the stream.
- Chinese paths arrived mangled from the PowerShell dialog (`D:\ʵ���Ҿ���`), so
  scanning found nothing: the path now crosses as a UTF-8 file and `repairPath`
  recovers latin1-mangled input.
- Opening a diagnostic emptied the file: build logs carry relative paths and
  `code -g` resolved them against VS Code's cwd. Paths resolve against the project
  and a missing file is refused. The VSCode button opens the project **root**,
  climbing out of MDK-ARM/Objects.
- 交给 AI crashed with `Cannot destructure property 'source' of 'options'`; session
  creation is gone in favour of binding.

### Known limitations

- Wi-Fi transport (ESP-01S firmware + TCP byte pipe) is not implemented yet.
- Wireless SWD debugging needs an ESP32-S3 running CMSIS-DAP over TCP.
- Page-level erase, option bytes and read-out protection are not exposed.
