# zcode-speed-bar

给 Windows 版 ZCode 添加生成速度显示：在对话窗口底部显示 `⚡ 42.3 t/s`，并在子智能体任务行旁显示各自的速度，每 0.5 秒刷新。

工具在 ZCode 进程内通过已有的会话连接读取实时状态，不读取账号凭据，也不导出消息正文；远程会话使用 ZCode 已有的远程连接。安装会修改 ZCode 的 `resources/app.asar`，属于非官方改动。

## 数值怎么看

- **生成中**：根据最近约 2 秒的输出字符增量估算 token/s，包含回答、思考和工具输入；不统计用户输入或工具返回内容。
- **一轮结束后**：若 ZCode 提供有效的输出 token 数和模型耗时，显示该轮平均速度；否则可能保留最近的估算值。
- **显示 `—`**：正在建立采样基线，或当前没有可用数据。生成暂停时速度会降至 `0.0`；等待前台工具且没有并行模型输出时也显示 `0.0`。

主会话、辅助会话和子智能体各自独立采样，使用相同的测速规则。子智能体执行工具时显示 `0.0 t/s`；尚未获得数据或无法可靠关联任务时显示 `— t/s`。已完成且未被本工具采样过的历史任务可能没有读数。生成中的估算值不等同于模型服务端的精确测速。

## 安装

准备 Windows 版 ZCode **3.17.1 或更高版本**、Python 3.8+ 和可在命令行调用的 Node.js。Python 只使用标准库，Node.js 用于安装时的语法检查，无需安装项目依赖。目前仅登记了 ZCode **3.17.1**；较新版本也须先适配并验证，以 [targets.json](skill/zcode-speed-repair/scripts/targets.json) 为准。

安装前脚本会检查目标 ZCode 的实际版本；低于 3.17.1 或无法识别版本时，输出 `state: skipped` 并停止，不会写入运行文件或安装包。

在 PowerShell 中执行：

```powershell
git clone https://github.com/TTT1231/zcode-speed-bar.git
cd zcode-speed-bar
python repair-speed.py install
```

`python` 不可用时可换成 `py -3`。工具会通过 Windows 注册表和常见路径寻找安装目录；自动定位失败或发现多份安装时，会要求指定实际路径：

```powershell
python repair-speed.py install --asar "D:\soft\ZCode\resources\app.asar"
```

完成后完全退出 ZCode（包括托盘）再打开。若输出 `pending-until-ZCode-exits`，表示替换正在等待文件解锁：先退出 ZCode，等后台替换完成后再启动，不要重复安装。安装完成可用下面的 `check` 确认 `pending: false`。

打开一个会话，应能看到悬浮条。检查安装文件：

```powershell
python repair-speed.py check
```

正常结果为 `bridge: true`、`loader: true`、`pending: false`，退出码为 `0`。自定义安装路径时，检查和卸载也使用同一个 `--asar`。如果提示版本未登记或指纹不匹配，先确认版本和安装来源，不要强制登记以绕过校验。

## 更新与修复

在源码仓库目录执行：

```powershell
git pull
python repair-speed.py install
```

完全退出并重开 ZCode。官方升级若覆盖了注入，也按此流程恢复；新版本须先适配并验证，不能仅凭版本号登记。悬浮条不出现、持续显示 `—` 或安装报错时，运行 `check`，并查看 `~/.zcode/zcode-speed/` 下的 `status.json` 和 `debug.log`。

## 卸载

从源码仓库执行：

```powershell
python repair-speed.py remove
```

等待替换完成，再完全退出并重开 ZCode，确认悬浮条消失。正常卸载会移除注入并清理 `~/.zcode/zcode-speed/` 中的运行副本、状态和备份；不要提前删除这个目录。

未登记版本通过 `--force` 剥离桥接时会保留备份；从运行目录执行脚本或文件清理失败时，也可能留下文件。备份保存的是修改前的目标文件，不是完整 ASAR；移除注入也不等于恢复整个官方安装包的逐字节副本。

## 给 agent 使用

将 [skill/zcode-speed-repair](skill/zcode-speed-repair/) 整个目录复制到 agent 的技能目录，即可使用安装、检查和卸载功能；脚本和所需文件都在技能目录内，不需要保留源码仓库。

## 进一步阅读

- [AGENTS.md](AGENTS.md)：仓库职责划分与修改约束。
- [修复技能](skill/zcode-speed-repair/SKILL.md)：供 agent 执行安装、更新、检查和卸载。
