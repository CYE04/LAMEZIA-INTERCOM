# LAMEZIA 敬拜内通 — 技术说明

面向要改代码的人。只想部署的话看 [README.md](README.md) 就够了。

本项目是 CECP 敬拜团内通的独立分支：独立的 Cloudflare 账号、独立仓库、独立 Pages。
与原项目最大的结构差异是 **单一入口**：不再有三个页面三个链接，
只有一个 `index.html`，进去先选身份（敬拜团 / 音控组），音控组要密码。

---

## 1. 结构总览

```text
index.html          单一入口。挂 <cecp-intercom data-mode="menu">，身份在组件内部选
install.html        发给同工的引导页：二维码 + 分平台步骤 + 内置浏览器警告
config.js           ★ 全站配置，唯一需要改的地方
cecp.js             全部界面与协议逻辑（单文件 Web Component，样式在 Shadow DOM 内）
cecp.css            v1 遗留文件，v2 完全不用（保留仅为避免旧页面 404）
manifest.json       PWA 清单
sw.js               Service Worker，cache-first + 手动 CACHE_VERSION
icons/              PNG 图标，由 tools/make-icons.py 生成
vendor/qrcode.js    自带的 QR 生成器（不走 CDN）
tools/              构建期脚本，不参与运行时
worker/             Cloudflare Worker + Durable Object
```

**没有构建步骤。** 所有前端文件浏览器直接能跑，改完刷新即可。

---

## 2. 相对路径（最容易踩的坑）

GitHub Pages 把站点挂在 `/<仓库名>/` 子路径下，
比如 `https://cye04.github.io/LAMEZIA-INTERCOM/`。

**任何以 `/` 开头的绝对路径都会 404。** 本项目已全部处理：

| 位置 | 写法 |
|---|---|
| `index.html` / `install.html` 引脚本、图标、manifest | `config.js`、`icons/…`、`manifest.json` |
| `manifest.json` 的 `start_url` / `scope` / `icons.src` | `./index.html`、`./`、`icons/…` |
| `sw.js` 的预缓存列表 | 全部 `./…` |
| Service Worker 注册 | `register('sw.js', { scope: './' })` |
| `install.html` 里的入口网址 | `new URL('index.html', location.href).href` |

改代码时保持这个习惯。本地 `python3 -m http.server`（根路径）和
Pages（子路径）两种情况都要能跑。

### localStorage 命名空间

`cecp.js` 的存储键默认带 `location.pathname`。这在单入口 + PWA 下会出问题：
装到主屏幕后启动地址是 `./index.html`，而直接打开可能是目录根 `/仓库名/`，
两者 pathname 不同 → 被当成两份独立存档 → 音控要重输密码、成员要重选设备。

所以 `index.html` 显式传了固定的 `data-page-key`（来自 `config.js` 的 `STORE_KEY`），
不让它跟着路径走。**不要去掉这个属性。**

> 顺带说明：三个页面时代靠 `data-page-key` 做角色隔离，单入口后不再需要——
> 各角色用的存储后缀本来就不重叠（音控是 `opkey` / `opmute`，
> 成员是 `name` / `person` / `req:*` / `chat`），不会互相污染。

---

## 3. 身份与记忆

```text
index.html 决定 data-auto-role ──► cecp.js boot()
      │                                  │
      │ ?mode=operator / ?mode=client     ├─ 有 auto-role 且条件满足 → 直接进对应界面
      │ 或 localStorage 里上次的身份       └─ 否则 → 显示角色选择页
      │
      └── 监听组件抛出的 cecp:role / cecp:switch-identity 事件来更新记忆
```

- **`?mode=operator`**：跳过选择页直接进音控台，适合调音台电脑存书签。
  同时会被记住，之后不带参数打开也直达。
- **记忆清除**：点「切换身份」或从密码框点「返回」，都会回到选择页并忘掉记忆。
- **音控自动登录**：只在本机已存有验证通过的密钥时才发生。
  密钥失效（比如换了密码）会自动退回密码框并给出提示。

组件对外抛的两个事件：

| 事件 | 时机 | 宿主页面用途 |
|---|---|---|
| `cecp:role` | 进入某身份 / 回到选择页，`detail.role` 为 `'operator'`/`'client'`/`null` | 记住身份、开关 Screen Wake Lock |
| `cecp:switch-identity` | 点了「切换身份」 | 把 `?mode=` 从地址栏去掉 |

---

## 4. 音控鉴权

**权限判断全部在服务端。** 前端只负责收集密码和展示结果。

