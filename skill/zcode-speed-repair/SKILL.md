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
node scripts/repair-speed.cjs install  # 安装、更新或修复
node scripts/repair-speed.cjs check    # 检查安装状态
node scripts/repair-speed.cjs verify   # 查看自动识别结果（只读诊断）
node scripts/repair-speed.cjs remove   # 卸载
```

- 无法确定安装位置时，追加 `--asar "实际路径/resources/app.asar"`。
- 安装或卸载后，完全退出 ZCode 重新启动。若 `pending: true`，先退出并等待，不要重复执行。
- 若报告含 `waiter: "detached-fallback"`，后台等待进程未能脱离当前进程树：按报告中的 `manualContinue` 命令在本工具退出后手动接续。
