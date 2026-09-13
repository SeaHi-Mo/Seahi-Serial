# seahi-serial-mcp

把 **SeaHi Serial** 暴露的 MCP 端点写进 AI 客户端的配置里。

> ⚠️ 这个包**不是 MCP 服务器**。真正的服务器跑在 SeaHi Serial 应用进程内（只监听回环地址、只用 SSE）。
> 本包只做一件事：**配置**。它零运行时依赖、没有 `postinstall`、不下载任何东西。

## 为什么需要它

SeaHi Serial 默认端口是 `7777`，被占用时会自动向后回退。一旦端口变了，之前粘进客户端的 URL 就失效了。
手工改要逐个客户端翻配置文件；重跑一次本工具就全修好了：

```bash
npx seahi-serial-mcp install
```

**幂等修正**才是它的核心价值，而不只是"首次安装"。

## 用法

```bash
npx seahi-serial-mcp                  # 等价于 install
npx seahi-serial-mcp status           # 应用在不在跑、各客户端配没配、URL 过期没有
npx seahi-serial-mcp uninstall        # 只移除本工具写进去的那一条
```

| 选项 | 说明 |
|---|---|
| `--client claude,cursor` | 只处理指定客户端；省略时只处理**已经装了**的那些 |
| `--url <url>` | 手动指定端点（跳过发现文件与探活） |
| `--dry-run` | 只显示将要做什么，不写盘 |
| `--json` | 机器可读输出 |

退出码：`0` 成功 · `1` 参数错 · `2` 应用没在跑 · `3` 没找到客户端 · `4` 有文件被拒绝写入（其余照常）。

## 各客户端的候选配置路径

⚠️ **这些路径需要按你本机的实际安装情况核实**（各客户端版本可能不同）。`status` 会把"文件是否存在、是否已配置、URL 是否过期"逐条打出来。

| client | 客户端 | 候选路径 |
|---|---|---|
| `claude` | Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| `claudecode` | Claude Code | `~/.claude.json` |
| `cursor` | Cursor（全局） | `~/.cursor/mcp.json` |
| `vscode` | VS Code（**当前工作区**） | `<当前目录>/.vscode/mcp.json` |

`vscode` 是工作区作用域的，**不会**在你没显式指定时被写入（免得往当前目录乱写文件）。

也可以用环境变量覆盖某个客户端的路径（多环境/自测用）：
`SEAHI_MCP_CLAUDE_CONFIG` / `SEAHI_MCP_CLAUDECODE_CONFIG` / `SEAHI_MCP_CURSOR_CONFIG` / `SEAHI_MCP_VSCODE_CONFIG`，
以及 `SEAHI_ENDPOINT_FILE`（发现文件路径）、`SEAHI_CONFIG_DIR`（配置目录）。

## 它写了什么

只动**我们自己那一把键**：

```json
{
  "mcpServers": {
    "seahi-serial": { "type": "sse", "url": "http://127.0.0.1:7777/sse?token=…" }
  }
}
```

其它 MCP server 条目、以及文件里的其它键，一律原样保留。

## 安全约定

1. **写之前先探活**：读 `%APPDATA%\seahi-serial\mcp-endpoint.json`，确认 pid 还活着、`/healthz` 有响应。
   **应用没在跑就拒绝写入** —— 不给你塞一个连不上的地址。
2. **先备份、再原子写**：备份为 `<文件名>.seahi-bak-<时间戳>`，每个文件最多留 5 份；写入用临时文件 + rename，
   不会出现"写到一半"的半截文件。
3. **含注释的文件（JSONC）不硬改**：解析不了就打印可粘贴片段并以退出码 4 结束，**绝不破坏你的文件**。
4. **幂等**：已经是目标 URL 就明说"无需修改"，连 mtime 都不动。
5. **token 打码**：打印出来的 URL 只留 token 末 4 位，避免泄进终端回滚缓冲或 AI 对话记录。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `找不到端点发现文件` | 应用没在运行，或 MCP 服务器被关掉了（点标题栏的 MCP 图标打开） |
| `应用没有响应` | 应用刚被关掉，或端口被别的程序占了；重开应用再看 `status` |
| `没找到已安装的客户端配置文件` | 用 `--client` 显式指定；或先用 `status` 看候选路径对不对 |
| `配置文件含注释` | 按打印出的片段手工合并（本工具不解析 JSONC） |
| 客户端连不上 | 先 `status` 看"是否指向当前端点"；URL 过期就重跑 `install`，然后**重启客户端** |

## 开发

```bash
node test/self-test.js     # 无依赖自测（临时目录 + 本地探活服务，不碰你的真实配置）
```