```text
用户输密码
   └─► register { role:'operator', key:'…' }   （走消息体，不走 URL 查询串）
          └─► worker 比对 env.OPERATOR_KEY（定长比较）
                 ├─ 通过 → attachment 记 opAuth=true，回 ack
                 └─ 失败 → 回 op_denied + close 4001，前端清掉本地密钥并提示
```

要点：

- **fail closed**：`OPERATOR_KEY` 没配置时一律拒绝（`reason: not_configured`），
  不存在「没配就放行」。
- 密钥也可以走握手 `?key=`（存书签用），失败时直接 HTTP 401，
  连 WebSocket 都不建立。
  > 为什么这条路径不用 4001：workerd 里在 `fetch` 上下文中对已 accept 的
  > WebSocket 调 `close()` 会静默失效（返回正常、`readyState=2`，但 close frame
  > 到不了客户端），客户端只会干等。前端因此默认走 register 那条路径。
- 连续失败递增延迟（250ms × 次数，上限 2s）并断开，重试需重新握手。
- **`client` / `listener` 无需凭据**。拿到链接就能以敬拜团身份连接。
  这是刻意的取舍；要加房间级密钥的话需要另外实现。

设置 / 更换密码：

```bash
cd worker && npx wrangler secret put OPERATOR_KEY
```

---

## 5. 配置项

`config.js`：

| 键 | 说明 |
|---|---|
| `WS_URL` | ★ Worker 的 wss 地址，部署后必填 |
| `ROOM` | 房间名，要和 `worker/wrangler.toml` 的默认值一致 |
| `APP_NAME` | 界面上显示的名称，各处标题都读它 |
| `STORE_KEY` | localStorage 命名空间，固定值，别改成跟路径走 |
| `ROLE_KEY` | 记住身份用的键名 |

`worker/wrangler.toml`：

| 键 | 说明 |
|---|---|
| `name` | Worker 名，决定 `*.workers.dev` 的子域 |
| `ALLOWED_ORIGINS` | 允许连接的来源，逗号分隔；localhost 任意端口自动放行 |
| `DAILY_RESET_TZ` | 每日凌晨清理的时区 |

> CORS 的边界：浏览器对 WebSocket 不做 CORS 拦截，
> 所以这项只能挡「别的网站用浏览器驱动你的房间」，挡不住 curl 这类脚本
> （它们根本不发 Origin）。真正的权限边界是 `OPERATOR_KEY`。

---

## 6. 组件属性（`cecp.js`）

`index.html` 用到的：

| 属性 | 说明 |
|---|---|
| `data-ws-url` | 必填，Worker 的 wss 地址 |
| `data-room` | 房间名 |
| `data-mode` | 本项目固定 `menu`（合体入口） |
| `data-app-name` | 教会 / 应用名，菜单页、成员端、音控台标题统一读它 |
| `data-page-key` | localStorage 命名空间，务必固定 |
| `data-auto-role` | `operator` / `client`，跳过选择页直达（由入口页写入） |

其余仍然支持但本项目没用到：`data-layout`、`data-presets`、`data-cues`、
`data-broadcast-presets`、`data-theme`、`data-corner`、`data-member-chat` 等，
说明见 `cecp.js` 顶部注释。

设备列表默认是 `话筒1`–`话筒8` + 钢琴 / 键盘 / 吉他 / 电吉他 / 贝斯 / 鼓。
要改的话既可以改 `cecp.js` 里的 `DEFAULT_PRESETS`，
也可以在 `index.html` 上加 `data-presets='["…","…"]'` 覆盖。

---

## 7. PWA

- `manifest.json`：`display: standalone`，`start_url` 用 `./index.html`。
  单入口所以只需要一个 manifest。
- `sw.js`：静态资源 cache-first。**完全不碰 WebSocket** —— WS 不经过 `fetch` 事件，
  Service Worker 里也显式跳过非 GET、跨域、非 http(s) 的请求。
- **改前端后必须手动把 `CACHE_VERSION` 加 1**，否则老用户拿不到更新。
- 图标：`python3 tools/make-icons.py`（纯标准库，不需要装任何东西）。
  `tools/icon.svg` 是同参数的矢量版，给设计师用；改了要同步改脚本再重新生成。

---

## 8. 本地验证

```bash
# 后端（另开一个终端）
cd worker && npx wrangler dev --port 8787 --local
```

本地跑后端需要在 `worker/.dev.vars` 里放测试密钥（该文件已被 `.gitignore` 忽略）：

