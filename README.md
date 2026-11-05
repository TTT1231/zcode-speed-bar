# zcode-speed-bar

给 Windows 版 ZCode 添加生成速度悬浮条，在对话窗口底部显示 `⚡ 42.3 t/s`，每 0.5 秒刷新。

工具在 ZCode 进程内读取实时会话状态，不发起网络请求、不读取账号凭据，也不导出消息正文。安装会修改 ZCode 的 `resources/app.asar`，属于非官方改动。

## 数值怎么看

- **生成中**：根据最近约 2 秒的输出字符增量估算 token/s，包含回答、思考和工具输入；不统计用户输入或工具返回内容。
- **一轮结束后**：若 ZCode 提供有效的输出 token 数和模型耗时，显示该轮平均速度；否则可能保留最近的估算值。
- **显示 `—`**：正在建立采样基线，或当前没有可用数据。生成暂停时速度会降至 `0.0`；等待前台工具且没有并行模型输出时也显示 `0.0`。

各会话独立采样。主会话和辅助会话可以并行生成，各自在自己的会话区域底部显示速度；任一会话结束后，另一会话仍继续显示自己的实时速度。生成中的估算值不等同于模型服务端的精确测速。

## 安装

准备 Windows 版 ZCode、Python 3.8+ 和可在命令行调用的 Node.js。Python 只使用标准库，Node.js 用于安装时的语法检查，无需安装项目依赖。当前登记的 ZCode 版本是 **3.17.1**，以 [targets.json](targets.json) 为准。

在 PowerShell 中执行：

```powershell
git clone https://github.com/TTT1231/zcode-speed-bar.git
cd zcode-speed-bar
python repair-speed.py install
```

`python` 不可用时可换成 `py -3`。工具会通过 Windows 注册表和常见路径寻找安装目录；自动定位失败或存在多份安装时，指定实际路径：

```powershell
python repair-speed.py install --asar "D:\soft\ZCode\resources\app.asar"
```

完成后完全退出 ZCode（包括托盘）再打开。若输出 `pending-until-ZCode-exits`，表示替换正在等待文件解锁：先退出 ZCode，等后台替换完成后再启动，不要重复安装。查看 [pending 处理](docs/maintenance.md#诊断与-pending)。

打开一个会话，应能看到悬浮条。检查安装文件：

```powershell
python repair-speed.py check
```

正常结果为 `bridge: true`、`loader: true`、`pending: false`，退出码为 `0`。自定义安装路径时，检查和卸载也使用同一个 `--asar`。若提示版本未登记，见 [新版本适配](docs/maintenance.md#新版本适配)。

## 更新与修复

在源码仓库目录执行：

```powershell
git pull
python repair-speed.py install
```

完全退出并重开 ZCode。官方升级若覆盖了注入，也按此流程恢复；新版本须先在 `targets.json` 登记并验证。悬浮条不出现、持续显示 `—` 或安装报错时，按 [维护文档](docs/maintenance.md#诊断与-pending) 排查。

## 卸载

从源码仓库执行：

```powershell
python repair-speed.py remove
```

等待替换完成，再完全退出并重开 ZCode，确认悬浮条消失。正常卸载会移除注入并清理 `~/.zcode/zcode-speed/` 中的运行副本、状态和备份；不要提前删除这个目录。

未登记版本通过 `--force` 剥离桥接时会保留备份；从运行目录执行脚本或文件清理失败时，也可能留下文件。处理方法及还原范围见 [卸载与备份](docs/maintenance.md#卸载与备份)。

## 进一步阅读

- [维护文档](docs/maintenance.md)：命令、状态文件、排错、新版本适配与开发验证。
- [AGENTS.md](AGENTS.md)：仓库职责划分与修改约束。
- [修复技能](skill/zcode-speed-repair/SKILL.md)：供 agent 执行安装、修复、卸载和版本适配。
