# 维护与排错

首次安装、更新和卸载见 [README](../README.md)。本文用于判断安装状态、处理 pending、适配新版本及修改实现；命令均从源码仓库根目录在 PowerShell 中执行。

## 命令与路径

```powershell
python repair-speed.py --help
```

| 命令 | 用途与写入范围 |
| --- | --- |
| `check` | 默认命令。只读检查当前 ASAR 的版本、renderer 指纹、注入内容与 JavaScript 语法，不部署文件。 |
| `install` | 同步运行文件，向 renderer bundle 追加桥接代码，向 `out/main/index.js` 追加运行目录 loader；需要时重打包并替换 ASAR。 |
| `deploy` | 只同步运行文件，不定位或改写 ASAR。仅改 `inject-main.cjs` 且已有有效注入时可用，随后重启 ZCode。 |
| `remove` | 同步脚本所需文件，移除桥接和 loader；完成后按校验结果清理运行目录。 |
| `add-version` | 只读 ASAR，将版本、资产指纹与指定 registry 变量写入版本登记文件。 |
| `wait` | 为已有 pending 完成替换，通常由脚本自动在后台启动，最长等待 24 小时。 |

`install` 和 `remove` 会先部署运行文件再校验宿主。因此，宿主校验失败时 ASAR 未改动，但运行目录可能已同步。

| 参数 | 适用情形 |
| --- | --- |
| `--asar PATH` | 指定 `resources/app.asar`。默认查 Windows 卸载注册表及常见安装路径，发现多份安装时选第一个；显式指定可避免选错。 |
| `--targets PATH` | 指定版本登记文件，默认是当前脚本旁的 `targets.json`，与命令执行目录无关。 |
| `--registry NAME` | `add-version` 必填，指定 bundle 内持有 store registry 的 JavaScript 变量名。 |
| `--asset PATH` | `add-version` 使用的 ASAR 内部资产路径，默认选择 `out/renderer/assets/` 中最大的 `.js`。 |
| `--force` | `add-version` 覆盖已登记版本，或 `remove` 剥离未登记版本的桥接；不能绕过已登记版本的 renderer 指纹错误。 |

目前路径验证要求安装根目录存在 `ZCode.exe`。其他平台没有经过验证，单独指定 `--asar` 不等于已获得跨平台支持。

运行目录固定为 `~/.zcode/zcode-speed/`，Windows PowerShell 可用 `Join-Path $env:USERPROFILE '.zcode\zcode-speed'` 访问。安装和部署会同步 `inject-main.cjs`、`speed-bridge.js`、`speed.test.cjs`、`targets.json`、`repair-speed.py`；源码仓库应放在该目录之外。

| 本地文件 | 查阅用途 |
| --- | --- |
| `status.json` | 运行时快照，约每 5 秒写入；包含 `version`、`pid`、`updatedAt`、`intervalMs` 和 `windows`。每个窗口的 `bridge`、`mode`、`tps`、`sessionId`、`tickAt` 用于判断实际采样状态。 |
| `install-status.json` | 最近一次写入的安装、卸载或等待状态。无变更的重复安装不会刷新它，成功卸载通常会将它一并删除。 |
| `debug.log` | 主进程加载信息与 renderer 执行错误。 |
| `pending-install.json` | 待替换操作的路径、原文件标记、目标哈希及后续清理要求。 |
| `backups/` | 改动前的目标文件内容及 `manifest.json`，见下方备份说明。 |

`app.asar.zspeed.pending` 在目标 ASAR **旁边**，不在运行目录内。

## 运行机制

[repair-speed.py](../repair-speed.py) 在 renderer 主 bundle 尾部追加 [speed-bridge.js](../speed-bridge.js)，将 `__ZSPEED_REGISTRY__` 替换成登记的变量名；同时在主进程入口追加 loader，加载运行目录内的 [inject-main.cjs](../inject-main.cjs)。

