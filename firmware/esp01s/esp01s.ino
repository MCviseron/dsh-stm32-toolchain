/*
 * dsh-stm32-toolchain - ESP-01S (ESP8266) Wi-Fi bridge for STM32 UART flashing
 *
 * Two TCP servers:
 *   CTRL_PORT (3333) - line based control: BOOT0 / NRST / reset pulses / status
 *   PIPE_PORT (3334) - raw bidirectional pipe to the ESP's UART0 (STM32 USART)
 *
 * Wiring (ESP-01S is 3.3 V only):
 *   ESP TX  -> STM32 USART RX (PA10 on F411 / F407 USART1)
 *   ESP RX  -> STM32 USART TX (PA9)
 *   GND     -> common ground
 *   3V3     -> 3V3 rail (>= 300 mA, 100 uF close to the module)
 *   GPIO2   -> STM32 BOOT0      (pin 2 in this sketch)
 *   GPIO0   -> STM32 NRST       (pin 0 in this sketch; 10k pull-up mandatory,
 *                                GPIO0 must be HIGH at boot or the ESP enters flash mode)
 *
 * The ESP never prints to UART0 except the transparent payload: debug text goes to
 * the CTRL socket instead, so the pipe stays byte clean for AN3155.
 */

#include <ESP8266WiFi.h>
#include <stdarg.h>

/* ------------------------- user configuration ------------------------- */
#ifndef WIFI_SSID
#define WIFI_SSID "YOUR_HOTSPOT"      /* join a hotspot (STA) */
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "YOUR_PASSWORD"
#endif
#define AP_SSID          "STM32-ESP01S"   /* fallback access point */
#define AP_PASS          "stm32flash"
#define STA_TIMEOUT_MS   15000

#define PIN_BOOT0        2                /* GPIO2 -> BOOT0 */
#define PIN_NRST         0                /* GPIO0 -> NRST  */
#define PIPE_BAUD        115200
#define CTRL_PORT        3333
#define PIPE_PORT        3334
#define PULSE_MS_DEFAULT 100
/* ---------------------------------------------------------------------- */

WiFiServer ctrlServer(CTRL_PORT);
WiFiServer pipeServer(PIPE_PORT);
WiFiClient ctrlClient;
WiFiClient pipeClient;

static uint32_t ctrlCount = 0;
static uint32_t pipeBytesDown = 0;   /* TCP -> UART */
static uint32_t pipeBytesUp = 0;     /* UART -> TCP */

static const char *modeName(void)
{
  return (WiFi.getMode() == WIFI_AP) ? "ap" : "sta";
}

