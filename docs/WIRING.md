# Wiring the Wi-Fi bridge (ESP-12E / NodeMCU, or ESP-01S)

Goal: flash, reset and read the serial log over Wi-Fi without a USB cable. The module is a plain
**byte pipe** - all STM32 knowledge lives in `lib/bootloader.mjs`.

## ESP-12E / NodeMCU (recommended)

| NodeMCU | STM32 | Note |
| --- | --- | --- |
| D2 (GPIO4) | BOOT0 | boot mode, driven by the firmware |
| D1 (GPIO5) | NRST | reset, driven by the firmware |
| TX (GPIO1) | PA10 (USART1_RX) | 3.3 V logic, no level shifter |
| RX (GPIO3) | PA9 (USART1_TX) | |
| GND | GND | common ground is mandatory |
| VIN / 3V3 | 3.3 V rail or its own USB | the on-board regulator handles the transmit peaks |

D1 and D2 carry **no boot strap**, so driving the STM32 from them can never put the ESP into flash
mode, and no transistor or diode is needed: the ESP pulls BOOT0 high, pulses NRST low, and releases
both afterwards.

## ESP-01S (legacy, still builds with `BOARD_NODEMCU=0`)

| ESP-01S | STM32 | Note |
| --- | --- | --- |
| TX | PA10 | |
| RX | PA9 | |
| GND | GND | |
| GPIO2 | BOOT0 | through 1 k, 10 k pull-down on the STM32 side |
| GPIO0 | NRST | open drain / transistor; GPIO0 is a boot strap, so a direct low at power-up puts the ESP in flash mode |
| VCC | 3.3 V rail | **not** the MCU's LDO; 100 uF + 100 nF next to the pins |

The ESP-01S browns out easily: a sagging rail looks exactly like "the flasher randomly fails".

## Sequence the plugin runs

```
BOOT 1 (BOOT0 high) + PULSE (NRST low ~100-400 ms)   -> system bootloader
open the byte pipe, send 0x7F, wait for ACK          -> AN3155 sync (retry with backoff)
Get (0x00) optional, GetID (0x02)                    -> version (may be unknown) + PID
erase the sectors the image touches (0x44, N = count - 1)
write memory (0x31: command, address+checksum, N-1+data+checksum, padded to 4 bytes)
GO 0x08000000 (or RUN: BOOT0 low + pulse)            -> application runs
```

Only the sectors the image occupies are erased, so the rest of the flash survives. A failed flash
still leaves a valid backup area; keep SWD (ST-Link) available for recovery.

## Port collision warning

Many boards wire PA9/PA10 to an on-board CH340. If both the CH340 and the ESP drive the same line,
the bootloader sees two transmitters. Options:

1. Route the ESP to **USART3 (PB10/PB11)** on F4 parts, or USART2 on F1.
2. Lift/disable the CH340 TX pin.
3. Use one at a time (the plugin stops the serial monitor before a flash, but the CH340 still drives).

## Status

0.2.0 ships the Wi-Fi transport end to end (verified on an STM32F407VE with an ESP-12E: build,
erase, write, verify, run - no button press), the wireless serial monitor and ESP discovery.
