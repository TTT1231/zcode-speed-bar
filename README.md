# zcode-speed-bar

给 ZCode 桌面版注入一个「生成速度悬浮条」：对话窗口底部实时显示 `⚡ xx t/s` 胶囊。
只读本地 SQLite，零网络、零凭据。非官方工具，带指纹校验与字节级备份。

Unofficial speed bar (tokens per second) for the ZCode desktop app. Windows only.

## 效果

对话窗口底部出现一个胶囊：`⚡ 42.3 t/s`（无数据时显示 `—`）。数据来自 ZCode 本地
`~/.zcode/cli/db/db.sqlite`，通过 `fs.watch` 增量读取，只取数字摘要，不碰消息文本。

## 工作原理

对 ZCode 安装目录里的 `resources/app.asar` 做两处注入：

1. **renderer 主 bundle 尾部**追加 `speed-bridge.js`（带 `zspeed-bridge:v1` 标记），桥接内部 store，只传出数字摘要；
2. **`out/main/index.js` 尾部**追加一行 loader，运行时 `import` 运行目录里的 `inject-main.cjs`（悬浮条本体）。

安全措施：只接受指纹校验通过的官方字节；写入走临时文件 + 逐文件校验 + 原子替换；
ZCode 占用 asar 时自动转为 pending，等它退出后由后台进程完成；每次改动前把原始字节
备份到 `~/.zcode/zcode-speed/backups/`，卸载时与官方指纹逐字节比对还原。

## 环境要求

- Windows + ZCode 桌面版（其他平台需手动 `--asar`，未测试）
- Python 3.8+（仅标准库）
- Node.js（注入前的语法检查用）

## 安装

```bash
git clone https://github.com/TTT1231/zcode-speed-bar.git
cd zcode-speed-bar
python repair-speed.py install
```

`app.asar` 自动探测（注册表卸载信息 + 常见安装路径）；探测失败时手动指定：

```bash
python repair-speed.py install --asar "D:\soft\ZCode\resources\app.asar"
```

ZCode 正在运行时 asar 被占用属于正常情况：工具会写入待替换文件并留后台进程等待，
完全退出 ZCode（托盘也要退）后自动完成，再启动 ZCode 即可。

验证：`~/.zcode/zcode-speed/status.json` 中 `"bridge": true`，且对话窗口底部出现 ⚡ 胶囊。

## 更新

```bash
git pull
python repair-speed.py install   # 重新部署并注入，然后重启 ZCode
```

细节：只改 `inject-main.cjs`（悬浮条本体）时，`deploy` + 重启 ZCode 就生效，不必重碰
asar；改了 `speed-bridge.js`（烧进 asar 的渲染桥）必须重跑 `install`。拿不准就 `install`。

## 卸载

```bash
python repair-speed.py remove    # 剥离注入并还原官方字节
```

完全退出并重开 ZCode 确认悬浮条消失。`~/.zcode/zcode-speed/` 目录可留可删，删除即彻底清除。

## 新版 ZCode 适配

官方升级会全量覆盖安装目录，注入被抹掉，悬浮条消失——重跑 `install` 即恢复。
若 `check` 报 `has no verified speed bridge`，说明当前 ZCode 版本还没登记：

1. `python repair-speed.py check` 确认报未知版本；
2. 从 bundle 特征串找到持有 store registry 的压缩变量名（`add-version` 输出的
   `featureContext` 提供上下文片段；也可参考同类项目 zcode-token-usage-statusbar 的适配记录）；
3. 登记：`python repair-speed.py add-version --registry <变量名>`（特征串缺失会被拒绝——
   store 形状变了，需先改 `speed-bridge.js` 并过 `node --test speed.test.cjs`）；
4. `install` → 重启 ZCode → 验证；
5. 把 `targets.json` 的变更 commit 并 push，其他机器 `git pull` 后直接 `install`。

## 目录模型

- **本仓库** = 源码唯一真相：`repair-speed.py`（asar 工具）、`inject-main.cjs`（悬浮条）、
  `speed-bridge.js`（渲染桥）、`targets.json`（版本注册表）、`speed.test.cjs`（测试）。
- **`~/.zcode/zcode-speed/`** = 机器本地运行目录：部署副本 + 全部状态
  （`status.json`、`install-status.json`、`debug.log`、`backups/`、pending 文件）。

状态永远落在运行目录，不进仓库；回滚 asar 全靠运行目录里的 `backups/`，别清。

## 免责声明

本工具修改 ZCode 安装目录内的 `app.asar`，属非官方改动，风险自担。若未来 ZCode 启用
asar 完整性校验导致无法启动，先跑 `remove` 恢复官方字节再反馈。
