# AGENTS.md

## 入口

```text
skill/zcode-speed-repair/
├── SKILL.md             # 安装、检查、卸载入口
└── scripts/             # 运行源码
repair-speed.cjs         # 根命令入口
speed.test.cjs           # 测速、桥接、界面测试
install.test.cjs         # 安装器测试（合成 ASAR、三平台布局、结构适配）
```

## 约束

- 源码只改技能内的 `scripts/`，保持技能可独立复制。`~/.zcode/zcode-speed/` 是运行副本，不直接改、不提交。
- 只读宿主会话状态，不向状态文件或日志写入正文、工具返回内容或凭据。
- `createSpeedMeter`、`rendererMain` 必须自包含；修改时检查脚本标识和旧实例释放。
- ASAR 只通过 `repair-speed.cjs` 修改，保留备份、语法检查、逐文件校验、原子替换和注入标记。
- 注入标记与 loader 行用于识别当前安装，改写时须保持安装、更新和卸载流程一致。
- pending 元数据的 `originalStamp` 是 JSON 数字数组（size、mtimeNs、ino）；mtimeNs 超出 Number 精度，必须经 `parseMeta`/`serializeJsonWithStamp` 无损读写，确保待替换任务能正确校验。
- 安装时自动适配新版本，无按版本登记：store 结构特征定位资源，`layer:new`/`stale:!1`/`R.set` 组合锚点识别 registry 变量，每位点独立验证；候选不一致即拒绝，`--registry` 兜底只救锚点歧义且给定名字仍须过结构校验；store 特征缺失时任何参数都不得安装；不要按应用版本号设定准入门槛。
- 有未完成替换时，完全退出 ZCode 并等待；不要覆盖待替换文件或提前删除运行目录。CIM waiter 创建失败会降级为 `detached-fallback` 并在报告中给出手动接续命令。

## 验证

按改动运行对应测试，交付前检查差异：

```powershell
node --test            # speed.test.cjs（测速、桥接、界面）+ install.test.cjs（安装、卸载）
git diff --check
```

仅改文档或运行测试，无需安装、卸载本机 ZCode。
