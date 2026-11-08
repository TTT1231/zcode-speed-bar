---
name: zcode-speed-repair
description: 安装、更新、检查或卸载 Windows ZCode 的生成速度悬浮条。
---

# ZCode 速度悬浮条

需要已登记的 Windows ZCode 3.17.1 或更高版本、Python 3.8+ 和 Node.js。在本 skill 目录运行对应命令：

```powershell
python scripts/repair-speed.py install  # 安装、更新或修复
python scripts/repair-speed.py remove   # 卸载
python scripts/repair-speed.py check    # 检查安装状态
```

脚本无法确定安装位置时，将 `--asar "实际路径\resources\app.asar"` 加到命令后。安装或卸载成功后，完全退出 ZCode（包括托盘）再启动；若结果显示 `pending: true`，先退出 ZCode 并等待已有操作完成，不要重复运行安装或卸载。

安装前脚本自动检查 ZCode 版本，低于 3.17.1 或无法识别时会跳过安装；向用户报告结果。版本未登记、指纹不匹配或其他错误时，向用户报告脚本输出；不要使用 `--force` 或重新登记版本来绕过校验。
