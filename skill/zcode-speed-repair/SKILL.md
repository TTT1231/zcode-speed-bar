---
name: zcode-speed-repair
description: 安装、更新、检查或卸载 Windows ZCode 的生成速度悬浮条。
---

# ZCode 速度悬浮条

环境：Windows、Python 3.8+、Node.js 20+。ZCode 最低 3.17.1，且须已适配。

在本技能目录执行：

```powershell
python scripts/repair-speed.py install  # 安装、更新或修复
python scripts/repair-speed.py check    # 检查安装状态
python scripts/repair-speed.py remove   # 卸载
```

- 无法确定安装位置时，追加 `--asar "实际路径\resources\app.asar"`。
- 安装或卸载后，完全退出 ZCode（包括托盘）再启动。若 `pending: true`，先退出并等待，不要重复执行。
- 失败或跳过时报告脚本输出，不用 `--force` 或重新登记版本绕过校验。