Electron 主进程每 500 ms 触发一次采样，只向 ZCode 安装资源目录内的本地窗口执行代码。桥接在 renderer 内统计回答、思考和工具输入的 Unicode 字符数，返回标识、状态和数值摘要；不修改宿主 store，不导出正文，不读取 SQLite。对运行中的子智能体，桥接通过 ZCode 的会话数据层获取只读会话订阅；远程会话沿用宿主已有的连接。

速度计算使用约 2 秒的滑动窗口，初始按 2 字符/token 估算；获得完整一轮的文本计数与有效 token 汇总后，可校准该会话后续轮次的换算比例。已完成轮次有有效汇总时使用 `outputTokens * 1000 / modelDurationMs`，耗时必须在 200 ms（含）至 1 小时（不含）之间，token 数必须为正。

可用会话在后台独立采样，每个可见会话容器内各有一个悬浮条，读取自身会话 ID 对应的结果。主会话和辅助会话可以并行生成、分别结束，各自显示自己的速度；辅助会话隐藏或关闭时会移除它的悬浮条。`status.json` 的 `windows[]` 仍记录当前聚焦或最近交互的可见会话，作为窗口诊断状态。重连、store 更换或长时间未观测会重建基线，避免将历史回放算成突发输出。具体行为与边界由 [speed.test.cjs](../speed.test.cjs) 中的测试说明。

子智能体任务行使用与主会话相同的测速器。桥接按同一轮的工具调用 ID 关联子会话；宿主缺少关联 ID 时，仅在该轮剩余任务和子会话都唯一的情况下关联，存在歧义时显示 `— t/s`。运行中的子会话自动订阅，不必打开其面板；已采样的子会话结束后，在对应记录仍可用时保留订阅以显示结束速度。最多保留 64 个子会话订阅，优先保留运行中的子会话；记录移出窗口、会话失效或测速组件释放时归还订阅。启动前已经完成且未订阅的历史子智能体可能显示 `— t/s`。

## 诊断与 pending

先运行只读检查，再结合实际窗口状态判断：

```powershell
python repair-speed.py check
$LASTEXITCODE
$runtimeDir = Join-Path $env:USERPROFILE '.zcode\zcode-speed'
Get-Content -LiteralPath (Join-Path $runtimeDir 'status.json')
```

自定义安装路径时为 `check` 补上相同的 `--asar`。尚未运行过注入或卸载已完成时，`status.json` 不存在是正常的。

| 检查结果或现象 | 含义与下一步 |
| --- | --- |
| `bridge: true`、`loader: true`，退出码 `0` | 当前 ASAR 与检查所用的桥接及 loader 一致。还需确认 `pending: false`，并重启 ZCode 验证运行结果。 |
| JSON 中任一注入标志为 `false`，退出码 `1` | 未安装、部分注入或桥接需要更新；不一定是故障，执行 `install` 可修复。 |
| 抛出异常，未输出正常检查 JSON | 先处理异常；不能仅凭退出码 `1` 判定为未安装。 |
| `has no verified speed bridge` | 版本未登记，按下方适配流程处理。 |
| `Renderer fingerprint mismatch` 或卸载时报 clean fingerprint 不匹配 | 文件与登记内容不同，可能是版本变动或其他修改；先核实安装来源和目标路径，不用重新登记或 `--force` 掩盖差异。 |
| `Node is required for the syntax check` | 确认 `node --version` 可在当前命令行运行；`check` 也需要 Node.js。 |
| 安装检查正常，但没有悬浮条 | 完全退出并重开 ZCode，打开会话；检查运行副本 `inject-main.cjs`、最新 `status.json` 和 `debug.log`。 |
| 持续显示 `—` | 查看对应 `windows[]` 的 `bridge` 与 `mode`；`bridge: true` 只证明读取函数存在，仍可能没有可用会话、正在重连或尚未形成样本。 |
| 工具执行期间显示 `0.0` | 当前台工具运行或等待批准且没有并行模型输出时，这是预期行为；后台工具不会因此冻结其他输出采样。 |

`check` 优先使用运行目录已有的桥接与运行文件，缺失才回退到源码旁的文件。因此它不能证明本地源码的最新修改已经部署。更新源码后按修改范围执行 `deploy` 或 `install`，再检查。