```text
OPERATOR_KEY = "你的测试密码"
```

前端要**同时验证根路径和子路径**：

```bash
# 根路径：http://localhost:8080/
python3 -m http.server 8080

# 子路径：http://localhost:8081/<本文件夹名>/  ← 模拟 GitHub Pages
cd .. && python3 -m http.server 8081
```

检查项：

- [ ] 角色选择页正常显示
- [ ] 音控组：错密码有红字提示，对密码进看板
- [ ] 刷新后直达上次身份，「切换身份」能回到选择页
- [ ] `?mode=operator` 直达音控台
- [ ] 敬拜团能选设备、填名字、显示「在线」
- [ ] DevTools → Application → Service Workers 里 scope 带子路径
- [ ] `install.html` 二维码扫出来是入口页地址

---

## 9. 现场模式（live）

合体入口选「敬拜团」后进的是现场界面：谱 + 内通同屏 + 段落 cue。
`data-menu-live="0"` 可退回纯内通界面。

**共享歌单是服务端往返的**：前端发 `setlist_set`，服务端存进 DO storage 并广播
`setlist` 回来，前端收到才更新 UI。所以 worker 没部署 `setlist_set` 的话，
歌单点了没反应——这不是前端 bug。任何已注册的人都能改歌单（台上要能随手翻歌）。

**谱功能依赖 CECP 名下的外部资源**（未 vendor 进本仓库）：

| 用途 | 地址 | 对应属性 |
|---|---|---|
| 简谱引擎 | `https://cye04.github.io/Cecp/youth-engine.js` | `data-score-engine` |
| 曲库站 | `https://musiclib.cecp.it` | `data-musiclib-base` / `data-musiclib-key` |
| 曲目列表 | `https://api.github.com/repos/CYE04/Cecp/contents/songs` | `data-lib-api` |
| 谱 / 音频 | `https://cye04.github.io/Cecp` | `data-songs-base` |

后果：**离线看不了谱**（SW 只缓存同源）、`api.github.com` 每小时 60 次限流、
本项目长期依赖 `Cecp` 仓库不被改名删除。内通本身不受影响，离线照常可用。
以后要独立，把这四个地址改到 Lamezia 自己的仓库 / 域名即可（都能用 `data-*` 覆盖）。

## 10. 同步标注与激光笔

现场界面顶部有一条可拖动的工具条：滑动 / 笔 / 荧光笔 / 形状 / 文字 / 橡皮 / 激光笔。

- **标注按「歌 + 视图」分组**（song key 形如 `0061xxx@img`），换歌自动切换，
  换视图（原图 / 移调）也是独立的一套。
- **服务端往返**：前端发 `ink`，worker 存进 DO storage 并广播；`ink_get` 拉取已有标注。
  和歌单一样，worker 没部署这些消息类型的话画了不同步。
- **undo 只撤自己那一笔**（服务端按 `by` 字段匹配），不会把别人的记号撤掉。
- **激光笔不存盘**，只即时转发给房间里其他人，自己不回显。
- **隔天自动清空**（跟当天的谱走）；歌单是「本周诗歌」所以保留。
- 存储上限：每首歌最多 400 笔，单笔最多 600 个点，坐标压到 3 位小数。
- 笔的偏好存在 `storeKey('inkpen')`，工具条位置存在 `storeKey('inkbar')`。

> 权限：任何已注册的人都能画（台上台下都要能标记），这是刻意的。

## 10.1 一处硬编码的外部地址

现场模式的**音频（mp3）地址硬编码为 `https://cecp.it`**，
在 `cecp.js` 的 `renderScore` 附近。与第 9 节那四个外部地址不同，
**它没有对应的 `data-*` 可以覆盖**。以后要让 Lamezia 完全独立于 CECP，
除了改那四个地址，还要改这一处代码。

## 11. 已知边界

- Screen Wake Lock 需要 https（或 localhost）；不支持的浏览器静默跳过。
- iOS 的「添加到主屏幕」只有 Safari 有；微信 / QQ 内置浏览器没有，
  `install.html` 会检测并提示。
- QR 生成器支持版本 1–10、纠错等级 M、字节模式，放 URL 绰绰有余；
  超长内容会抛错。
- 保留未改名的标识符：`window.CECPIntercom`、`window.__CECP_INTERCOM_V2__`、
  自定义元素 `<cecp-intercom>`、文件名 `cecp.js`、localStorage 前缀 `cecp2:`。
  它们是代码标识符不是界面文案，改名会影响已有嵌入写法和已存状态。
