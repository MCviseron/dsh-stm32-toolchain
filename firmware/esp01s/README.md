# ESP-01S Wi-Fi bridge (0.2.0)

Firmware for an ESP-01S (ESP8266, 1 MB) that lets the PC flash and talk to an STM32
over Wi-Fi instead of USB - the transport behind `transport: wifi` in the plugin.

The ESP joins a hotspot (and falls back to its own AP if it cannot), exposes **two**
TCP servers, and drives the STM32 reset lines so the system bootloader can be entered
without touching the board.

| Port | Direction | Purpose |
| --- | --- | --- |
| 3333 | text, line based | control: `BOOT 0|1`, `NRST 0|1`, `PULSE [ms]`, `BOOTLOADER`, `RUN`, `STATUS`, `PING`, `REBOOT` |
| 3334 | raw bytes | transparent pipe to the ESP UART0 (115200 8N1) = the STM32 USART |

## Wiring

### ESP-01S to the STM32 (the product side)

| ESP-01S | STM32 | Note |
| --- | --- | --- |
| TX (GPIO1) | USART RX (PA10) | cross over |
| RX (GPIO3) | USART TX (PA9) | cross over |
| GND | GND | common ground is mandatory |
| 3V3 | 3V3 | **>= 300 mA peak**, 100 uF close to the module |
| GPIO2 | BOOT0 | firmware pin `PIN_BOOT0` (2) |
| GPIO0 | NRST | firmware pin `PIN_NRST` (0), **10k pull-up required** |

`GPIO0` must be HIGH while the ESP boots, otherwise it enters flash mode and never
runs the sketch. Put a 10k resistor from GPIO0 to 3V3 - do not rely on the STM32 NRST
pin to hold it high (that pin is driven low by the MCU during its own reset).

An ESP-01S cannot drive BOOT0/NRST directly if the STM32 side has strong pull-ups/downs
fighting it; measure first, add a 1k series resistor if needed.

### Flashing the ESP-01S itself (USB-TTL, 3.3 V only - never 5 V)

| USB-TTL | ESP-01S |
| --- | --- |
| TXD | RX |
| RXD | TX |
| GND | GND |
| 3V3 | 3V3 + CH_PD (EN) |
| GND (jumper) | GPIO0 - only while powering up, to enter flash mode |

## Build and flash

The sketch is `esp01s.ino` (Arduino requires the file name to match the folder).
Set the hotspot credentials at the top of the sketch, or build with `-DWIFI_SSID=... -DWIFI_PASS=...`.

```powershell
# compile (ESP8266 Arduino core >= 3.1; verified with 3.1.2)
arduino-cli compile --fqbn 'esp8266:esp8266:generic:eesz=1M,xtal=80' --output-dir firmware/esp01s/build firmware/esp01s

# flash over USB-TTL (GPIO0 grounded at power-up)
arduino-cli upload -p COM5 --fqbn 'esp8266:esp8266:generic:eesz=1M,xtal=80' firmware/esp01s
```

Verified build: 252 KB of flash (24 % of 1 MB).

## Quick check with a TCP client

```powershell
# 1) control port: prove the ESP is alive
"PING" | Send-Tcp -HostIp 192.168.1.50 -Port 3333     # +PONG <ms>
"STATUS"                                              # +STATUS mode=sta ip=... boot0=0 nrst=1 ...
"BOOTLOADER"                                          # BOOT0=1 + reset pulse
```

The plugin does exactly this sequence, then opens port 3334 and speaks AN3155 to the
STM32, and finally sends `RUN` to leave the bootloader.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| ESP prints garbage at 74880 baud, no TCP | sketch never ran: GPIO0 was low at boot |
| Connects, then drops on every flash | 3V3 rail cannot supply the ESP current peaks - add a bulk capacitor / stronger regulator |
| `+READY mode=ap` | it could not join the hotspot within 15 s; connect the PC to `STM32-ESP01S` / `stm32flash` |
| Pipe data appears but the STM32 does not answer | TX/RX not crossed, or BOOT0 never went high (check `STATUS` while asserting it) |
