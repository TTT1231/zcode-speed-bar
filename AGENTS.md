# AGENTS.md

## 仓库导航

```text
.
├── repair-speed.py                  # CLI、ASAR 读写、版本登记、部署与 pending 替换
├── inject-main.cjs                  # 速度计算、悬浮条、Electron 主进程采样时钟
├── speed-bridge.js                  # renderer store 的只读投影，追加进宿主 bundle
├── targets.json                     # 已登记的宿主版本、资产路径、指纹和 registry 变量
├── speed.test.cjs                   # 速度计算、桥接、界面与主进程的回归测试
├── README.md                        # 使用者入口：安装、查看速度、更新、卸载
├── docs/maintenance.md              # 命令、排错、适配、验证与备份边界
├── skill/zcode-speed-repair/SKILL.md # agent 的安装、修复与适配入口
└── .gitattributes                   # 统一 LF，保证注入源文件字节稳定
```

源码仓库是维护入口。`~/.zcode/zcode-speed/` 是机器本地运行目录，保存部署副本、状态、日志与备份；通过 `repair-speed.py` 同步，不直接维护其中的副本。这些机器状态不提交到仓库。

## 修改约束

- **采样与数据边界**：当前实现读取 renderer store，不依赖 SQLite 或文件监听。桥接可传出标识、状态、字符计数和 token/耗时摘要；保持对宿主 store 只读，不把正文、工具返回内容或凭据带入状态文件和日志。
- **注入函数须自包含**：`createSpeedMeter` 和 `rendererMain` 会通过 `toString()` 序列化后执行，不能引用未传入的外层变量。修改它们时检查 `VERSION` 与旧实例释放逻辑，避免窗口继续复用旧实现。
- **ASAR 只经脚本修改**：保留语法检查、改动前文件备份、逐文件重打包验证和原子替换流程。保留 `zspeed-bridge:v1` 标记与 loader 的可识别性，以便重复安装和卸载。
- **指纹边界**：安装和已登记版本卸载会校验 renderer 指纹；`mainSha256` 目前只被记录，未用于安装或卸载校验。不要把文档或验证结果表述为整包官方字节已恢复，也不要绕过指纹不匹配去登记当前文件。
- **pending 与清理**：发现未完成替换时，按维护文档处理，不能直接覆盖待替换文件或先删运行目录。卸载完成后的清理要保留未校验强制剥离的备份，以及从运行目录执行脚本时的保护行为。
- **换行**：沿用 `.gitattributes` 的 LF 约定，尤其是会被直接追加到宿主 bundle 的 `speed-bridge.js`。

## 按任务查阅与验证

- 改速度计算、桥接、会话选择或悬浮条：从 `inject-main.cjs`、`speed-bridge.js` 和 `speed.test.cjs` 入手，执行 `node --test speed.test.cjs`。
- 改安装、卸载、pending 或清理：先读 [命令与路径](docs/maintenance.md#命令与路径)、[卸载与备份](docs/maintenance.md#卸载与备份) 与 [开发与验证](docs/maintenance.md#开发与验证)。现有 Node 测试不覆盖 Python 安装流程。
- 适配 ZCode 新版本：按 [新版本适配](docs/maintenance.md#新版本适配) 确认宿主结构与 registry 变量，再登记指纹；特征串检查不能替代运行验证。
- 改文档：核对命令参数、状态字段、相对链接与实际实现。使用说明放 README，维护流程放 `docs/maintenance.md`，技能保留执行入口，避免复制整套流程。
- 交付前运行适用的检查及 `git diff --check`，报告实际验证范围。仅做文档或自动测试时，无需对本机 ZCode 执行安装或卸载。

