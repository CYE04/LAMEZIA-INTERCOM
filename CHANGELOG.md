# lamezia-intercom CHANGELOG

> fork 自 CECP 敬拜团内通，供 Lamezia 教会独立部署（独立 Cloudflare 账号 / 仓库 / Pages）。

## v3.0.0-lamezia.7（2026-08-07）合并 CECP 的工具条收起 + 歌单拖动排序

上游本轮只动前端（`cecp.js` +8.4KB），**worker 完全没变**，所以后端不用重新部署
（除非你上次没部署 v3.0.0-lamezia.6 的墨迹三修复）。

### 从上游拿到的

- **墨迹工具条可收起**：新增 `ink-collapse` 动作，工具条收起后变成一个可拖动的小圆浮标
  （`bindInkMiniDrag` / `expandInkBar`）。**新版默认就是收起状态**，点浮标展开，
  且展开时自动选中「笔」，不用再手动切工具。
- **歌单拖动排序**：`bindSetlistDrag` / `moveSong`，拖动重排后自动同步给全房间。
  复用现有的 `setlist_set` 消息，**没有新协议**，worker 无需改动。

### 本地改动重打情况

上游没有改动任何本地补丁的锚点，18 处全部原样重打成功。
清空确认的 fail-safe 修复（`var ok = false`）需要重打——上游那边仍是默认 `true`。

### 修复：上游新加的页脚带了 CECP 的教会名

上游本轮在选设备页和现场页各加了一行页脚：

```
© 帕多瓦华人教会 · Powered by YuEn
```

「帕多瓦华人教会」是 CECP 自己的教会名，硬编码在 `cecp.js` 里两处。
这类品牌串台正是本 fork 要避免的，而且**只搜 `CECP` 字样抓不到它**。

改为可配置：新增 `data-org-name`（`config.js` 里的 `ORG_NAME`），缺省回落到 `APP_NAME`。
**请在 `config.js` 里把 `ORG_NAME` 填成你们教会的正式名称**，
否则页脚会显示「© LAMEZIA 敬拜内通 · Powered by YuEn」——不算错，但不是教会名。

### 新增：`tools/test-worker.mjs` 回归测试套件

每次从上游合并都要确认本地修复没被冲掉，之前这套测试放在临时目录、被清掉过两次。
现在收进仓库（构建期工具，纯 Node 标准库，不进运行时）：

```bash
node tools/test-worker.mjs
```

35 项，覆盖音控 fail-closed 鉴权、设备占用按设备比对、墨迹三修复、激光笔、
共享歌单与排序、每日清理。**每次合并上游之后跑一遍。**

### 其它

- `sw.js` 的 `CACHE_VERSION` 由 `v5` → `v6`。


## v3.0.0-lamezia.6（2026-08-04）修复上游墨迹功能的三个问题

上游这套墨迹功能刚合并进来就发现三处问题，**CECP 那份同样存在**。

### 1. undo 忽略 `msg.id`，会删错笔画

前端在 4 处带具体 id 发 undo（移动文字、撤销栈、笔画橡皮、局部擦，
`cecp.js` 里搜 `op: 'undo'`），服务端却完全不读 id，一律「从尾部找发送者自己最后一笔」删掉。

后果：用橡皮擦掉一条较早画的线 X → 服务端删的是自己最新那笔 Y →
**X 刷新后复活，Y 永久消失**。局部擦更糟：原条没删、碎片又写进去，笔迹重复叠加。

改为按 id 查找删除；不带 id（老客户端）才退回原来的「撤自己最后一笔」。
按 id 删**不校验归属**，与前端橡皮一致（前端允许擦别人的记号）。

### 2. 免凭据的 listener 能一条消息永久清空全房间标注

`case 'ink'` 原本只检查 `if (!meta || !meta.role) break;`，而 listener 注册是完全免凭据的。
发一条 `{type:'ink',op:'clear',song:'…'}` 就把该曲标注清空并落盘，**服务端无恢复路径**。
逻辑上也自相矛盾：undo 保护成「只撤自己的」，clear 却能抹掉所有人的。

