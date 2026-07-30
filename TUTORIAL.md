# CECP 敬拜团内通系统 v2 — 部署与嵌入说明

```text
cecp-intercom/
├── cecp.js        ← 前端（单文件 Web Component，样式内置，零依赖零构建）
├── cecp.css       ← v1 遗留文件，v2 不再需要（保留仅为避免旧页面 404）
├── TUTORIAL.md    ← 本文档
├── CHANGELOG.md   ← v2 协议新增字段说明
└── worker/        ← Cloudflare Worker 后端（Durable Object 房间）
    ├── index.js
    ├── package.json
    └── wrangler.toml
```

## 1. 后端部署（Cloudflare Worker）

```bash
cd cecp-intercom/worker
npm install          # 首次需要（安装 wrangler）
npx wrangler login   # 首次需要（浏览器授权）
npx wrangler deploy
```

部署后得到地址（当前线上为）：

```text
https://cecp-ws.cecp.workers.dev
```

前端要写成 WebSocket 形式：`wss://cecp-ws.cecp.workers.dev`。
打开 https 地址可看到健康检查页；`/health` 返回 JSON。

> v2 的 worker 对 v1 前端完全向后兼容，可先于前端上线。

**设置音控密码（合体入口的音控组用）**：密码只存在服务器，不进代码仓库、不进网页源码。

```bash
cd cecp-intercom/worker
npx wrangler secret put OP_PIN   # 按提示输入密码，例如 3234
```

设完就立即生效（不必重新 deploy）。不设的话音控组入口不设防。以后改密码重跑这条命令即可。

## 2. 前端地址（GitHub Pages）

```text
https://cye04.github.io/Cecp/cecp-intercom/cecp.js
```

改完代码 `git push` 即发布，无需构建。**只需引入这一个 JS 文件，不需要再引 cecp.css。**

## 3. 三端嵌入

### 3.0 合体入口（推荐对外只公开这一个链接）

一个链接，进去先选「敬拜团 / 音控组」。敬拜团直接进；音控组要输密码（防止随便谁点进音控台踢人/发广播）。做成一个单独页面即可（自动全屏 + 内部滚动 + 跟随系统深浅色）：

```html
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>
<body>
<cecp-intercom
  data-ws-url="wss://cecp-ws.cecp.workers.dev"
  data-mode="menu"></cecp-intercom>
<script src="https://cye04.github.io/Cecp/cecp-intercom/cecp.js"></script>
</body></html>
```

- `data-mode="menu"` 默认全屏铺满页面、内容超高可内部滚动。
- 音控密码**存在服务器上**（`OP_PIN`，见 §1），网页源码里翻不到——见下方部署步骤。**没设 `OP_PIN` 时音控组入口不设防**（向后兼容）。
- 下面 3.1 / 3.2 的单独 `client` / `operator` 链接仍然可用，作为备用，不公开即可。

### 3.1 敬拜端（成员，手机）

```html
<cecp-intercom
  data-ws-url="wss://cecp-ws.cecp.workers.dev"
  data-mode="client"></cecp-intercom>
<script src="https://cye04.github.io/Cecp/cecp-intercom/cecp.js"></script>
```

进入后选设备 + 填名字；快捷信息按「我的耳返 / 耳返里的声部 / 话筒设备 / 流程求助」四组展示，点一下即发；「聊天」Tab 是成员群聊。发出的请求会实时回填音控标记的状态（待处理/处理中/已解决）。

### 3.2 音控端（调音台，桌面）

```html
<cecp-intercom
  data-ws-url="wss://cecp-ws.cecp.workers.dev"
  data-mode="operator"></cecp-intercom>
<script src="https://cye04.github.io/Cecp/cecp-intercom/cecp.js"></script>
```

音控台功能：

- **请求看板**：按声部分组（话筒/人声、键盘、吉他、贝斯、鼓、其它/流程），组头带未处理角标；每条请求可一键标记 待处理/处理中/已解决（同步到成员端和其它音控端）；已解决默认收起。
- **高优先级警报**：啸叫/爆音/话筒没声/故障类请求全局置顶红框，到达时响声+震动，面板边框持续闪烁直到标记已解决；🔔 按钮一键静音（只关声震，不关视觉）。
- **定向回复**：点请求上的「回复」，预设短语或手输，只发给该成员。
- **广播**：预设词 + 手输；顶部成员 chips 可勾选定向（默认「全体（含 youth）」）。
- 在线设备列表（踢单个/全员）、统计卡、每日午夜（罗马时区）自动清场。

### 3.3 youth 页面（青年聚会，被动接收 + 可升级）

