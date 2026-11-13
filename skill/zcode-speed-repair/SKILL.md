---
name: zcode-speed-repair
description: 安装、更新、检查或卸载 ZCode 的生成速度悬浮条（Windows/Linux/macOS）。
---

# ZCode 速度悬浮条

| 环境    | 要求      |
| ------- | --------- |
| Node.js | node      |
| ZCode   | v3.17.1 + |

在本技能目录执行：

```powershell
node scripts/repair-speed.cjs install    # 安装、更新或修复
node scripts/repair-speed.cjs uninstall  # 卸载
node scripts/repair-speed.cjs check      # 检查安装状态
node scripts/repair-speed.cjs verify     # 查看自动识别结果（只读诊断）
```

- 每条命令只输出一行结果；追加 `--debug` 输出完整报告和错误堆栈。
- 无法确定安装位置时，追加 `--asar "实际路径/resources/app.asar"`。
- ZCode 升级会整体替换 `app.asar`，注入随之丢失：升级后重新执行 `install`。
- 安装或卸载后，完全退出 ZCode 重新启动。ZCode 运行中时，结果提示会在其退出后完成；上一次未完成的任务由下一次 `install` 或 `uninstall` 接管，以最后一次命令为准。
- 若结果提示给出手动接续命令（后台等待进程未能脱离当前进程树），在本工具退出后执行该命令。