改为 `clear` 要求 `role` 是 `client` 或 `operator`，排除 listener。
（要更严可以把这行改成只允许 `operator`。）

前端配套修复：清空的确认框原本是

```js
var ok = true;
try { ok = window.confirm(...); } catch (err) {}
```

**默认 true** —— PWA / WebView 里 confirm 被拦截抛异常时，误触垃圾桶就无提示清空全房间。
改为默认 `false`，catch 里也置 `false`。

### 3. 存储无总量上限，超限后墨迹静默失效

`ink_v1` 是**一个** key 装所有歌的所有笔画。SQLite-backed DO 的「键+值」上限是 2MB，
而单笔最坏 600 点 ≈ 9.7KB，**光一首歌 400 笔就约 3.9MB**；歌曲数量更是完全无上限。

失败模式尤其糟：`_loadInk()` 返回的就是 `this._ink` 本体，`push` 已经改脏缓存；
`put` 抛异常后 `_broadcast` **永不执行** —— 画的人自己看得见，别人一笔收不到，无任何提示；
此后每条 ink 消息都带着超限对象重试、次次失败，直到 DO 重启或跨天。

改为：
- 新增 `INK_MAX_SONGS = 40`（超了按最后活动时间丢最旧的歌）
- 新增 `INK_MAX_BYTES = 1500000` 总字节预算（留足余量顶住 2MB）
- 新增 `_saveInk()`：落盘前先裁到预算内，`put` 包 try/catch
- 失败时丢弃脏缓存（`this._ink = undefined`）并回 `error / ink_full` 给发送方，
  不再静默失效

### 其它

- `sw.js` 的 `CACHE_VERSION` 由 `v4` → `v5`。

> 这三处都是上游 CECP 也有的问题。


## v3.0.0-lamezia.5（2026-08-04）合并 CECP 的同步标注 + 激光笔

从上游同步。合并方式同上一轮：**以 CECP 新版 `cecp.js` 为基底，把本项目的本地改动逐条重打**；
worker 只挑新增的消息类型，**不整份覆盖**（上游 worker 仍缺我们的两处修复，见下）。

### 从上游拿到的

- **同步标注（墨迹）**：画笔 / 荧光笔 / 形状 / 文字框 / 橡皮，可撤销重做，
  工具条可拖动，笔宽压感、直线吸附等偏好本地保存。标注按「歌 + 视图」分组，
  全房间实时同步，隔天随每日清理自动清空（歌单保留）。
- **激光笔**：即时指示，不存盘，只转发给别人。
- 上游 `cecp.js` 其余改动一并带入（42 个新函数）。

### worker：只挑了 `ink` / `ink_get` / `laser`

| 移植内容 | 说明 |
|---|---|
| `INK_KEY` / `INK_MAX_PER_SONG`(400) / `INK_MAX_PTS`(600) | 存储上限，防止画满撑爆 DO storage |
| `this._ink` 懒加载字段 | 构造函数 |
| `case 'ink'` | stroke / undo / clear；**undo 只撤自己那一笔** |
| `case 'ink_get'` | 换歌或刚进来时拉取已有标注 |
| `case 'laser'` | 不写盘，`_broadcast(payload, ws)` 排除自己 |
| `_loadInk()` | 懒加载 |
| `round3()` | 坐标压到 3 位小数，控存储与带宽 |
| 每日清理 | 清 `INK_KEY`，歌单保留 |

**上游 worker 仍未修复的两处**（所以继续不整份覆盖）：
1. 音控鉴权仍是 fail-open 的 `OP_PIN`
2. 设备占用检查仍比完整显示名 → 同一设备可被多人占用

### 前端：改用上游的 `ensureTakenFeed`

