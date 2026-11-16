# SamuBookMarker

跨浏览器书签同步扩展（Chrome / Edge / Firefox，Manifest V3）：以**你自己的私有 GitHub Gist** 作为同步介质，书签快照**口令加密**后上传，同步由你手动触发。纯 Vibe 小垃圾。

## 安装

1. 构建：`npm install` 后执行 `node build.mjs`，产出 `dist/chrome` 与 `dist/firefox`（构建产物不入库）；
2. Chrome / Edge：打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/chrome`；
3. Firefox：打开 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选择 `dist/firefox/manifest.json`。

## 使用

### 1. 在 GitHub 上建一个私有 Gist

- 打开 https://gist.github.com/，新建一个 **Secret Gist**（内容可留空或随意）；
- 建好后地址栏形如 `https://gist.github.com/<你的用户名>/<Gist ID>`，复制其中的 **Gist ID**。

### 2. 生成一个 Token

- 打开 https://github.com/settings/tokens → 生成 Personal access token（classic），勾选 **gist** 权限即可，不需要 repo 权限；
- 扩展只会用这个 Token 读写你指定的那一个 Gist，**绝不会创建新的 Gist**。

### 3. 在扩展里填写

点工具栏图标，填写：

| 字段         | 说明                                                       |
| ------------ | ---------------------------------------------------------- |
| GitHub Token | 上面生成的 token：**推送必填**，拉取可以不填；留空表示不修改已保存的值 |
| 加密口令     | 用于加解密快照，**所有设备必须一致**；留空表示不修改 |
| Gist ID      | 第 1 步得到的 ID，也可以直接粘贴整条 Gist 网址，会自动提取 |
| 设备名       | 仅用于日志区分，例如「桌面 Chrome」                        |
| 同步方式     | 拉取合并 / 拉取覆盖（默认）/ 推送，见下一节               |

点「保存设置」，再点「立即同步」。

### 4. 另一台设备

在新设备上重复同样的填写（同一个 Gist ID、同一句口令），同步方式选「拉取覆盖」，点「立即同步」——Gist 上那份会写成本机书签。

## 同步方式

把 Gist 当成一个远端仓库，只有三件事可做：选一个动作，再点「立即同步」。

| 动作                   | 本机                   | Gist             | 什么时候用                                 |
| ---------------------- | ---------------------- | ---------------- | ------------------------------------------ |
| **拉取合并**           | 把 Gist 上有的补进来   | **不动**         | 想拿到别的新加的书签，又不覆盖本机内容     |
| **拉取覆盖**（默认）   | 换成和 Gist 一模一样   | **不动**         | 换新电脑、恢复书签、清掉重复的那一批       |
| **推送**               | 不动                   | 被本机内容覆盖   | 这台改了书签，要把结果存到远端             |

权限也像 git：**拉取只需要读得到 Gist**（公开 Gist 连 Token 都不用填），**推送必须有 token**，且这个 token 是 Gist 所属账号的、带 `gist` 权限，否则没有写权限。

每个动作之前都会先跑一次**只读预览**：算出会改哪些东西，这一步不写任何东西。凡是要覆盖或删除 —— 推送，以及会删掉本机书签的拉取覆盖 —— 弹窗都会停下来，列清数量与前几条标题，等你点确认才真的动手；预览绑定当时的内容，两分钟内有效，期间远端变了就得重新看一遍。

「拉取覆盖」：以 Gist 上那份为唯一标准，本机书签栏 / 其他书签 / 移动端书签三个目录被重建为一样的内容——**Gist 里没有的本机书签会被删掉**（包括刚加还没来得及同步的）。Gist 还是空的时候它直接报错，不会拿空数据把本机清空。

「推送」：把本机书签整体（含墓碑）写进 Gist，覆盖那边原有的内容；本机一条都不动，内容与远端一致时不会重复写入。

「拉取合并」的合并规则：

1. 两边按**同步 ID** 逐项合并：
   - 同一项两边都改过 → **更新时间较晚的一方获胜**（时间戳相同则「删除」优先，再相同则按设备 id 排序，保证所有设备得出同一结论）；
   - 只有一边有的项 → 视为新增；
   - 删除不靠"看不见"推断，而是写入**墓碑记录**并保留 180 天，因此删除能可靠传播到其他设备，不会被另一端"复活"；
2. 把合并结果写回本地书签树（新增 / 改名 / 换 URL / 换父文件夹 / 删除 / 调整同级顺序）；
3. 若结果与远端不同，则加密并写回 Gist；一致则**不写**，避免无谓的 API 调用。

