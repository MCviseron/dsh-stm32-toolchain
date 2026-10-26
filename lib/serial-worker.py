#!/usr/bin/env python3
"""Line-oriented serial worker for the DSH STM32 bridge.

stdin  : one JSON object per line  {"op":"open","port":"COM7","baud":115200}
stdout : one JSON object per line  {"t":"data","b64":"..."} / {"t":"ok",...} / {"t":"err","msg":...}

A reader thread streams every received byte chunk as base64; the JS side owns
protocol timing, so this process stays dumb on purpose.
"""
import base64
import json
import sys
import threading
import time

try:
    import serial
except Exception as exc:  # pragma: no cover - reported to the host
    print(json.dumps({"t": "fatal", "msg": "pyserial missing: %s" % exc}), flush=True)
    sys.exit(2)

_lock = threading.Lock()
_port = None
_stop = threading.Event()


def emit(obj):
    with _lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def reader(port):
    while not _stop.is_set():
        try:
            data = port.read(max(1, port.in_waiting or 1))
        except Exception as exc:
            emit({"t": "err", "msg": "read failed: %s" % exc, "fatal": True})
            return
        if data:
            emit({"t": "data", "b64": base64.b64encode(data).decode()})
        else:
            time.sleep(0.002)


def main():
    global _port
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            cmd = json.loads(raw)
        except Exception:
            emit({"t": "err", "msg": "bad json"})
            continue
        op = cmd.get("op")
        if op == "open":
            try:
                # the STM32 ROM bootloader speaks 8E1; 8N1 silently drops bytes with an even number of 1s
                _port = serial.Serial(
                    cmd["port"],
                    int(cmd.get("baud", 115200)),
                    bytesize=serial.EIGHTBITS,
                    parity=serial.PARITY_EVEN,
                    stopbits=serial.STOPBITS_ONE,
                    timeout=0.05,
                )
                threading.Thread(target=reader, args=(_port,), daemon=True).start()
                emit({"t": "ok", "op": "open", "port": cmd["port"], "baud": int(cmd.get("baud", 115200))})
            except Exception as exc:
                emit({"t": "err", "msg": "open failed: %s" % exc})
        elif op == "write":
            if _port is None:
                emit({"t": "err", "msg": "port not open"})
                continue
            try:
                _port.write(base64.b64decode(cmd["b64"]))
                _port.flush()
                emit({"t": "ok", "op": "write"})
            except Exception as exc:
                emit({"t": "err", "msg": "write failed: %s" % exc})
        elif op == "flush":
            if _port is not None:
                try:
                    _port.reset_input_buffer()
                    emit({"t": "ok", "op": "flush"})
                except Exception as exc:
                    emit({"t": "err", "msg": "flush failed: %s" % exc})
        elif op == "baud":
            if _port is None:
                emit({"t": "err", "msg": "port not open"})
                continue
            try:
                _port.baudrate = int(cmd["baud"])
                emit({"t": "ok", "op": "baud", "baud": int(cmd["baud"])})
            except Exception as exc:
                emit({"t": "err", "msg": "baud failed: %s" % exc})
        elif op == "close":
            _stop.set()
            try:
                if _port is not None:
                    _port.close()
            except Exception:
                pass
            emit({"t": "ok", "op": "close"})
            return
        elif op == "probe":
            emit({"t": "ok", "op": "probe", "ports": [p.device for p in serial.tools.list_ports.comports()] if hasattr(serial, "tools") else []})
        else:
            emit({"t": "err", "msg": "unknown op"})


if __name__ == "__main__":
    main()