上游这轮独立修复了「选设备界面收不到占用列表」的问题，新增 `ensureTakenFeed()`，
做法与本项目 v3.0.0-lamezia.4 的 `ensureSetupPresence()` 相同。
**本轮起改用上游实现，删掉本地的 `ensureSetupPresence`**，减少长期分叉。
（注意：这只是前端置灰，真正拦住重复占用的仍是本项目 worker 里的 `deviceOf()` 修复。）

### 本地改动重打情况

上游本轮**没有改动**任何本地补丁的锚点位置，18 处改动全部原样重打成功：
常量 / 命名 / 话筒1-8 与 `MIC_TONES` / `appName` / 安全区样式 / 默认房间名 /
音控密钥记忆与自动登录 / 4001 处理 / `emit()` 与 `cecp:role`、`cecp:switch-identity` /
`data-auto-role` 直达 / 三处「切换身份」按钮（成员端、音控台、现场界面）。

### 外部依赖：没有新增，但发现一个硬编码的

墨迹与激光**完全自包含**，只走 WebSocket，没有引入任何新的外部地址。

不过扫描时发现现场模式的**音频（mp3）地址是硬编码的** `https://cecp.it`
（`cecp.js` 内 `renderScore` 附近），与其它四个外部地址不同，**没有对应的 `data-*` 可覆盖**。
以后要让 Lamezia 完全独立，这一处需要额外改代码。

墨迹偏好存在 `storeKey('inkpen')` / `storeKey('inkbar')`，走既有命名空间，不与现有键冲突。

### 其它

- `sw.js` 的 `CACHE_VERSION` 由 `v3` → `v4`。


## v3.0.0-lamezia.4（2026-07-31）修复：同一设备可被多人同时占用

同一支话筒能被两个人同时选中，且选设备界面完全不置灰。查下来是**两个独立的 bug**，
一前端一后端，各自都能单独造成问题：

### 后端：占用判断比的是完整显示名，不是设备

`worker/index.js` 的重复占用检查原本是：

```js
return m?.role === 'client' && m?.name === regName;
```

但注册名是「设备｜人名」（前端 `buildDisplayName`），
所以 `🎤 话筒3｜小明` 和 `🎤 话筒3｜小红` 不相等 → 检查形同虚设，
**两个人可以同时占用同一支话筒**。这是「多人选同一设备」的真正原因。

改为新增 `deviceOf()`（按 `｜` / `|` 取设备部分，与前端 `getDeviceFromDisplayName` 对齐），
只比设备部分。

### 前端：选设备界面根本没有连接，收不到占用列表

合体入口选「敬拜团」后直接 `showSetup()`，全程没有 `connect()`，
所以 `taken_devices` 永远收不到，`this.takenDevices` 一直是空数组 → 什么都不置灰。
（前端的 `isDeviceTaken` 逻辑本身是对的，会剥掉人名只比设备，只是没有数据。）

新增 `ensureSetupPresence()`：进入选设备界面时若尚无连接，先以 `listener` 身份接入
（不占设备名、不进 `member_list`，worker 本来就会给 listener 发 `taken_devices`）。
选好设备后 `joinAsClient` 在同一条连接上重新 register 成 client。

> 这个前端问题是从上游继承的：三页时代 `member.html` 用 `data-mode="auto"` 会先连
> listener 所以正常，而 `menu` 模式没有这条路径。

### 其它

- `sw.js` 的 `CACHE_VERSION` 由 `v2` → `v3`。


## v3.0.0-lamezia.3（2026-07-31）合并 CECP 的现场模式（live）

从 CECP 上游同步。合并方式：**以 CECP 新版 `cecp.js` 为基底，把本项目的 19 处改动逐条重打上去**
（而不是把上游的差异往本地文件上挑），这样能一并拿到上游的全部改动，
且本地改动清单是已知的、可逐条核对。

### 从上游拿到的

- **现场模式（live）**：谱 + 内通同屏。段落 cue（前奏 / 主歌 / 预副歌 / 副歌 / 桥段 / 间奏 / 尾声）、
  曲库选歌、缩放、上一首 / 下一首、原图与移调切换、内嵌音频。
  合体入口选「敬拜团」后默认进这个界面（`data-menu-live="0"` 可退回纯内通界面）。
