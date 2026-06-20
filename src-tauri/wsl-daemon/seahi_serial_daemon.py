#!/usr/bin/env python3
"""Seahi Serial Daemon - WSL 侧串口 I/O 守护进程
通过 TCP socket 提供可靠的串口读写，替代不可靠的 cat 管道方式。
"""

import json
import os
import signal
import socket
import struct
import sys
import threading
import time

try:
    import serial
except ImportError:
    # 尝试 pyserial，如果不存在则用原生 ioctl
    serial = None

HOST = "0.0.0.0"
PORT = 19876
PID_FILE = "/tmp/seahi-serial-daemon.pid"

# ioctl 常量
TIOCMBIS = 0x5416
TIOCMBIC = 0x5417
TIOCM_DTR = 0x002
TIOCM_RTS = 0x004

# 全局状态
ports = {}  # monitor_id -> serial.Serial or raw fd
lock = threading.Lock()
running = True


def cleanup(signum=None, frame=None):
    global running
    running = False
    with lock:
        for mid, p in list(ports.items()):
            try:
                if hasattr(p, 'close'):
                    p.close()
                elif isinstance(p, int):
                    os.close(p)
            except Exception:
                pass
        ports.clear()
    try:
        os.remove(PID_FILE)
    except Exception:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, cleanup)
signal.signal(signal.SIGINT, cleanup)


def open_port(monitor_id, device_path, baud_rate):
    with lock:
        if monitor_id in ports:
            close_port(monitor_id)

    if serial is not None:
        try:
            s = serial.Serial(
                port=device_path,
                baudrate=baud_rate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0,
                write_timeout=0,
            )
            s.reset_input_buffer()
            with lock:
                ports[monitor_id] = s
            return True, ""
        except Exception as e:
            return False, str(e)
    else:
        # 原生方式：直接 open + stty
        try:
            fd = os.open(device_path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            os.system(f"stty -F {device_path} {baud_rate} raw -echo 2>/dev/null")
            with lock:
                ports[monitor_id] = fd
            return True, ""
        except Exception as e:
            return False, str(e)


def close_port(monitor_id):
    with lock:
        p = ports.pop(monitor_id, None)
    if p is None:
        return
    try:
        if hasattr(p, 'close'):
            p.close()
        elif isinstance(p, int):
            os.close(p)
    except Exception:
        pass


def read_port(monitor_id, max_bytes=4096):
    with lock:
        p = ports.get(monitor_id)
    if p is None:
        return None, "端口未打开"

    try:
        if hasattr(p, 'read'):
            data = p.read(max_bytes)
            return data, ""
        elif isinstance(p, int):
            try:
                data = os.read(p, max_bytes)
                return data, ""
            except BlockingIOError:
                return b"", ""
    except Exception as e:
        return None, str(e)
    return b"", ""


def write_port(monitor_id, data):
    with lock:
        p = ports.get(monitor_id)
    if p is None:
        return False, "端口未打开"

    try:
        if hasattr(p, 'write'):
            n = p.write(data)
            p.flush()
            return True, "", n
        elif isinstance(p, int):
            n = os.write(p, data)
            return True, "", n
    except Exception as e:
        return False, str(e), 0
    return False, "未知错误", 0


def set_signal(monitor_id, signal_type, level):
    """通过 ioctl 设置 DTR/RTS"""
    with lock:
        p = ports.get(monitor_id)
    if p is None:
        return False, "端口未打开"

    try:
        if hasattr(p, 'fd'):
            fd = p.fd
        elif isinstance(p, int):
            fd = p
        else:
            return False, "不支持的端口类型"

        mask = TIOCM_DTR if signal_type == "dtr" else TIOCM_RTS
        ioctl_num = TIOCMBIS if level else TIOCMBIC
        import fcntl
        fcntl.ioctl(fd, ioctl_num, struct.pack('I', mask))
        return True, ""
    except Exception as e:
        return False, str(e)


def handle_request(req):
    cmd = req.get("cmd", "")

    if cmd == "ping":
        return {"ok": True}

    elif cmd == "open":
        ok, err = open_port(req["id"], req["path"], req["baud"])
        return {"ok": ok, "error": err}

    elif cmd == "close":
        close_port(req["id"])
        return {"ok": True}

    elif cmd == "read":
        data, err = read_port(req["id"], req.get("max", 4096))
        if data is None:
            return {"ok": False, "error": err}
        import base64
        return {"ok": True, "data": base64.b64encode(data).decode()}

    elif cmd == "write":
        import base64
        data = base64.b64decode(req["data"])
        ok, err, n = write_port(req["id"], data)
        return {"ok": ok, "error": err, "n": n}

    elif cmd == "dtr":
        ok, err = set_signal(req["id"], "dtr", req["level"])
        return {"ok": ok, "error": err}

    elif cmd == "rts":
        ok, err = set_signal(req["id"], "rts", req["level"])
        return {"ok": ok, "error": err}

    elif cmd == "status":
        with lock:
            open_ids = list(ports.keys())
        return {"ok": True, "open": open_ids}

    else:
        return {"ok": False, "error": f"未知命令: {cmd}"}


def handle_client(conn, addr):
    try:
        conn.settimeout(30)
        buf = b""
        while running:
            try:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line.decode())
                        resp = handle_request(req)
                    except json.JSONDecodeError as e:
                        resp = {"ok": False, "error": f"JSON 解析失败: {e}"}
                    except Exception as e:
                        resp = {"ok": False, "error": str(e)}
                    resp_bytes = json.dumps(resp).encode() + b"\n"
                    conn.sendall(resp_bytes)
            except socket.timeout:
                continue
            except Exception:
                break
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main():
    # 写 PID 文件
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.settimeout(1)
    server.bind((HOST, PORT))
    server.listen(5)

    while running:
        try:
            conn, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
            t.start()
        except socket.timeout:
            continue
        except Exception:
            if running:
                time.sleep(0.1)

    cleanup()


if __name__ == "__main__":
    main()