static void ctrlPrintf(const char *fmt, ...)
{
  if (!ctrlClient || !ctrlClient.connected()) return;
  char buf[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  ctrlClient.print(buf);
}

static void boot0Set(int level) { digitalWrite(PIN_BOOT0, level ? HIGH : LOW); }
static void nrstSet(int level)  { digitalWrite(PIN_NRST, level ? HIGH : LOW); }

static void nrstPulse(uint32_t ms)
{
  nrstSet(0);
  delay(ms);
  nrstSet(1);
}

static String ipString(void)
{
  return (WiFi.getMode() == WIFI_AP) ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
}

static void banner(void)
{
  ctrlPrintf("+READY mode=%s ip=%s boot0=%d nrst=%d baud=%d pipe=%d\r\n",
             modeName(), ipString().c_str(), digitalRead(PIN_BOOT0), digitalRead(PIN_NRST),
             PIPE_BAUD, PIPE_PORT);
}

/** Handle one control line (without the trailing CR/LF). */
static void handleCommand(String line)
{
  line.trim();
  if (line.length() == 0) return;
  ctrlCount++;

  if (line.equalsIgnoreCase("PING")) {
    ctrlPrintf("+PONG %lu\r\n", (unsigned long)millis());
    return;
  }
  if (line.startsWith("BOOT ")) {
    int v = line.substring(5).toInt() ? 1 : 0;
    boot0Set(v);
    ctrlPrintf("+BOOT %d\r\n", v);
    return;
  }
  if (line.startsWith("NRST ")) {
    int v = line.substring(5).toInt() ? 1 : 0;
    nrstSet(v);
    ctrlPrintf("+NRST %d\r\n", v);
    return;
  }
  if (line.startsWith("PULSE")) {
    uint32_t ms = (line.length() > 5) ? (uint32_t)line.substring(6).toInt() : PULSE_MS_DEFAULT;
    if (ms < 20) ms = 20;
    if (ms > 2000) ms = 2000;
    nrstPulse(ms);
    ctrlPrintf("+PULSE %lu\r\n", (unsigned long)ms);
    return;
  }
  if (line.equalsIgnoreCase("BOOTLOADER")) {   /* BOOT0=1 then reset: STM32 system bootloader */
    boot0Set(1);
    nrstPulse(PULSE_MS_DEFAULT);
    ctrlPrintf("+BOOTLOADER\r\n");
    return;
  }
  if (line.equalsIgnoreCase("RUN")) {          /* BOOT0=0 then reset: user application */
    boot0Set(0);
    nrstPulse(PULSE_MS_DEFAULT);
    ctrlPrintf("+RUN\r\n");
    return;
  }
  if (line.equalsIgnoreCase("STATUS")) {
    ctrlPrintf("+STATUS mode=%s ip=%s rssi=%d boot0=%d nrst=%d pipe=%s cmds=%lu rx=%lu tx=%lu up=%lu\r\n",
               modeName(), ipString().c_str(), WiFi.RSSI(),
               digitalRead(PIN_BOOT0), digitalRead(PIN_NRST),
               (pipeClient && pipeClient.connected()) ? "on" : "off",
               (unsigned long)ctrlCount, (unsigned long)pipeBytesDown,
               (unsigned long)pipeBytesUp, (unsigned long)(millis() / 1000));
    return;
  }
  if (line.equalsIgnoreCase("REBOOT")) {
    ctrlPrintf("+REBOOT\r\n");
    delay(50);
    ESP.restart();
  }
  ctrlPrintf("+ERR unknown\r\n");
}

void setup()
{
  Serial.setRxBufferSize(1024);
  Serial.begin(PIPE_BAUD);
  Serial.setDebugOutput(false);

  pinMode(PIN_BOOT0, OUTPUT);
  pinMode(PIN_NRST, OUTPUT);
  boot0Set(0);          /* normal boot: run the application */
  nrstSet(1);           /* released (NRST is active low) */

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < STA_TIMEOUT_MS) {
    delay(200);
  }
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
  }

  ctrlServer.begin();
  ctrlServer.setNoDelay(true);
  pipeServer.begin();
  pipeServer.setNoDelay(true);
}

void loop()
{
  /* ---- accept one client per service ---- */
  if (!ctrlClient || !ctrlClient.connected()) {
    WiFiClient fresh = ctrlServer.available();
    if (fresh) {
      ctrlClient = fresh;
      ctrlClient.setNoDelay(true);
      banner();
    }
  }
  if (!pipeClient || !pipeClient.connected()) {
    WiFiClient fresh = pipeServer.available();
    if (fresh) {
      pipeClient = fresh;
      pipeClient.setNoDelay(true);
      while (Serial.available()) Serial.read();   /* drop stale bytes */
    }
  }

  /* ---- control: line oriented ---- */
  if (ctrlClient && ctrlClient.connected()) {
    while (ctrlClient.available()) {
      String line = ctrlClient.readStringUntil('\n');
      handleCommand(line);
    }
  }

  /* ---- pipe: bytes both ways ---- */
  if (pipeClient && pipeClient.connected()) {
    uint8_t buf[128];
    size_t n = 0;
    while (pipeClient.available() && n < sizeof(buf)) {
      buf[n++] = (uint8_t)pipeClient.read();
    }
    if (n > 0) {
      Serial.write(buf, n);
      Serial.flush();
      pipeBytesDown += n;
    }
    n = 0;
    while (Serial.available() && n < sizeof(buf)) {
      buf[n++] = (uint8_t)Serial.read();
    }
    if (n > 0) {
      pipeClient.write(buf, n);
      pipeBytesUp += n;
    }
  }
  yield();
}