- **共享歌单**：任何已注册的人都能改，改完服务端广播给全房间并持久化。
- 上游 `cecp.js` 的其余改动一并带入。

### worker：只挑了 `setlist_set`

**上游 worker 仍是旧的 fail-open `OP_PIN` 逻辑**（密钥没配置就放行），
所以没有整份覆盖，只移植了 `setlist_set` 这一个消息类型 + `_sendSetlistTo`
+ `SETLIST_KEY` / `SETLIST_MAX`，本项目的 fail-closed 音控鉴权原样保留。

歌单是**服务端往返**的：前端发 `setlist_set`，等服务端广播回 `setlist` 才更新 UI。
所以 worker 不部署这次改动的话，现场模式加不了歌。

### 本地改动在新基底上的调整

| # | 说明 |
|---|---|
| 7 | `pick-role` 上游新增了 live 分支，音控免密登录合并进新结构（并置 `useLiveUI = false`） |
| 14 | `boot()` 的 `data-auto-role` 直达逻辑补上 `useLiveUI` 赋值，直达成员端时同样进现场界面 |
| 17 | `cecp:role` 事件新增在 `showLive()` 里派发 |
| 18 | 现场界面头部也加了「切换身份」（⇄ 图标，与 👤 换设备并列） |

### 其它

- `sw.js` 的 `CACHE_VERSION` 由 `v1` → `v2`。

### 外部依赖（需要知情）

现场模式的谱功能依赖 CECP 名下的四个外部地址，**均未 vendor 进本仓库**：

| 用途 | 地址 |
|---|---|
| 简谱引擎（运行时动态插入 `<script>`） | `https://cye04.github.io/Cecp/youth-engine.js` |
| 曲库站 | `https://musiclib.cecp.it` |
| 曲目列表 | `https://api.github.com/repos/CYE04/Cecp/contents/songs` |
| 谱 / 音频文件 | `https://cye04.github.io/Cecp/…` |

后果：装到主屏幕后**离线看不了谱**（Service Worker 只缓存同源）；
`api.github.com` 未认证有每小时 60 次限流；本项目长期依赖 `Cecp` 仓库不被改名或删除。
内通本身（快捷信息、群聊、广播、音控台）不受影响，离线仍可打开。


## v3.0.0-lamezia.2（2026-07-30）单一入口 + PWA + 分发页

### 新增文件

| 文件 | 作用 |
|---|---|
| `index.html` | 单一入口页：挂 `<cecp-intercom data-mode="menu">`，身份记忆、`?mode=` 直达、Screen Wake Lock、SW 注册 |
| `install.html` | 发给同工的安装引导页：二维码 + 分平台图文步骤 + 微信内置浏览器警告 + 复制链接 |
| `config.js` | 全站配置集中化（`WS_URL` / `ROOM` / `APP_NAME` / `STORE_KEY` / `ROLE_KEY`） |
| `manifest.json` | PWA 清单，`display: standalone`，全部相对路径 |
| `sw.js` | Service Worker，静态资源 cache-first，`CACHE_VERSION` 手动 bump |
| `icons/*.png` | 192 / 512 / maskable-512 / apple-touch-icon |
| `vendor/qrcode.js` | 自带 QR 生成器（字节模式，版本 1–10，纠错 M），不走 CDN |
| `tools/make-icons.py` | 纯 Python 标准库的图标生成器（手写 PNG 编码），构建期用 |
| `tools/icon.svg` | 图标矢量源，参数与生成脚本一致 |
| `README.md` | 面向非技术同工的部署清单 |
| `.gitignore` | 新增（原本没有）；确保 `.dev.vars`、`.DS_Store`、`node_modules` 不进仓库 |

### 删除

- `intercom.html` — 旧的 CECP 单页入口，`data-ws-url` 指向 **CECP 教会的 worker**
  （`wss://cecp-ws.cecp.workers.dev`）。留在仓库里会让扫到它的人连到另一个教会的房间，
  且与新的 `index.html` 职责重复。

