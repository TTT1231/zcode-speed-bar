# Skill: zcode-speed-repair
# ZCode 生成速度悬浮条 —— 修复 / 卸载 / 新版本适配

## 原理与文件布局

- **源码仓库**(clone 到任意位置)是唯一源码真相:
  - `repair-speed.py`:唯一 asar 工具,子命令 `install` / `remove` / `check` / `deploy` / `add-version` / `wait`;
  - `inject-main.cjs`:悬浮条本体(fs.watch 本地 SQLite → executeJavaScript 注入 ⚡ t/s 胶囊);
  - `speed-bridge.js`:注入 renderer 主 bundle 的桥(只传出数字摘要,不碰消息文本);
  - `targets.json`:版本注册表(各 ZCode 版本的 renderer 资产指纹、main 指纹、registry 变量名);
  - `speed.test.cjs`:bridge 契约测试(`node --test speed.test.cjs`)。
- **`~/.zcode/zcode-speed/`** 是机器本地运行目录(部署目标 + 全部状态,零网络、零凭据):
  状态文件(`status.json`、`install-status.json`、`pending-install.json`、`debug.log`)、
  `backups/`,以及 install/deploy 时从仓库同步过来的运行文件副本。
- `app.asar` 共两处注入:renderer 主 bundle 尾部追加 `speed-bridge.js`(带 `zspeed-bridge:v1` 标记),
  `out/main/index.js` 尾部追加一行 `import("file:///…/zcode-speed/inject-main.cjs")`(固定指向运行目录)。
- asar 路径自动探测(Windows 注册表卸载信息 + 常见安装路径),探测失败用 `--asar` 手动指定。
- ZCode 官方升级全量覆盖安装目录 → 注入被抹掉 → 悬浮条消失 → 重跑 install 即恢复。

## 修复(状态条消失时)

```powershell
python <仓库路径>\repair-speed.py install
```

- **无需先退出 ZCode**:asar 被占用时工具自动写 pending 待替换文件并留后台进程等待,
  输出 `pending-until-ZCode-exits`。此时不要重跑命令;让用户完全退出 ZCode(托盘也要退),
  后台进程自动完成替换(`install-status.json` 变为 `installed`),再让用户重启 ZCode。
- 验证:重启后 `~/.zcode/zcode-speed/status.json` 中 `"bridge": true`,对话窗口底部出现
  `⚡ xx t/s` 胶囊(无数据时显示 `—`)。
- 仍无悬浮条按序排查:`inject-main.cjs` 存在且 `node --check` 通过;`~/.zcode/cli/db/db.sqlite`
  存在且 ZCode 登录使用中;`check` 输出正常。

## 更新(拉了新代码或改了源码之后)

```
git pull
python <仓库路径>\repair-speed.py install   # 部署 + 重新注入,然后重启 ZCode
```

- 只改 `inject-main.cjs` 时:`deploy` + 重启 ZCode 即生效,不必重碰 asar;
- 改了 `speed-bridge.js` 必须重跑 `install`(它被追加进 renderer bundle,烧在 asar 里);
- 拿不准就 `install`,它是幂等的。

## check 与退出码(只读)

- `bridge/loader: true` + 退出码 0 = 已注入,无需操作。
- `bridge/loader: false` + 退出码 1 = 未注入(或已卸载)——**不是故障**,跑 install 即可。
- 报 `has no verified speed bridge` = 当前 ZCode 版本未登记,走下方适配流程。

## 新版本适配(check 报未知版本时)

1. 确定 renderer 主 bundle:`add-version` 默认自动选 `out/renderer/assets/` 下最大的 `.js`。
2. 找 bundle 里持有 store registry 的**压缩变量名**:`add-version` 输出的 `featureContext` 给出
   `productTurnId`/`rowId`/`logEpoch` 等特征串的上下文片段,据此判断;
   也可参考上游 zcode-token-usage-statusbar 是否已适配新版本。
3. 登记(对 asar 只读,只写仓库里的 targets.json):

   ```powershell
   python <仓库路径>\repair-speed.py add-version --registry <变量名>
   ```

   特征串缺失会被拒绝——说明 store 形状变了,需先改 `speed-bridge.js` 并过
   `node --test speed.test.cjs`,再回来登记。已登记版本重登记需 `--force`。
   **登记后记得 commit & push targets.json**,其他机器 `git pull` + `install` 即同步。
4. `install` → 用户重启 ZCode → 验证 `status.json` 中 `"bridge": true` 且出现 ⚡ 胶囊。

## 卸载

```powershell
python <仓库路径>\repair-speed.py remove
```

- 已登记版本:剥离后与官方指纹逐字节比对,保证还原官方字节;同样支持 pending 机制。
- 未登记版本:需加 `--force`(跳过哈希比对,保留语法检查)。
- 完全退出并重开 ZCode 确认悬浮条消失。`~/.zcode/zcode-speed/` 目录可留可删
  (删除即彻底卸载工具)。

## install-status.json 状态语义

- `installed` / `removed`:已生效;`restartRequired: true` 时需重启 ZCode。
- `pending`:存在待替换文件,ZCode 退出后由后台进程自动完成,随后变为上面两者之一。
- `cancelled`:pending 被取消,原文件未动。
- pending 冲突:上一操作未完成时 install/remove 会被拒绝并打印指引——等 ZCode 退出让
  后台进程完成,或删除 `~/.zcode/zcode-speed/pending-install.json` 与 asar 旁的
  `app.asar.zspeed.pending` 两个文件来取消(后台进程会安全退出,状态写 `cancelled`)。

## 注意

- 不要手工编辑 app.asar;一切改动经 repair-speed.py(原子替换 + pending + 自动备份)。
- 备份在 `~/.zcode/zcode-speed/backups/`:`<时间>-host-<版本>` 是 install 前的**官方字节**,
  `<时间>-injected-<版本>` 是 remove 前的注入态字节,manifest.json 记录 `intent` 字段。
  回滚 asar 全靠这些备份,别清。
- ZCode 若在未来版本启用 asar 完整性校验导致无法启动:先跑 remove 恢复官方字节,再反馈。
- `--asar`/`--targets` 可覆盖默认路径(默认自动探测 asar;targets 固定用脚本旁的)。
- `python` 不可用时换 `py -3`。
