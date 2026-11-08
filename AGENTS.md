# AGENTS.md

## 入口

```text
skill/zcode-speed-repair/
├── SKILL.md             # 安装、检查、卸载入口
└── scripts/             # 运行源码与版本配置
repair-speed.cjs         # 根命令入口
speed.test.cjs           # 测速、桥接、界面测试
install.test.cjs         # 安装器测试（合成 ASAR、三平台布局、旧版产物兼容）
```

## 约束

- 源码只改技能内的 `scripts/`，保持技能可独立复制。`~/.zcode/zcode-speed/` 是运行副本，不直接改、不提交。
- 只读宿主会话状态，不向状态文件或日志写入正文、工具返回内容或凭据。
- `createSpeedMeter`、`rendererMain` 必须自包含；修改时检查 `VERSION` 和旧实例释放。
- ASAR 只通过 `repair-speed.cjs` 修改，保留备份、语法检查、逐文件校验、原子替换和注入标记。
- 注入标记与 loader 行是跨版本契约：改写前先确认旧安装（含历史 Python 安装器产物）仍能被识别、升级和卸载。
- pending 元数据的 `originalStamp` 是 JSON 数字数组（size、mtimeNs、ino）；mtimeNs 超出 Number 精度，必须经 `parseMeta`/`serializeJsonWithStamp` 无损读写，旧 Python waiter 才能接续。
- targets.json 条目含 `platform` 字段；缺省视为 `win32`（历史登记均为 Windows 验证）。`add-version` 记录当前平台，其他平台须单独适配登记。
- 新版本先验证再登记，不绕过指纹校验。
- 有未完成替换时，完全退出 ZCode 并等待；不要覆盖待替换文件或提前删除运行目录。CIM waiter 创建失败会降级为 `detached-fallback` 并在报告中给出手动接续命令。

## 验证

按改动运行对应测试，交付前检查差异：

```powershell
node --test            # speed.test.cjs（测速、桥接、界面）+ install.test.cjs（安装、卸载）
git diff --check
```

仅改文档或运行测试，无需安装、卸载本机 ZCode。