### cecp.js 追加改动（承接上一版的清单，编号续排）

| # | 位置 | 改动 |
|---|---|---|
| 13 | `readConfig` | 新增 `data-auto-role`，供入口页写入「记住的身份」 |
| 14 | `boot()` 的 menu 分支 | 按 `autoRole` 直达对应界面；音控仅在本机已有验证过的密钥时才自动进（否则会闪一下空看板再弹密码框） |
| 15 | 新增 `emit()` | 统一往宿主元素派发 `cecp:*` 事件，避免宿主页面去翻 Shadow DOM |
| 16 | 新增 `switchIdentity()` + `switch-identity` action | 「切换身份」：回角色选择页并通知宿主忘掉记忆 |
| 17 | `backToMenu()` / `showOperator()` / `showClient()` / `showSetup()` | 派发 `cecp:role`，宿主据此记住身份、开关 Wake Lock |
| 18 | 成员端与音控台头部 | 增加「切换身份」按钮（仅 menu 模式显示） |
| 19 | `.cf.is-page.is-fullscreen` 样式 | `inset:0` 改为四边 `env(safe-area-inset-*)`，适配刘海屏与底部手势条；上下都锚定后不再需要 `100dvh` |

### worker 追加改动

- `wrangler.toml`：`name` 改为 `ws-lamezia`；新增 `[vars]` 段的 `ALLOWED_ORIGINS`、`DAILY_RESET_TZ`。
- CORS 从 `Access-Control-Allow-Origin: *` 改为按 `ALLOWED_ORIGINS` 白名单回显，
  localhost / 127.0.0.1 任意端口自动放行；WebSocket 升级请求的 `Origin` 不在白名单时回 403。
  > 边界说明：浏览器对 WebSocket 不做 CORS 拦截，此项只能挡「别的网站用浏览器驱动房间」，
  > 挡不住不发 `Origin` 的脚本客户端。真正的权限边界仍是 `OPERATOR_KEY`。

### 修正

- **`vendor/qrcode.js` 格式信息副本写错**：第二份格式信息的左下竖列原本写了 8 位（bit 0–7），
  但 `size-8` 那格是固定暗模块、不属于格式信息，导致 bit 7 被暗模块覆盖、两份副本不一致。
  改为左下 7 位（bit 0–6）+ 右上 8 位（bit 7–14）。
  （由「独立反向解码」测试发现——渲染出来看着正常，但扫描器读到的格式信息是坏的。）


## v3.0.0-lamezia.1（2026-07-30）音控鉴权收紧 + 改名

### ⚠️ 破坏性变更：必须配置 `OPERATOR_KEY`，否则没人能进音控台

部署后**必须**执行一次，否则所有 operator 注册都会被拒：

```
wrangler secret put OPERATOR_KEY
```

### 安全：音控权限改为 fail closed（本次的核心）

旧逻辑 `worker/index.js` 里是：

```js
const need = String((this.env && this.env.OP_PIN) || '').trim();
if (need) { /* 只有配了 OP_PIN 才校验 */ }
```

密码校验本身在服务端（不是纯前端），但**密钥没配置时整段跳过 = 直接放行**。
新部署的默认状态恰好就是「没配置」，等于任何人手工发一条 `role:"operator"` 的
register 就能拿到广播 / 踢全员 / 改所有请求状态的权限。

改为：

- **密钥未配置 → 一律拒绝**（`reason: not_configured`），不存在放行分支。
- operator 注册必须出示密钥，两条路径：
  - `register.key`（前端默认走这条：查询串会进 Cloudflare 日志与中间代理，消息体不会）
  - 握手 `?key=`（给「音控台电脑存书签」用）
- 校验失败：`register` 路径回 `op_denied` 并以 **close code 4001** 断开；
  握手路径直接回 **HTTP 401**，连 WebSocket 都不建立。
