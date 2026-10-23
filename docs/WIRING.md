# Wiring the Wi-Fi bridge (ESP-01S)

Goal: flash and reset the STM32 over Wi-Fi without a USB cable. The ESP-01S is a
plain **byte pipe** - all STM32 knowledge lives in `lib/bootloader.mjs`.

## Connections

| ESP-01S | STM32 | Note |
| --- | --- | --- |
| TX | RX (USART1 PA10, or USART3 PB11 on F4) | 3.3 V logic, no level shifter |
| RX | TX (USART1 PA9, or USART3 PB10 on F4) | |
| GND | GND | common ground is mandatory |
| GPIO0 | BOOT0 through 1 k | 10 k pull-down on the STM32 side |
| GPIO2 | NRST | open-drain or push-pull, 100 nF to GND optional |
| VCC | 3.3 V rail | **not** the MCU's LDO |

Power: the ESP-01S draws ~300 mA peaks while transmitting. Put 100 uF + 100 nF
next to the module pins, on its own 3.3 V feed. A brown-out on that rail resets
the whole board and looks exactly like "the flasher randomly fails".

GPIO0/GPIO2 are high at ESP boot (flash boot mode); the series resistor makes
that harmless for the STM32 because the pull-down keeps BOOT0 low and NRST is
pulled up internally.

## Sequence the plugin runs

```
BOOT0 = 1, NRST low 100 ms, release            -> system bootloader
open the byte pipe, send 0x7F, wait for ACK    -> AN3155 sync (retry 3x)
GET / GET-ID                                    -> version + PID
mass erase (0x43 standard / 0x44 extended)
write memory (0x31, 256 bytes per frame) + checksum
GO 0x08000000 (or: BOOT0 = 0, pulse NRST)      -> application runs
```

Mass erase means **the whole flash is gone** before the first byte is written;
there is no page-level erase in 0.1.0. If the transfer dies mid-way the board
stays blank - keep SWD (ST-Link) available for recovery.

## Port collision warning

Most F103 boards wire PA9/PA10 to the on-board CH340. If both the CH340 and the
ESP TX drive the same line, the bootloader sees two transmitters. Options:

1. Use **USART3 (PB10/PB11)** on F4 parts and route the ESP there.
2. Lift/disable the CH340 TX pin.
3. Put 1 k in series with the ESP TX and never open the CH340 port at the same time.

## Status

0.1.0 ships the UART flasher (verified over a local CH340/ST-Link setup) and the
state machine. The ESP-01S firmware plus the TCP byte pipe are 0.2.0 work; until
then use `transport: uart` with a cable, or `transport: swd`.
