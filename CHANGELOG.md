# lamezia-intercom CHANGELOG

> fork 自 CECP 敬拜团内通，供 Lamezia 教会独立部署（独立 Cloudflare 账号 / 仓库 / Pages）。

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
