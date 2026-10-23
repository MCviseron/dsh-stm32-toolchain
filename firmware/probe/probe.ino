/* Diagnostic sketch: does this module join W14917 with a bare STA init?
 * Prints to UART0 at 115200 so the PC can watch it. Not part of the plugin. */
#include <ESP8266WiFi.h>

#ifndef WIFI_SSID
#define WIFI_SSID "W14917"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "12345678"
#endif

static const char *reason(int s) {
  switch (s) {
    case 0: return "idle";
    case 1: return "no-ssid";
    case 3: return "connected";
    case 4: return "connect-failed";
    case 5: return "connection-lost";
    case 6: return "wrong-password";
    default: return "disconnected";
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("[probe] booted, free heap=" + String(ESP.getFreeHeap()));
  Serial.println("[probe] chip=" + String(ESP.getChipId(), HEX) + " flash=" + String(ESP.getFlashChipRealSize() / 1024) + "KB");
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  Serial.println("[probe] joining " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  static uint32_t last = 0;
  static int shown = -1;
  int s = (int)WiFi.status();
  if (s != shown || millis() - last > 2000) {
    shown = s;
    last = millis();
    Serial.print("[probe] t="); Serial.print(millis() / 1000);
    Serial.print("s status="); Serial.print(s);
    Serial.print(" ("); Serial.print(reason(s)); Serial.print(")");
    if (s == WL_CONNECTED) {
      Serial.print(" ip=" + WiFi.localIP().toString());
      Serial.print(" rssi=" + String(WiFi.RSSI()));
      Serial.print(" ch=" + String(WiFi.channel()));
    } else {
      Serial.print(" seen=" + String(WiFi.SSID()));
    }
    Serial.println();
  }
  delay(100);
}