### 判断运行是否正常

重启后等待一次状态写入，确认 `status.json` 的 `updatedAt`、对应窗口的 `tickAt` 持续更新，并在该窗口看到悬浮条。开始生成后数值应刷新；打开辅助会话并让两者同时生成，确认各自显示自己的速度，再检查任意一边先结束、切换或关闭辅助会话时的显示。

`bridge` 位于 **`windows[]` 的窗口对象内**，不是 `status.json` 顶层字段。旧进程留下的状态文件也可能存在，不能仅凭文件存在或曾经写入的 `bridge: true` 判定当前运行正常。

### 处理待替换操作

当原子替换遇到 `PermissionError`，命令输出 `state: pending-until-ZCode-exits`，`install-status.json` 写入 `state: pending`，后台等待进程开始尝试替换。常见原因是 ZCode 占用文件，也可能是安装目录写权限不足。

1. 完全退出 ZCode，包括托盘进程；不要重复发起 `install` 或 `remove`。
2. 安装操作等待 `install-status.json` 变为 `installed`；卸载操作完成后通常连该文件一起清理。
3. 用同一路径执行 `check` 确认，再重开 ZCode。卸载已登记版本后，两个注入标志应为 `false`，退出码 `1` 属正常结果。

等待进程会检查待替换文件的哈希、路径以及原文件是否变化，避免将旧包覆盖到已更新的 ZCode 上。

| `install-status.json` 的 `state` | 含义 |
| --- | --- |
| `installed` / `removed` | 本次文件操作已完成；`restartRequired: true` 时需要重启。卸载后的清理可能使状态文件不再存在。 |
| `pending` | 已准备待替换文件，尚未完成替换。 |
| `cancelled` | 待替换文件被删除，或原包/待替换文件发生变化；未应用此次待替换包。 |
| `waiting-expired` | 等待 24 小时仍未成功替换；检查进程占用和写权限。 |

需要放弃 pending 时，先读取 `pending-install.json` 核对所属安装路径，并确认后台等待进程已停止；随后删除运行目录的 `pending-install.json` 和它记录的 `app.asar.zspeed.pending`。两者都清理后才能重试。不要删除正在使用的 `app.asar` 或备份；后台等待进程的 PID 在原命令输出的 `monitorPid` 中。

若只想继续已有操作且已确认原等待进程不存在、文件未变化，可运行 `python repair-speed.py wait --asar "实际安装路径\resources\app.asar"`。不要为同一 pending 同时启动多个等待进程。

## 卸载与备份

`remove` 去除可识别的 bridge 与 loader。对已登记版本，它还会校验剥离后 renderer 文件的 SHA-256；随后校验 JavaScript 语法，重打包并逐文件比较预期内容，最后替换 ASAR。

这不等于恢复整个官方 ASAR 的逐字节副本：重打包会重建头部，`mainSha256` 虽被登记但目前没有参与安装或卸载校验。文档中的“移除注入”指移除本工具识别的追加内容。

每次实际重打包前，`backups/` 保存本次将改动的文件内容，附带路径、版本、操作意图及哈希清单：

- `<时间>-host-<版本>`：安装前的目标文件内容；重新安装时可能已包含旧注入，不保证都是干净的官方文件。
- `<时间>-injected-<版本>`：卸载前的目标文件内容。
- 每个备份目录的 `manifest.json` 记录 `intent`、目标 ASAR 和文件哈希。备份不是完整 ASAR，不能直接把备份目录中的单个文件替换成 `app.asar`。

已登记版本正常卸载完成后，运行目录连同备份一并清除。若 ZCode 占用文件，清理发生在 pending 替换完成之后；清理成功后无需再寻找 `install-status.json`。

特殊情形：

- **未登记版本仍有桥接**：普通 `remove` 会拒绝；`remove --force` 可跳过 renderer 指纹核对并剥离已知标记，仍执行语法和重打包校验。此时运行文件被清理，`backups/` 保留供手工恢复参考；确认 ZCode 正常后再决定清理备份。
- **脚本本身位于运行目录**：为避免删除自身所在源码，脚本保留运行目录并在 `runtimeDir` 中提示手动处理。日常从独立源码仓库执行卸载。
- **目录未删干净**：查看命令输出的 `runtimeDir`，先完全退出 ZCode 并确认注入已移除，再清理提示的残留目录。需要排错或手工恢复时先保留备份。