在 youth 帖子/页面里追加：

```html
<cecp-intercom
  data-ws-url="wss://cecp-ws.cecp.workers.dev"
  data-mode="auto"></cecp-intercom>
<script src="https://cye04.github.io/Cecp/cecp-intercom/cecp.js"></script>
```

- 页面加载即以 **listener** 身份静默连接：不弹窗、不选身份，音控广播到达时悬浮球所在角弹 toast。
- **四角停靠 + 自动避让**：悬浮球可停四个角，初始化时自动避开「工具导游」（`rt5` 系触发器，硬规则永不同角）和回到顶部按钮、footer FAB 等固定元素（软避让，纵向让位）；面板标题栏的方格按钮可手动换角，选择会记住。显式钉死用 `data-corner="bottom-right"` 等。
- 用户点开悬浮球 → 选设备身份 → 原地升级为正式成员，之后能完整收发。
- 青年聚会想用独立房间（不和主日混）就加 `data-room="youth"`，音控端也开同样的 room 即可。
- 样式在 Shadow DOM 内，与 youth-engine 的全局样式互不影响；可与其共存于同一页面。

### 3.4 旧写法（v1 兼容，仍可用）

```html
<div id="cecp-root" data-ws-url="wss://…" data-mode="client"></div>
<script src="https://cye04.github.io/Cecp/cecp-intercom/cecp.js"></script>
```

## 4. 全部属性

| 属性 | 默认 | 说明 |
|---|---|---|
| `data-ws-url` | （必填） | Worker 的 wss 地址 |
| `data-mode` | `client` | `menu`（合体入口，选角色）/ `operator` / `client` / `listener` / `auto`（auto=先被动收听，点开再升级） |
| `data-fullscreen` | menu 默认开 | `1` 铺满整个视口 + 内部滚动（单独页面用）；`0` 关闭。其它模式默认关 |
| `data-room` | `cecp-main` | 房间名（字母/数字/`_`/`-`，≤64）；不同房间完全隔离 |
| `data-layout` | 视 mode | `page`（填满容器）/ `floating`（悬浮球）；listener/auto 默认 floating |
| `data-presets` | 内置 15 个 | JSON 数组，覆写设备身份列表 |
| `data-cues` | 内置 4 组 | JSON。扁平 `[{kind,icon,label,desc,priority}]` 或分组 `[{label,cues:[…]}]`；`priority:"high"` 触发音控警报 |
| `data-broadcast-presets` | 内置 5 个 | JSON 数组，音控广播快捷词 |
| `data-widget-title` | CECP 敬拜团内通 | 悬浮面板标题 |
| `data-corner` | 自动避让 | 四角停靠：`top-left` / `top-right` / `bottom-left` / `bottom-right`；不指定则「上次选择 → 自动挑空角」。旧 `data-float-side` 仍兼容（映射到底部两角） |
| `data-float-right` / `-bottom` | 20px / 自动 | 离停靠角的偏移；`-bottom` 不指定时自动按角落固定元素高度让位 |
| `data-launcher-icon` / `-label` | 内置声波耳机 SVG / 调音助手 | 给 emoji 则替换内置图标（内置 SVG 才有呼吸动效）；`-label` 是无障碍标签 |
| `data-default-preset` | — | 自动选中的设备名 |
| `data-page-key` | 页面路径 | localStorage 隔离键（同页多实例时必须各不相同） |
| `data-member-chat` | 开 | `"0"` 关闭成员群聊 |
| `data-theme` | 自动探测 | `light` / `dark` 强制主题 |

JS API：`window.CECPIntercom.mount(elOrSelector)` → `{ open, close, destroy }`。

## 5. 验证方法

1. 打开音控端 + 成员端各一个页面。
2. 成员发「有啸叫回授」→ 音控看板置顶红框 + 响声震动 + 边框闪烁。
3. 音控标「处理中」→ 成员端该条变蓝；标「已解决」→ 变绿淡化、警报停止。
4. 音控点「回复」发「好了」→ 只有该成员弹横幅。
5. 音控勾选某成员再广播 → 只有他收到；不勾 → 全体（含 youth 页 toast）。
6. 断网再恢复 → 顶部红条「正在自动重连」自动消失并提示「已重新连接 ✓」。

## 6. 已知兼容性

- 需要支持 Custom Elements + Shadow DOM 的浏览器（2020 年后的均可）。
- 音控台三栏在 iOS 16+/新浏览器按面板宽度自适应（容器查询）；更老的设备按视口宽度降级堆叠。
- iOS Safari：输入框已固定 16px 防聚焦放大；震动 API 不可用时静默跳过。