⚠️ **一台已经有书签的设备第一次接入时，用「拉取覆盖」**：本机这些旧书签从未与 Gist 建立过对应关系，同步 ID 全是新的，拉取合并会把它们当成"本机新增"，与 Gist 上那份并存，结果就是一堆重复。反过来更要小心：这台设备如果从没同步过就点「推送」，Gist 上原来那份会被直接盖掉。

### 为什么需要"同步 ID"

浏览器书签的 `id` 是**设备本地**的（同一书签在 Chrome 是 `12`，在 Firefox 可能是别的值），无法跨设备识别同一项。因此扩展为每个书签分配一个稳定的 UUID 并维护 本地 id ↔ 同步 id 的映射（存在本地），远端只看 UUID。

### 加密

- 密钥派生：PBKDF2-SHA256，210000 次迭代，16 字节随机盐；
- 加密：AES-256-GCM，12 字节随机 IV，附加认证数据 `SamuBookMarker/1`；
- 每次写入都重新生成盐与 IV；Gist 上只有密文，书签标题与网址对 GitHub 不可见；
- 口令只存在本地 `storage.local`，**不会上传**；因此**忘记口令无法恢复**，也无法解密旧快照。

## 隐私与安全

- 只访问 `https://api.github.com`（manifest 中显式声明）；
- 只发出 GET 与 PATCH，永远不创建 Gist、不访问其他域名、不加载任何远程脚本；
- 所有数据与凭据保存在浏览器本地，卸载扩展即失去映射关系（远端密文仍在，需要口令才能解开）。

## 开发与测试

```bash
node build.mjs                      # 构建 dist/chrome 与 dist/firefox
node --experimental-test-isolation=none --test tests/   # 全部单元 + 集成测试
node tools/demo/run-demo.mjs        # 两台设备的同步过程演示
node tools/gen-icons.mjs            # 重新生成图标
```

> 本机若在受限沙箱中运行，`node --test` 可能因管道 stdio 被拒绝而报 `spawn EPERM`，加 `--experimental-test-isolation=none` 即可（`npm test` 已内置该参数）。

构建使用唯一开发依赖 esbuild（`npm install` 安装；本机若无，会回退到同级 `../QRScan/node_modules`），把 `src/background.js` 与 `src/popup.js` 打成 IIFE，并按目标浏览器挑选 manifest。除 esbuild 外**零运行时依赖**。

## 目录结构

```
src/
  manifest.chrome.json   Chrome/Edge 清单（MV3 service worker）
  manifest.firefox.json  Firefox 清单（MV3 事件页 + gecko id）
  background.js          消息路由：GET_STATE / SAVE_SETTINGS / SYNC_NOW、状态与日志
  popup.html/css/js      工具栏弹窗：凭据设置、立即同步、状态与日志
  lib/
    schema.js   记录结构与版本规则（比较、墓碑 TTL、载荷校验）
    idmap.js    本地书签 id ↔ 同步 UUID 映射
    merge.js    最后写入优先 + 墓碑优先的合并算法
    tree.js     书签树快照 / 变更计划 / 执行 / 同级顺序对齐
    sync.js     同步编排：快照→拉取→解密→合并→写回→加密→上传
    crypto.js   PBKDF2 + AES-GCM 信封
    gist.js     GitHub Gist 客户端（GET/PATCH、ETag、限流与错误映射）
    store.js    settings / 状态 / 日志的本地存储
    browserapi.js  chrome.* 与 browser.* 的适配层
tests/           单元测试与集成测试（含两台设备往返）
tools/demo/      内存版书签树 + 内存版 Gist + 双设备演示脚本
tools/gen-icons.mjs  零依赖 PNG 图标生成
```

## 已知限制

- **仅手动同步**：不会后台定时拉取，也不会在书签变动时自动推送——这是刻意的设计，避免无提示地消耗 GitHub API 额度（未认证/认证 token 为 5000 次/小时，正常使用远低于额度）；
- **Firefox 的「书签菜单」根（menu________）不参与同步**：Chrome 没有对应的容器，强行映射会打乱结构；其余三个根（工具栏 / 未分类 / 移动端）完全同步。同步日志会提示跳过的根；
- 书签的**同级顺序**会对齐到合并结果；两边同时插入到同一位置时由索引 + 标题决定顺序；
- 同步以整棵树为单位（快照式），没有增量 diff 传输：书签数量在数千量级时单次载荷仍在 Gist 限制内，但不适合数万条的超大书签库；
- 不支持选择性同步（排除某些文件夹）、不支持书签搜索或管理界面、不含 Safari 版本；
- 冲突不提供逐条人工确认界面，一律按上述规则自动裁决，裁决依据可在同步日志中查看计数。