- 密钥比较用定长比较（`timingSafeEqual`），不逐字符提前返回。
- 连续失败递增延迟（250ms × 次数，上限 2s）；失败即断开，重试必须重新握手，
  在线暴力破解成本大幅上升。成功后计数清零。
- 握手验过的连接在 attachment 里记 `opAuth`，`register` 改用 `_setMeta` 合并写入，
  避免整体覆盖把 `opAuth` 冲掉。

**已知未覆盖**：`client` / `listener` 角色仍然无凭据即可连接（任何拿到地址的人都能
以敬拜团身份发请求、收广播）。本次只收紧 operator，未引入房间级密钥。

### worker/index.js 其它改动

- 默认房间名 `cecp-main` → `lamezia`。
- 健康检查页与 service 字段的 `CECP` → `Lamezia`。

### cecp.js 改动清单（逐条）

未重写核心逻辑，也未改动已有的身份选择界面结构，只做以下增补：

| # | 位置 | 改动 |
|---|---|---|
| 1 | 顶部常量 | 新增 `CLOSE_OP_DENIED = 4001`，与 worker 的 `OP_DENY_CLOSE_CODE` 对齐 |
| 2 | `initState` | 新增 `this.opKey`，从 `localStorage` 读已验证过的音控密钥 |
| 3 | `sendRegister` | operator 注册改发 `reg.key`（原 `reg.pin`），密钥走消息体不走 URL |
| 4 | `handleMessage` 的 `ack` | 服务端确认后才把密钥写入 `localStorage`（避免存错密码） |
| 5 | `enterOperator` | 新增可选参数 `presetKey`，支持用已存密钥免密登录 |
| 6 | `onOpDenied` | 失败时清除已存密钥；区分 `not_configured` / `key_required` / `key_wrong` 给出不同文案 |
| 7 | `onAction` 的 `pick-role` | 已存密钥则直接验证登录，否则才弹密码框 |
| 8 | `connect` 的 `close` 监听 | 收到 4001 不再自动重连（兜底：即使 `op_denied` 没先到也不会反复撞密码） |
| 9 | `DEFAULT_PRESETS` | 9 个颜色话筒 → `话筒1`…`话筒8`，乐器不变 |
| 10 | `detectIdentityTone` | 新增 `MIC_TONES`，编号话筒各配一色，卡片仍能一眼区分 |
| 11 | `readConfig` + 4 处标题 | 新增 `data-app-name`（默认 `LAMEZIA 敬拜内通`），菜单页 / 成员端 / 音控台 / 悬浮条标题统一读它，不再硬编码教会名 |
| 12 | 定向广播 chip | `全体（含 youth）` → `全体（含旁听）`（youth 是原项目的页面，与本部署无关） |

保留未改的 `CECP` 标识符：`window.CECPIntercom`、`window.__CECP_INTERCOM_V2__`、
自定义元素名 `<cecp-intercom>`、文件名 `cecp.js`、localStorage 前缀 `cecp2:`。
这些是代码标识符不是界面文案；改名会影响已有嵌入写法与已存状态，故保留。


## v2.1.0（2026-07）UI 重做：Apple 风 + 四角停靠 + 方向自适应

纯前端改版（cecp.js），协议与 worker 无任何变化。

