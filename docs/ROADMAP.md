# Roadmap

## 0.1.0 (shipped)

- Host plugin + bridge daemon, main-page panel, 12 tools.
- Headless Keil build and ST-Link download.
- AN3155 UART flasher over a serial port.
- Chip table with family defaults and per-device overrides.

## 0.2.0 - Wi-Fi transport (the point of the exercise)

- `lib/transport/tcp.mjs`: same byte-pipe interface as `SerialPipe`, backed by a
  socket, so `bootloader.mjs` stays untouched (`connect/write/readExact/flush`).
- `firmware/esp01s`: transparent TCP<->UART bridge plus a tiny control channel
  for BOOT0/NRST (`{"pin":"boot0","value":1}`), 115200 default.
- `transport: wifi` in Config: host/port, reset mode (`nrst-pin` vs `go-only`),
  retry policy; the panel shows the bridge address and link state.
- Reconnect logic: 802.11 retransmits break bootloader timing, so the flasher
  re-syncs (0x7F) and resumes from the last acknowledged 256-byte frame.

## 0.3.0 - Wireless debug (separate hardware)

- ESP32-S3 running `cmsis_dap_tcp_esp32` -> OpenOCD `cmsis-dap-tcp` backend.
- `transport: swd-wifi`: `stm32_debug_start` launches OpenOCD, the panel grows
  breakpoint/continue buttons, VS Code Cortex-Debug attaches to the same gdb port.
- Keil cannot drive a remote probe, so this path is VS Code only; Keil stays the
  compiler of record (or migrate to CMake + arm-none-eabi-gcc).

## Nice to have

- Page-level erase / sector map for F4/F7 (avoid a full mass erase for one sector).
- Read-out protection and option bytes.
- `compile_commands.json` export from `.uvprojx` for real VS Code IntelliSense.
- Multi-board profiles: one panel entry per board, switching chips and ports.
