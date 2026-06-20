import socket, json
s = socket.socket()
s.connect(('127.0.0.1', 19876))
s.sendall(b'{"cmd":"ping"}\n')
resp = s.recv(4096).decode()
print('ping response:', resp.strip())
s.close()
