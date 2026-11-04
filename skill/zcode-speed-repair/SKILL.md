---
name: zcode-speed-repair
description: 安装、更新、排查或卸载 Windows ZCode 的 zcode-speed-bar 生成速度悬浮条。适用于悬浮条消失、速度不刷新或升级后需要适配新版本的情况。
---

# ZCode 速度悬浮条

从含 `repair-speed.py` 和 `targets.json` 的源码仓库根目录执行 `python repair-speed.py <子命令>`，遵循仓库的 [AGENTS.md](../../AGENTS.md)。自动定位失败或有多份安装时，用 `--asar` 指定目标 `app.asar`，后续涉及安装包的命令沿用该路径。

## 按任务执行

| 场景 | 操作 |
| --- | --- |
| 首次安装、恢复缺失的注入、更新桥接 | `install`，然后重启 ZCode。 |
| 仅更新 `inject-main.cjs`，且注入有效 | `deploy`，然后重启 ZCode。 |
| 悬浮条不显示或速度不更新 | 先运行 `check`，查看 `~/.zcode/zcode-speed/` 下的 `status.json` 和 `debug.log`。见[诊断](../../docs/maintenance.md#诊断与-pending)。 |
| 需安装的 ZCode 版本未登记 | 先只读确认 bundle、store 结构和 registry 变量，再用 `add-version` 登记。见[新版本适配](../../docs/maintenance.md#新版本适配)。 |
| 卸载 | `remove`，重启后确认悬浮条消失，查看有无保留的备份。见[卸载与备份](../../docs/maintenance.md#卸载与备份)。 |

## 处理结果

- **待替换**（`pending-until-ZCode-exits` 或 `pending: true`）。完全退出 ZCode（含托盘），等已有操作完成后再启动。取消或恢复时按[待替换流程](../../docs/maintenance.md#处理待替换操作)处理。
- **指纹不匹配**。核对目标路径和安装来源，避免用 `--force` 或重新登记绕过校验。ASAR 写入统一经 `repair-speed.py`。
- **安装或修复完成**。用 `check` 确认 `bridge`、`loader` 为 `true` 且 `pending` 为 `false`。重启后确认 `status.json` 持续更新，在实际生成时观察速度变化。
