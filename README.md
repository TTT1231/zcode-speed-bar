# ZCode 速度悬浮条

ZCode 状态条：实时速度显示进度条。

本工具本地使用不联网，工具在 ZCode 进程内读取会话状态，不读取账号凭据，不把消息正文或工具返回内容写入状态文件和日志。远程会话沿用 ZCode 已有的远程连接。

## 安装

安装会修改 ZCode 的 `resources/app.asar`。开始前请确认环境：

| 环境    | 要求      |
| ------- | --------- |
| Python  | 3.8 +     |
| Node.js | node 20 + |

环境准备好之后，将以下复制给 agent 即可

```
https://github.com/TTT1231/zcode-speed-bar/blob/main/skill/zcode-speed-repair/SKILL.md install it
```

## 卸载

```powershell
https://github.com/TTT1231/zcode-speed-bar/blob/main/skill/zcode-speed-repair/SKILL.md remove it
```
