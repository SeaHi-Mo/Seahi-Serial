#!/usr/bin/env python3
"""Seahi Serial Bridge - 通过 stdin/stdout JSON 管道提供可靠的串口 I/O
Rust 后端通过管道发送 JSON 命令，此脚本返回 JSON 响应。
无网络依赖，进程生命周期由 Rust 管理。
"""
import sys, json, os, struct, base64, time

try:
    import serial
except ImportError:
    serial = None

try:
    import fcntl
except ImportError:
    fcntl = None

TIOCMBIS = 0x5416
TIOCMBIC = 0x5417
TIOCM_DTR = 0x002
TIOCM_RTS = 0x004

ports = {}  # monitor_id -> serial.Serial or fd

def ensure_device_perm(path):
    """确保串口设备可读写"""
    # 尝试直接 chmod（不需要密码）
    try:
        os.chmod(path, 0o666)
        return True
    except PermissionError:
        pass
    # 尝试 sudo chmod（可能需要密码）
    import subprocess
    try:
        r = subprocess.run(["sudo", "-n", "chmod", "666", path],
                           timeout=3, capture_output=True)
        if r.returncode == 0:
            return True
    except Exception:
        pass
    # 尝试 pkexec（图形密码对话框）
    try:
        r = subprocess.run(["pkexec", "chmod", "666", path],
                           timeout=30, capture_output=True)
        if r.returncode == 0:
            return True
    except Exception:
        pass
    # 全部失败，返回错误信息
    return False

def open_port(mid, path, baud):
    close_port(mid)
    if serial is not None:
        try:
            s = serial.Serial(port=path, baudrate=baud, timeout=0, write_timeout=0)
            s.reset_input_buffer()
            ports[mid] = s
            return True, ""
        except PermissionError:
            # 权限不足，尝试 chmod 修复
            import subprocess
            try:
                subprocess.run(["sudo", "-n", "chmod", "666", path], timeout=3, capture_output=True)
            except Exception:
                pass
            # 重试一次
            try:
                s = serial.Serial(port=path, baudrate=baud, timeout=0, write_timeout=0)
                s.reset_input_buffer()
                ports[mid] = s
                return True, ""
            except Exception as e:
                return False, f"无权访问 {path}，请在 WSL 终端执行: sudo chmod 666 {path}"
        except Exception as e:
            return False, str(e)
    else:
        try:
            fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
            os.system(f"stty -F {path} {baud} raw -echo 2>/dev/null")
            ports[mid] = fd
            return True, ""
        except PermissionError:
            import subprocess
            try:
                subprocess.run(["sudo", "-n", "chmod", "666", path], timeout=3, capture_output=True)
            except Exception:
                pass
            try:
                fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                os.system(f"stty -F {path} {baud} raw -echo 2>/dev/null")
                ports[mid] = fd
                return True, ""
            except Exception as e:
                return False, f"无权访问 {path}，请在 WSL 终端执行: sudo chmod 666 {path}"
        except Exception as e:
            return False, str(e)

def close_port(mid):
    p = ports.pop(mid, None)
    if p is None:
        return
    try:
        if hasattr(p, 'close'):
            p.close()
        elif isinstance(p, int):
            os.close(p)
    except:
        pass

def read_port(mid, maxn=4096):
    p = ports.get(mid)
    if p is None:
        return None, "port not open"
    try:
        if hasattr(p, 'read'):
            return p.read(maxn), ""
        elif isinstance(p, int):
            try:
                return os.read(p, maxn), ""
            except BlockingIOError:
                return b"", ""
    except Exception as e:
        return None, str(e)
    return b"", ""

def write_port(mid, data):
    p = ports.get(mid)
    if p is None:
        return False, "port not open", 0
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
    return False, "error", 0

def set_signal(mid, sig, level):
    p = ports.get(mid)
    if p is None:
        return False, "port not open"
    try:
        if hasattr(p, 'fd'):
            fd = p.fd
        elif isinstance(p, int):
            fd = p
        else:
            return False, "unsupported"
        mask = TIOCM_DTR if sig == "dtr" else TIOCM_RTS
        ioc = TIOCMBIS if level else TIOCMBIC
        if fcntl:
            fcntl.ioctl(fd, ioc, struct.pack('I', mask))
            return True, ""
        return False, "fcntl not available"
    except Exception as e:
        return False, str(e)

def handle(req):
    cmd = req.get("cmd", "")
    try:
        if cmd == "open":
            ok, err = open_port(req["id"], req["path"], req["baud"])
            return {"ok": ok, "error": err}
        elif cmd == "close":
            close_port(req["id"])
            return {"ok": True}
        elif cmd == "read":
            data, err = read_port(req["id"], req.get("max", 4096))
            if data is None:
                return {"ok": False, "error": err}
            return {"ok": True, "data": base64.b64encode(data).decode()}
        elif cmd == "write":
            data = base64.b64decode(req["data"])
            ok, err, n = write_port(req["id"], data)
            return {"ok": ok, "error": err, "n": n}
        elif cmd in ("dtr", "rts"):
            ok, err = set_signal(req["id"], cmd, req["level"])
            return {"ok": ok, "error": err}
        elif cmd == "ping":
            return {"ok": True}
        else:
            return {"ok": False, "error": f"unknown cmd: {cmd}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# Signal readiness on stderr so Rust knows we're ready
sys.stderr.write("ready\n")
sys.stderr.flush()

# Main loop: read JSON from stdin, write JSON to stdout
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        resp = handle(req)
    except json.JSONDecodeError as e:
        resp = {"ok": False, "error": f"json error: {e}"}
    except Exception as e:
        resp = {"ok": False, "error": str(e)}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
