# AGENTS.md

## 入口

```text
skill/zcode-speed-repair/
├── SKILL.md             # 安装、检查、卸载入口
└── scripts/             # 运行源码与版本配置
repair-speed.py          # 根命令入口
speed.test.cjs           # 测速与界面测试
test_repair_speed.py     # 安装与卸载测试
```

## 约束

- 源码只改技能内的 `scripts/`，保持技能可独立复制。`~/.zcode/zcode-speed/` 是运行副本，不直接改、不提交。
- 只读宿主会话状态，不向状态文件或日志写入正文、工具返回内容或凭据。
- `createSpeedMeter`、`rendererMain` 必须自包含；修改时检查 `VERSION` 和旧实例释放。
- ASAR 只通过 `repair-speed.py` 修改，保留备份、语法检查、逐文件校验、原子替换和注入标记。
- 新版本先验证再登记，不绕过指纹校验。
- 有未完成替换时，完全退出 ZCode 并等待；不要覆盖待替换文件或提前删除运行目录。

## 验证

按改动运行对应测试，交付前检查差异：

```powershell
node --test speed.test.cjs                 # 测速、桥接、界面
python -m unittest -v test_repair_speed     # 安装、卸载
git diff --check
```

仅改文档或运行测试，无需安装、卸载本机 ZCode。