- **视觉全面重做（Apple 官网风）**：中性近白/近黑双主题 + 单一强调蓝（light `#0071e3` / dark `#2997ff`）、SF/system-ui 字体层级、发丝线 + 弥散浅影替代边框色块、标题栏/悬浮球/toast 克制毛玻璃（`backdrop-filter`）、Tab 改 Apple 分段控件；旧暖米/金/绿全部移除。
- **悬浮球图标**：Yesicon（Iconify `solar:headphones-round-sound-bold`）内联 SVG、`currentColor` 随主题；常驻声波条呼吸、悬停放大提亮、按下弹簧回弹、未读蓝色声波扩散 ripple + 角标、高优未解决红色急促 ripple；`prefers-reduced-motion` 下全部静止。
- **四角停靠**：`data-corner` 四角可配，面板标题栏可手动换角并记住（localStorage）；初始化自动避让——「工具导游」（`rt5` 系固定元素）硬规则永不同角（MutationObserver 盯 DOM/样式变化实时重避让），回到顶部按钮、footer FAB 等软障碍自动纵向让位。
- **贴角形状**：面板与悬浮球共用「从角长出来」的圆角语言——靠屏幕角一侧圆角小（9px/8px）、朝内三侧圆角大（26px/19px），四角镜像，展开动画以停靠角为 transform-origin。
- **方向自适应**：按视口宽高比（非 UA）实时切换——横向视口面板横铺（≤760×520，快捷信息 4 列）、纵向视口竖排（≤392 宽）、小屏竖屏近全屏 sheet + 遮罩；resize/转屏即时生效，任何情况不超出视口，内部滚动。
- 旧 `data-float-side` 属性继续兼容（映射为底部两角）。


## v2.0.0（2026-07）

前端从 0 重写为单文件零依赖 Web Component（`<cecp-intercom>` + Shadow DOM，兼容旧 `#cecp-root` 嵌入）；worker 协议扩展。**所有 v1 消息类型原样保留，旧前端 + 新 worker 可正常混跑。**

### Worker 协议新增（worker/index.js）

| 项 | 方向 | 字段 | 说明 |
|---|---|---|---|
| 房间路由 | 连接时 | `?room=xxx`（URL 查询参数） | `[\w-]{1,64}`，缺省 `cecp-main`；每个房间一个 Durable Object 实例 |
| listener 角色 | C→S | `register.role = 'listener'` | 只收 `broadcast`（全体）与 `taken_devices`；不占设备名、不进 `member_list`、无重名检查；同一连接可重新 `register` 升级为 client |
| 请求优先级 | C→S | `worship_msg.priority: 'normal'\|'high'` | 服务端校验后原样转发给 operator |
| 请求状态机 | C→S / S→C | `msg_status {id, status:'pending'\|'doing'\|'done'}` | 仅 operator 可发；服务端广播给全部 operator + 全部 client，前端按 `id` 匹配自己的请求（无服务端存储，天然兼容 DO 休眠） |
| 定向回复 | C→S / S→C | `operator_reply {to, id, text}` | 仅 operator 可发；只投递给 `name === to` 的 client |
| 定向广播 | C→S | `broadcast.target: 'all'\|{names:[…]}` | 缺省 `all`（client + listener）；`{names}` 只投递给命中的 client（listener 无名字，不参与定向） |
| taken_devices 扩发 | S→C | — | 原只发 client，现也发给 listener（升级前的选设备界面需要置灰已占设备） |

### 向后兼容说明

- 旧前端收到新增类型（`msg_status`/`operator_reply`）会进入其 `default` 分支报 `unknown_type`，不影响运行。
- 旧前端的 `register`/`worship_msg`/`member_chat`/`broadcast`/`kick`/`kick_all`/`ping` 行为与响应完全不变。
- 旧前端连接不带 `?room=` → 仍进 `cecp-main`。

### 前端 v2（cecp.js）

- 单文件 Web Component，全部样式在 Shadow DOM 内，与宿主页面（含 youth-engine 的全局样式）双向零污染；同页多实例安全（需不同 `data-page-key`）。
- 新增 `data-mode="auto"`（youth：被动 listener + toast，点开升级 client）、`data-room`、`data-theme`。
- 敬拜端：四组快捷信息（含 high 优先级）、快捷/聊天双 Tab、请求状态回填、震动反馈、换设备确认+名字保留。
- 音控台：声部分组看板、请求状态机、定向回复、高优警报（WebAudio+震动+边框闪烁+可静音）、定向广播 chips。
- 断线自动重连（指数退避）+ 顶部断线提示条；每日午夜本地清理保留。
- 不再需要 `cecp.css`（文件保留仅防旧页面 404）。
- v2 不再有 v1 page 模式的「接管整页、隐藏宿主其它元素」行为，改为填满自身容器。
