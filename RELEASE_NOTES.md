## 🔧 改进

- **WSL 串口桥接架构** — 用 Python bridge 脚本替代不可靠的 cat 管道和 TCP daemon，通过 stdin/stdout 管道通信
- **WSL 发行版自动检测** — 自动识别运行中的发行版并使用，未运行时自动启动默认发行版
- **WSL 持久化 shell** — 保持一个 WSL bash 进程存活，设备列表查询从 300ms 降到 ms 级
- **WSL 串口端口自动刷新** — 映射/断开映射后自动刷新端口列表
- **WSL 发行版卡片水平布局** — 发行版信息卡片靠右排列，标题与卡片间距优化
- **全面代码评审修复** — 前后端 60+ 问题修复，覆盖性能、UX、UI
- **WSL 输出编码修复** — 正确处理 UTF-16LE 和 UTF-32LE 编码
- **read_data 循环读取** — 一次读取所有可用数据
- **波特率选项扩展** — 从 16 个增加到 33 个（50 ~ 4,000,000）
- **连接速度优化** — 缓存发行版名称、跳过重复部署
- **error toast 手动关闭** — 错误消息不再自动消失
- **关闭监视器确认弹窗** — 防止误操作丢数据
- **焦点可见性样式** — 添加 :focus-visible 支持
- **色彩对比度修复** — 修复多处 WCAG AA 不达标的颜色
- **端口刷新保留选择** — 刷新后不再重置为第一个端口

## 🐛 修复

- 修复 WSL 发行版状态全部显示为"运行中"的编码解析错误
- 修复 WSL 设备权限问题（自动 chmod + sg dialout）
- 修复 WSL 发行版卡片渲染残留代码导致 ReferenceError 崩溃
- 修复 get_wsl_shell TOCTOU 竞态（并发创建多个 shell）
- 修复 wsl_shell_exec EOF 死循环（进程退出时 CPU 100%）
- 修复 bridge_command 进程退出时无检测
- 修复 CACHED_DISTRO 连接失败时永不失效
- 修复行号列宽被误改为 3.5em 导致显示异常
- 修复 WSL 设备行 hover 闪烁（inline JS → CSS :hover）
- 修复复制输出包含行号的问题
- 修复 CI/CD 发布为预发布版的问题

## 📦 下载

| 文件 | 说明 |
|------|------|
| `Seahi-Serial-Setup-{VERSION}.exe` | Inno Setup 安装程序（推荐） |
| `Seahi.Serial_{VERSION}_x64_en-US.msi` | MSI 安装包 |