如果改动后 ZCode 无法启动，可从源码仓库执行 `remove` 尝试移除注入；若指纹或结构检查拒绝操作，保留错误信息和备份，先核实宿主文件，不通过强制登记消除错误。

## 新版本适配

适用于 `check` 报版本未登记，或宿主升级后桥接结构变化。版本清单以 [targets.json](../targets.json) 为准。

1. 确认目标是需要适配的 ZCode 安装。只读检查 ASAR 的 `package.json` 版本与 `out/renderer/assets/` 下的候选 bundle；可复用 [repair-speed.py](../repair-speed.py) 的 `read_header`、`files`、`read_file` 和 `context_snippets`，不直接编辑安装包。
2. 在 bundle 中定位 `productTurnId`、`rowId`、`logEpoch`、`assistantText`、`projectionReady`，沿相关代码确认持有 store registry 的变量，核对 `entry.layer.entries`、`store.getState()` 和 `snapshot.rows.window` 等读取路径。最大的 `.js` 只是默认候选；如不是主 bundle，使用 `--asset` 指定正确路径。
3. 先确认变量和结构，再运行登记命令。将下面的占位值替换为实际变量名；若变量名含 `$`，保留 PowerShell 单引号以免被展开。

   ```powershell
   python repair-speed.py add-version --registry '<registry>'
   ```

   登记只读取 ASAR，但会写 `targets.json`。`featureContext` 是**写入成功后**的输出，不是登记前的探测接口。不要猜一个变量名运行该命令来获取上下文。

4. 若特征串缺失，先修改桥接并验证再登记。特征串存在只是一道初筛，脚本不验证变量是否真的是 registry，也不证明运行时兼容。覆盖已有版本需 `add-version --force`，应先查清差异来源。
5. 执行下方自动检查，再 `install`、完全退出并重开 ZCode。确认最新窗口状态 `bridge: true`，并验证实际生成、结束汇总和会话切换。检查 `targets.json` 中的资产路径、变量与哈希，将已验证的登记随适配变更一起交付。

## 开发与验证

仓库没有构建步骤或第三方依赖安装步骤。验证用的 Node.js 需支持 `node --test` 与 `structuredClone`。

```powershell
python -m py_compile repair-speed.py
node --check inject-main.cjs
node --check speed-bridge.js
node --test speed.test.cjs
git diff --check
```

Node 测试覆盖速度采样、工具等待、结束汇总与校准、重连及会话切换、子智能体的并行采样和任务行关联、会话订阅的释放、桥接的数据边界、悬浮条生命周期和主进程注入范围。它们使用模拟宿主，不会改写本机 ZCode，也不覆盖 Python 的 ASAR 替换、pending 或目录清理。

修改 Python 安装逻辑时，还需在隔离临时目录和合成 ASAR 上验证受影响分支，避免用真实安装做自动测试：例如重复安装、拒绝指纹不匹配、文件未改动部分的保真、卸载清理、强制剥离保留备份，以及文件占用或变化时的 pending 行为。语法检查不能代替这些验证。

| 修改内容 | 部署方式 |
| --- | --- |
| 仅 `inject-main.cjs`，宿主已有有效注入 | `python repair-speed.py deploy`，再重启 ZCode。 |
| `speed-bridge.js` 或版本适配 | `python repair-speed.py install`，等待替换完成，再重启 ZCode。 |
| README、AGENTS、维护文档、技能说明 | 检查引用、命令和实现一致性，无需部署到 ZCode。 |

涉及实际 UI 或宿主适配时，最后在目标 ZCode 版本中确认首次采样、生成暂停、前台工具等待、完成汇总及多会话切换；子智能体改动还需确认并行任务分别显示、同名任务不串读数。只有自动测试通过时，应明确说明尚未完成实机验证。
