/* ============================================================
   LAMEZIA 敬拜内通 v2 — 单文件零依赖 Web Component
   （fork 自 CECP 敬拜团内通；window.CECPIntercom / cecp-intercom 等标识符保留不改名）
   ------------------------------------------------------------
   嵌入方式（新）：
     <cecp-intercom
        data-ws-url="wss://cecp-ws.xxx.workers.dev"
        data-mode="client"></cecp-intercom>
     <script src="cecp.js"></script>

   嵌入方式（旧，向后兼容）：
     <div id="cecp-root" data-ws-url="…" data-mode="client"></div>
     <script src="cecp.js"></script>

   属性：
     data-ws-url            必填，Worker 的 wss 地址
     data-mode              operator | client | listener | auto（默认 client）
                            auto = 先以 listener 被动收广播，用户点开后选身份升级成 client
     data-room              房间名（字母/数字/_-，默认 cecp-main）
     data-layout            page | floating（listener/auto 默认 floating，其余默认 page）
     data-presets           JSON 数组，覆写设备身份列表
     data-cues              JSON，覆写快捷信息。支持两种格式：
                              扁平：[{kind,icon,label,desc,priority}]
                              分组：[{label:"组名",cues:[{…}]}]
     data-broadcast-presets JSON 数组，覆写音控广播快捷词
     data-launcher-icon / data-launcher-label / data-widget-title
     data-float-right / data-float-bottom   悬浮按钮偏移（如 "24px"）
     data-default-preset    自动选中的设备名
     data-page-key          localStorage 隔离键（默认 location.pathname）
     data-app-name          教会 / 应用名，显示在各界面标题（默认 LAMEZIA 敬拜内通）
     data-member-chat="0"   关闭成员群聊
     样式全部在 Shadow DOM 内，与宿主页面 CSS 完全隔离；同页可多实例。

   JS API：
     window.CECPIntercom.mount(elOrSelector) → { open, close, destroy }
   ============================================================ */

(function () {
  'use strict';

  if (window.__CECP_INTERCOM_V2__) return;
  window.__CECP_INTERCOM_V2__ = true;

  /* ────────────────────────────────────────────
     工具函数
  ──────────────────────────────────────────── */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nowId(prefix) {
    return (prefix || 'msg') + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) {
    return String(Math.max(0, n || 0)).padStart(2, '0');
  }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtClock() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtDayStamp(d) {
    var date = d || new Date();
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function parseJsonMaybe(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) {
      console.warn('[cecp-intercom] JSON 解析失败:', err);
      return null;
    }
  }

  function lsGet(key) {
    try { return localStorage.getItem(key) || ''; } catch (err) { return ''; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (err) {}
  }

  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (err) {}
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 15);
    } catch (err) {}
  }

  /* ────────────────────────────────────────────
     设备身份元数据（沿用 v1 已验证的识别规则）
  ──────────────────────────────────────────── */

  function stripIdentityPrefix(value) {
    return String(value || '').replace(/^[🎤🎹🎸🥁🎛️🎙️📢⚡🎧]\s*/u, '').trim();
  }

  function getDeviceFromDisplayName(value) {
    return String(value || '').trim().split(/[｜|]/)[0].trim();
  }

  function getPersonFromDisplayName(value) {
    var parts = String(value || '').trim().split(/[｜|]/);
    return parts.length > 1 ? parts.slice(1).join('｜').trim() : '';
  }

  function buildDisplayName(deviceName, personName) {
    var device = String(deviceName || '').trim();
    var person = String(personName || '').trim();
    if (!device || !person) return device;
    return device + '｜' + person;
  }

  function detectIdentityType(name) {
    var text = stripIdentityPrefix(name);
    if (/音控/.test(text)) return 'operator';
    if (/话筒/.test(text)) return 'mic';
    if (/钢琴|键盘|吉他|电吉他|贝斯|鼓/.test(text)) return 'instrument';
    return 'other';
  }

  function detectIdentityTone(name) {
    var text = stripIdentityPrefix(name);
    if (/音控/.test(text)) return 'gold';
    var micNum = text.match(/话筒\s*([1-8])/);
    if (micNum) return MIC_TONES[Number(micNum[1]) - 1];
    if (/橘|橙/.test(text)) return 'orange';
    if (/绿/.test(text)) return 'green';
    if (/紫/.test(text)) return 'purple';
    if (/黄/.test(text)) return 'yellow';
    if (/红/.test(text)) return 'red';
    if (/蓝/.test(text)) return 'blue';
    if (/白/.test(text)) return 'white';
    if (/黑/.test(text)) return 'black';
    if (/棕|褐|咖/.test(text)) return 'brown';
    if (/钢琴/.test(text)) return 'gold';
    if (/键盘/.test(text)) return 'blue';
    if (/电吉他/.test(text)) return 'purple';
    if (/吉他/.test(text)) return 'green';
    if (/贝斯/.test(text)) return 'brown';
    if (/鼓/.test(text)) return 'red';
    return 'default';
  }

  function detectIdentityIcon(name) {
    var text = stripIdentityPrefix(name);
    if (/音控/.test(text)) return '🎛️';
    if (/话筒/.test(text)) return '🎤';
    if (/钢琴|键盘/.test(text)) return '🎹';
    if (/吉他|电吉他|贝斯/.test(text)) return '🎸';
    if (/鼓/.test(text)) return '🥁';
    return '🎵';
  }

  /* 声部分组（Phase 3 音控看板用）：mic / keys / guitar / bass / drum / other */
  function detectSection(name) {
    var text = stripIdentityPrefix(name);
    if (/话筒|人声|主唱|和声/.test(text)) return 'mic';
    if (/钢琴|键盘/.test(text)) return 'keys';
    if (/贝斯/.test(text)) return 'bass';
    if (/吉他/.test(text)) return 'guitar';
    if (/鼓/.test(text)) return 'drum';
    return 'other';
  }

  function identityMeta(name) {
    var displayName = String(name || '').trim();
    var baseName = getDeviceFromDisplayName(displayName);
    var personName = getPersonFromDisplayName(displayName);
    var title = stripIdentityPrefix(baseName) || baseName || displayName;
    if (personName) title += ' · ' + personName;
    return {
      displayName: displayName,
      title: title,
      tone: detectIdentityTone(displayName),
      type: detectIdentityType(displayName),
      icon: detectIdentityIcon(displayName),
      section: detectSection(displayName)
    };
  }

  function identityPill(name, extraClass) {
    var meta = identityMeta(name);
    return '<span class="cf-pill tone-' + meta.tone + (extraClass ? ' ' + extraClass : '') + '">'
      + '<span class="cf-pill-icon">' + esc(meta.icon) + '</span>'
      + '<span class="cf-pill-swatch"></span>'
      + '<span class="cf-pill-text">' + esc(meta.title) + '</span>'
      + '</span>';
  }

  /* ────────────────────────────────────────────
     默认配置
  ──────────────────────────────────────────── */

  var DEFAULT_PRESETS = [
    '🎤 话筒1', '🎤 话筒2', '🎤 话筒3', '🎤 话筒4',
    '🎤 话筒5', '🎤 话筒6', '🎤 话筒7', '🎤 话筒8',
    '🎹 钢琴', '🎹 键盘', '🎸 吉他', '🎸 电吉他', '🎸 贝斯', '🥁 鼓'
  ];

  /* 编号话筒各配一个色，卡片仍能一眼区分（原来靠「橘色/绿色…」的颜色词区分） */
  var MIC_TONES = ['orange', 'blue', 'green', 'purple', 'red', 'yellow', 'brown', 'black'];

  var DEFAULT_CUE_GROUPS = [
    {
      label: '我的耳返',
      cues: [
        { kind: 'more_monitor', icon: '🎧', label: '耳返多点', desc: '耳返整体太小' },
        { kind: 'less_monitor', icon: '🎧', label: '耳返少点', desc: '耳返整体太大' },
        { kind: 'self_up', icon: '🔊', label: '多点我自己', desc: '听不到自己' },
        { kind: 'self_down', icon: '🔉', label: '少点我自己', desc: '自己太大' }
      ]
    },
    {
      label: '耳返里的声部',
      cues: [
        { kind: 'voice_up', icon: '🎤', label: '人声多点', desc: '主唱/和声再清楚些' },
        { kind: 'piano_up', icon: '🎹', label: '琴多点', desc: '琴声听不清' },
        { kind: 'drum_up', icon: '🥁', label: '鼓多点', desc: '节奏听不清' },
        { kind: 'bass_up', icon: '🎸', label: '贝斯多点', desc: '低频不够稳' },
        { kind: 'click_toggle', icon: '⏱️', label: '节拍器开/关', desc: '请切换节拍器' }
      ]
    },
    {
      label: '话筒 / 设备',
      cues: [
        { kind: 'mic_dead', icon: '🎙️', label: '话筒没声', desc: '完全出不了声', priority: 'high' },
        { kind: 'mic_low', icon: '🎙️', label: '话筒太小', desc: '外场听不到我' },
        { kind: 'mic_noise', icon: '⚡', label: '有杂音/爆音', desc: '通道有异常声音', priority: 'high' },
        { kind: 'feedback', icon: '📢', label: '有啸叫回授', desc: '刺耳的啸叫声', priority: 'high' }
      ]
    },
    {
      label: '流程 / 求助',
      cues: [
        { kind: 'ready', icon: '✅', label: '准备好了', desc: '可以开始' },
        { kind: 'wait', icon: '✋', label: '稍等一下', desc: '先暂停处理一下' },
        { kind: 'restart', icon: '🔁', label: '重来一次', desc: '这段再来一遍' },
        { kind: 'issue', icon: '⚠️', label: '需要帮忙', desc: '设备/其它故障', priority: 'high' }
      ]
    }
  ];

  var DEFAULT_BCAST_PRESETS = ['可以开始了', '下一首', '重来', '稍等一下', '准备结束'];

  var STATUS_LABEL = { pending: '待处理', doing: '处理中', done: '已解决' };
  var SECTION_LABEL = { mic: '话筒 / 人声', keys: '键盘', guitar: '吉他', bass: '贝斯', drum: '鼓', other: '其它 / 流程' };

  function normalizeCue(item) {
    if (!item || typeof item !== 'object') return null;
    var kind = String(item.kind || '').trim();
    var label = String(item.label || '').trim();
    if (!kind || !label) return null;
    return {
      kind: kind,
      icon: String(item.icon || '💬'),
      label: label,
      desc: String(item.desc || ''),
      priority: item.priority === 'high' ? 'high' : 'normal'
    };
  }

  function readCueGroups(raw) {
    var parsed = parseJsonMaybe(raw);
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_CUE_GROUPS;

    /* 分组格式：[{label, cues:[…]}] */
    if (parsed[0] && Array.isArray(parsed[0].cues)) {
      var groups = parsed.map(function (g) {
        if (!g || typeof g !== 'object') return null;
        var cues = (Array.isArray(g.cues) ? g.cues : []).map(normalizeCue).filter(Boolean);
        if (!cues.length) return null;
        return { label: String(g.label || '快捷信息'), cues: cues };
      }).filter(Boolean);
      return groups.length ? groups : DEFAULT_CUE_GROUPS;
    }

    /* 扁平格式：[{kind,icon,label,desc}] → 单组 */
    var flat = parsed.map(normalizeCue).filter(Boolean);
    return flat.length ? [{ label: '快捷信息', cues: flat }] : DEFAULT_CUE_GROUPS;
  }

  function readPresetList(raw, fallback) {
    var parsed = parseJsonMaybe(raw);
    if (!Array.isArray(parsed)) return fallback.slice();
    var list = parsed.map(function (item) {
      return String(item == null ? '' : item).trim();
    }).filter(Boolean);
    return list.length ? list : fallback.slice();
  }

  /* ────────────────────────────────────────────
     Shadow DOM 样式（暖米色 + 金 + 绿 教会基调）
  ──────────────────────────────────────────── */

  var CSS = [
    ':host{display:block}',
    /* [hidden] 必须压过各角标类里的 display:flex（否则角标会显示 0） */
    '[hidden]{display:none!important}',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    'button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    'input,textarea{font:inherit;color:inherit}',
    'ul,ol{list-style:none}',
    '.cf button:focus-visible,.cf input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}',

    /* ── 主题变量（Apple 风：中性色 + 单一强调蓝）── */
    '.cf{',
    '  --acc:#0071e3;--acc-soft:rgba(0,113,227,.09);',
    '  --green:#34c759;--green-soft:rgba(52,199,89,.12);',
    '  --red:#ff3b30;--red-soft:rgba(255,59,48,.1);',
    '  --orange:#ff9500;--orange-soft:rgba(255,149,0,.12);',
    '  --blue:var(--acc);--blue-soft:var(--acc-soft);',
    '  --bg:#f5f5f7;--card:#ffffff;--card2:#f5f5f7;--card3:#e8e8ed;',
    '  --text:#1d1d1f;--muted:#86868b;--border:rgba(0,0,0,.08);--border-strong:rgba(0,0,0,.16);',
    '  --glass:rgba(255,255,255,.86);',
    '  --shadow:0 22px 64px rgba(0,0,0,.13),0 2px 10px rgba(0,0,0,.05);--shadow-soft:0 2px 12px rgba(0,0,0,.06);',
    '  --r-lg:22px;--r-md:13px;--r-sm:10px;',
    '  --r-in:26px;--r-out:9px;',
    '  --t-orange:#ff9500;--t-green:#34c759;--t-purple:#bf5af2;--t-yellow:#ffcc00;--t-red:#ff3b30;',
    '  --t-blue:#007aff;--t-white:#d1d1d6;--t-black:#48484a;--t-brown:#a2845e;--t-gold:#d4a017;--t-default:#8e8e93;',
    '  color:var(--text);',
    '  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",system-ui,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;',
    '  font-size:15px;line-height:1.5;font-weight:400;letter-spacing:0;',
    '  text-align:left;-webkit-font-smoothing:antialiased;',
    '}',
    '.cf.is-dark{',
    '  --acc:#2997ff;--acc-soft:rgba(41,151,255,.14);',
    '  --green:#30d158;--green-soft:rgba(48,209,88,.16);',
    '  --red:#ff453a;--red-soft:rgba(255,69,58,.16);',
    '  --orange:#ff9f0a;--orange-soft:rgba(255,159,10,.16);',
    '  --bg:#161617;--card:#1d1d1f;--card2:#28282a;--card3:#333336;',
    '  --text:#f5f5f7;--muted:#a1a1a6;--border:rgba(255,255,255,.1);--border-strong:rgba(255,255,255,.22);',
    '  --glass:rgba(29,29,31,.88);',
    '  --shadow:0 24px 70px rgba(0,0,0,.55),0 2px 12px rgba(0,0,0,.35);--shadow-soft:0 2px 12px rgba(0,0,0,.3);',
    '  --t-white:#aeaeb2;--t-black:#636366;',
    '}',

    /* ── 面板骨架 ── */
    '.cf-panel{display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);overflow:hidden;container-type:inline-size;overscroll-behavior:contain}',
    '.cf.is-page .cf-panel{position:relative;width:100%;height:100%;min-height:520px;border-radius:var(--r-lg)}',
    '.cf.is-page{height:100%}',
    /* 单独页面全屏：铺满视口，内部自己滚 */
    '.cf.is-page.is-fullscreen{position:fixed;inset:0;height:100vh;height:100dvh;z-index:2147483000}',
    '.cf.is-page.is-fullscreen .cf-panel{width:100%;height:100%;min-height:0;border-radius:0;border:none}',
    '.cf-stage{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}',

    /* 悬浮根不拦任何触摸；可交互的只有球、面板、toast 本身 */
    '.cf.is-floating{pointer-events:none}',
    '.cf.is-floating .cf-launcher,.cf.is-floating .cf-dock-pop{pointer-events:auto}',
    /* ── 悬浮球（贴角圆角语言 + 玻璃材质；不支持 backdrop-filter 时退回实色）── */
    '.cf.is-floating .cf-launcher{position:fixed;z-index:2147483644;width:58px;height:58px;opacity:.5;',
    '  background:var(--card);',
    '  border:1px solid var(--border);box-shadow:var(--shadow-soft),0 6px 18px rgba(0,0,0,.07);color:var(--text);',
    '  display:flex;align-items:center;justify-content:center;',
    '  transition:transform .45s cubic-bezier(.34,1.56,.64,1),color .2s ease,border-radius .3s ease,opacity .25s ease}',
    '.cf.is-floating .cf-launcher:active{transform:scale(.88);opacity:1}',
    '.cf.is-floating .cf-launcher.has-unread,.cf.is-floating .cf-launcher.is-alert,.cf.is-floating .cf-launcher:focus-visible{opacity:1}',
    '@media (hover:hover){.cf.is-floating .cf-launcher:hover{transform:scale(1.06);color:var(--acc);opacity:1}}',
    '.cf-ic{width:27px;height:27px;display:block}',
    /* 声波条静止（去掉常驻呼吸，避免抢眼） */
    '.cf-ic-bars{transform-box:fill-box;transform-origin:center}',
    '@keyframes cf-eq{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.8)}}',
    /* 未读：声波扩散 ripple（强调蓝） */
    '.cf-launcher::before,.cf-launcher::after{content:"";position:absolute;inset:-1px;border-radius:inherit;',
    '  border:2px solid var(--acc);opacity:0;pointer-events:none}',
    '.cf-launcher.has-unread::before{animation:cf-ripple 2.4s ease-out infinite}',
    '.cf-launcher.has-unread::after{animation:cf-ripple 2.4s ease-out 1.2s infinite}',
    '@keyframes cf-ripple{0%{transform:scale(1);opacity:.55}70%{transform:scale(1.55);opacity:0}100%{transform:scale(1.55);opacity:0}}',
    /* 高优先级：红色、更急促 */
    '.cf-launcher.is-alert{color:var(--red)}',
    '.cf-launcher.is-alert::before,.cf-launcher.is-alert::after{border-color:var(--red)}',
    '.cf-launcher.is-alert::before{animation:cf-ripple 1.1s ease-out infinite}',
    '.cf-launcher.is-alert::after{animation:cf-ripple 1.1s ease-out .55s infinite}',
    '.cf-launcher-badge{position:absolute;top:-5px;right:-5px;min-width:20px;height:20px;padding:0 6px;border-radius:999px;',
    '  background:var(--red);color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 1px 4px rgba(0,0,0,.25)}',

    /* ── 悬浮面板：贴角小弹窗，高度「刚好包住内容」，封顶不超视口（本体永远实色不透底）── */
    '.cf.is-floating .cf-panel{position:fixed;z-index:2147483646;box-shadow:var(--shadow);border:1px solid var(--border);',
    '  height:auto;min-height:160px;',
    '  max-height:calc(100vh - var(--dy,20px) - var(--sat) - var(--sab) - 88px);max-height:calc(100dvh - var(--dy,20px) - var(--sat) - var(--sab) - 88px);',
    '  opacity:0;transform:scale(.92);pointer-events:none;',
    '  transition:opacity .26s cubic-bezier(.32,.72,0,1),transform .32s cubic-bezier(.32,.72,0,1),border-radius .3s ease}',
    '.cf.is-floating.is-open .cf-panel{opacity:1;transform:none;pointer-events:auto}',
    /* 宽度随视口方向：纵向窄弹窗、横向宽弹窗（内容多列）；高度都由内容决定 */
    '.cf.orient-p.is-floating .cf-panel{width:min(380px,calc(100vw - 24px - var(--sal) - var(--sar)))}',
    '.cf.orient-l.is-floating .cf-panel{width:clamp(400px,62vw,880px);max-width:calc(100vw - 40px)}',
    /* 四角锚定：--dx / --dy 由 JS 写入（含避让偏移）；叠加刘海/手势条安全区 */
    '.cf{--sal:env(safe-area-inset-left,0px);--sar:env(safe-area-inset-right,0px);--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px)}',
    '.cf.dock-br .cf-launcher{right:calc(var(--dx,20px) + var(--sar));bottom:calc(var(--dy,20px) + var(--sab))}',
    '.cf.dock-bl .cf-launcher{left:calc(var(--dx,20px) + var(--sal));bottom:calc(var(--dy,20px) + var(--sab))}',
    '.cf.dock-tr .cf-launcher{right:calc(var(--dx,20px) + var(--sar));top:calc(var(--dy,20px) + var(--sat))}',
    '.cf.dock-tl .cf-launcher{left:calc(var(--dx,20px) + var(--sal));top:calc(var(--dy,20px) + var(--sat))}',
    '.cf.dock-br .cf-panel{right:calc(var(--dx,20px) + var(--sar));bottom:calc(var(--dy,20px) + var(--sab) + 70px);transform-origin:100% 100%}',
    '.cf.dock-bl .cf-panel{left:calc(var(--dx,20px) + var(--sal));bottom:calc(var(--dy,20px) + var(--sab) + 70px);transform-origin:0 100%}',
    '.cf.dock-tr .cf-panel{right:calc(var(--dx,20px) + var(--sar));top:calc(var(--dy,20px) + var(--sat) + 70px);transform-origin:100% 0}',
    '.cf.dock-tl .cf-panel{left:calc(var(--dx,20px) + var(--sal));top:calc(var(--dy,20px) + var(--sat) + 70px);transform-origin:0 0}',
    /* 贴角形状：靠屏幕角一侧圆角小、朝内三角圆角大；球与面板同语言 */
    '.cf.dock-br.is-floating .cf-panel{border-radius:var(--r-in) var(--r-in) var(--r-out) var(--r-in)}',
    '.cf.dock-bl.is-floating .cf-panel{border-radius:var(--r-in) var(--r-in) var(--r-in) var(--r-out)}',
    '.cf.dock-tr.is-floating .cf-panel{border-radius:var(--r-in) var(--r-out) var(--r-in) var(--r-in)}',
    '.cf.dock-tl.is-floating .cf-panel{border-radius:var(--r-out) var(--r-in) var(--r-in) var(--r-in)}',
    '.cf.dock-br .cf-launcher{border-radius:19px 19px 8px 19px}',
    '.cf.dock-bl .cf-launcher{border-radius:19px 19px 19px 8px}',
    '.cf.dock-tr .cf-launcher{border-radius:19px 8px 19px 19px}',
    '.cf.dock-tl .cf-launcher{border-radius:8px 19px 19px 19px}',
    /* 弹窗外不加遮罩：面板外的页面随便滑（触摸隔离只管面板内部） */
    '.cf-mask{display:none}',

    /* ── 标题栏（实色打底；支持毛玻璃的环境才启用半透明+blur，页面内容绝不透出）── */
    '.cf-bar{display:none;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;',
    '  background:var(--card);border-bottom:1px solid var(--border)}',
    '@supports ((backdrop-filter:blur(4px)) or (-webkit-backdrop-filter:blur(4px))){',
    '  .cf-bar{background:var(--glass);-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8)}',
    '  .cf.is-floating .cf-launcher{background:var(--glass);-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8)}',
    '}',
    '.cf.is-floating .cf-bar{display:flex}',
    '.cf-bar-title{font-weight:600;font-size:14px;letter-spacing:-.01em}',
    '.cf-bar-kicker{display:block;font-size:11px;color:var(--muted);letter-spacing:.02em}',
    '.cf-bar-tools{display:flex;align-items:center;gap:8px;position:relative}',
    '.cf-bar-close{width:28px;height:28px;border-radius:50%;background:var(--card3);color:var(--muted);font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .15s}',
    '.cf-bar-close:hover{background:var(--border-strong)}',
    /* 停靠角切换 */
    '.cf-dock-btn{width:28px;height:28px;border-radius:50%;background:var(--card3);display:flex;align-items:center;justify-content:center}',
    '.cf-dock-glyph{width:12px;height:12px;border:1.5px solid var(--muted);border-radius:3px;position:relative}',
    '.cf-dock-glyph::after{content:"";position:absolute;width:4px;height:4px;border-radius:1px;background:var(--muted);left:1px;bottom:1px}',
    '.cf-dock-pop{position:absolute;top:34px;right:0;z-index:60;display:none;grid-template-columns:1fr 1fr;gap:4px;padding:6px;',
    '  background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}',
    '.cf-dock-pop.show{display:grid}',
    '.cf-dock-pop button{width:40px;height:34px;border-radius:8px;font-size:14px;color:var(--muted);background:var(--card2)}',
    '.cf-dock-pop button.on{background:var(--acc);color:#fff}',
    /* 悬浮模式：标题栏已有标题+状态点，屏内不再重复 */
    '.cf.is-floating .is-setup .cf-head{display:none}',
    '.cf.is-floating .cf-app .cf-status{display:none}',
    '.cf.is-floating .cf-client-head{padding:9px 14px}',
    /* 断线提示条 */
    '.cf-offline{display:flex;align-items:center;gap:7px;padding:8px 14px;background:var(--red-soft);color:var(--red);font-size:12.5px;font-weight:600;border-bottom:1px solid var(--border)}',
    '.cf-offline[hidden]{display:none}',

    /* ── 通用头部 ── */
    '.cf-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:14px 18px;background:var(--card);border-bottom:1px solid var(--border)}',
    '.cf-head-copy{display:flex;flex-direction:column;min-width:0}',
    '.cf-head-title{font-size:17px;font-weight:600;letter-spacing:-.015em}',
    '.cf-head-sub{font-size:12px;color:var(--muted)}',
    '.cf-head-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.cf-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);padding:5px 10px;border-radius:999px;background:var(--card3)}',
    '.cf-dot{width:8px;height:8px;border-radius:50%;background:var(--red);transition:background .2s}',
    '.cf-dot.online{background:var(--green)}',
    '.cf-clock{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);padding:5px 10px;border-radius:999px;background:var(--card3);font-variant-numeric:tabular-nums}',
    '.cf-ghost-btn{padding:6px 12px;border-radius:999px;background:var(--card3);font-size:12px;font-weight:500;color:var(--text);transition:background .15s}',
    '.cf-ghost-btn:hover{background:var(--border-strong)}',

    /* ── 身份 pill ── */
    '.cf-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px 4px 7px;border-radius:999px;',
    '  background:var(--card2);border:1px solid var(--border);font-size:12.5px;font-weight:500;--tone:var(--t-default)}',
    '.cf-pill-icon{font-size:13px}',
    '.cf-pill-swatch{width:8px;height:8px;border-radius:50%;background:var(--tone);flex:none}',
    '.cf-pill-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.tone-orange{--tone:var(--t-orange)}.tone-green{--tone:var(--t-green)}.tone-purple{--tone:var(--t-purple)}',
    '.tone-yellow{--tone:var(--t-yellow)}.tone-red{--tone:var(--t-red)}.tone-blue{--tone:var(--t-blue)}',
    '.tone-white{--tone:var(--t-white)}.tone-black{--tone:var(--t-black)}.tone-brown{--tone:var(--t-brown)}',
    '.tone-gold{--tone:var(--t-gold)}.tone-default{--tone:var(--t-default)}',

    /* ── 选设备（setup）：颜色是主体的紧凑网格；尺寸随组件自身宽度（cqi）缩放 ── */
    '.cf-setup{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:clamp(14px,4cqi,24px) clamp(12px,4cqi,24px) clamp(16px,4cqi,26px);-webkit-overflow-scrolling:touch}',
    '.cf-setup-kicker{display:inline-block;font-size:clamp(10.5px,2.6cqi,12px);font-weight:600;color:var(--acc);letter-spacing:.02em}',
    '.cf-setup h2{margin:4px 0 2px;font-size:clamp(17px,5cqi,23px);font-weight:700;letter-spacing:-.02em}',
    '.cf-setup-sub{color:var(--muted);font-size:clamp(11.5px,3cqi,13.5px);margin-bottom:clamp(10px,3cqi,18px)}',
    '.cf-preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(88px,26cqi,116px),1fr));gap:clamp(6px,1.6cqi,9px)}',
    '.cf-preset{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;',
    '  padding:clamp(8px,2.4cqi,13px) 4px clamp(7px,2cqi,11px);border-radius:var(--r-md);',
    '  border:1px solid transparent;background:var(--card);box-shadow:var(--shadow-soft);text-align:center;',
    '  transition:box-shadow .15s,transform .15s cubic-bezier(.32,.72,0,1)}',
    '.cf-preset:active{transform:scale(.95)}',
    /* 色环 + 着色图形：颜色一眼可辨 */
    '.cf-preset-swatch{width:clamp(34px,10cqi,44px);height:clamp(34px,10cqi,44px);border-radius:50%;flex:none;',
    '  display:flex;align-items:center;justify-content:center;color:var(--tone);',
    '  background:color-mix(in srgb,var(--tone) 14%,var(--card));',
    '  box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--tone) 55%,transparent)}',
    '.cf-preset-swatch .cf-mic{width:58%;height:58%}',
    '.cf-preset-swatch .cf-preset-emoji{font-size:clamp(17px,5cqi,21px);line-height:1}',
    /* 白色/黄色话筒在浅色底上的可辨性特例 */
    '.tone-white .cf-preset-swatch{background:#55555a;color:#fff;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)}',
    '.cf:not(.is-dark) .tone-yellow .cf-preset-swatch{color:#a8850a}',
    '.cf-preset-name{max-width:100%;font-size:clamp(11.5px,3cqi,13px);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cf-preset-sub{font-size:clamp(9.5px,2.4cqi,10.5px);color:var(--muted)}',
    /* 选中：强调环 + 右上角对勾 */
    '.cf-preset.sel{border-color:var(--acc);box-shadow:0 0 0 2.5px var(--acc-soft),var(--shadow-soft)}',
    '.cf-preset-check{position:absolute;top:5px;right:5px;width:17px;height:17px;border-radius:50%;',
    '  background:var(--acc);color:#fff;font-size:10.5px;font-weight:700;display:none;align-items:center;justify-content:center}',
    '.cf-preset.sel .cf-preset-check{display:flex}',
    /* 占用：整卡淡出置灰 + 「使用中」 */
    '.cf-preset.taken{cursor:not-allowed;box-shadow:none;background:var(--card2)}',
    '.cf-preset.taken .cf-preset-swatch{filter:grayscale(.85);opacity:.45}',
    '.cf-preset.taken .cf-preset-name{color:var(--muted)}',
    '.cf-preset.taken .cf-preset-sub{color:var(--red)}',
    '.cf-preset-taken-badge{display:none}',
    '.cf-name-panel{display:none;margin-top:16px;padding:14px;border-radius:var(--r-md);background:var(--card);box-shadow:var(--shadow-soft)}',
    '.cf-name-panel.show{display:block}',
    '.cf-name-label{display:block;font-size:12.5px;font-weight:600;margin-bottom:8px}',
    '.cf-name-row{display:flex;align-items:center;gap:8px}',
    '.cf-name-device{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:8px 10px;border-radius:var(--r-sm);background:var(--card3);font-size:12.5px;font-weight:500}',
    /* 输入框固定 16px：小于 16px 时 iOS Safari 聚焦会强制放大页面 */
    '.cf-name-input{flex:1;min-width:0;padding:10px 12px;border-radius:var(--r-sm);border:1px solid var(--border-strong);background:var(--card);outline:none;font-size:16px;transition:border-color .15s,box-shadow .15s}',
    '.cf-name-input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}',
    '.cf-name-hint{margin-top:8px;font-size:11.5px;color:var(--muted)}',
    '.cf-setup-error{display:none;margin-top:12px;padding:10px 12px;border-radius:var(--r-sm);background:var(--red-soft);color:var(--red);font-size:13px;font-weight:500}',
    '.cf-setup-error.show{display:block}',
    '.cf-btn-primary{display:block;width:100%;margin-top:16px;min-height:50px;padding:12px;border-radius:var(--r-md);',
    '  background:var(--acc);color:#fff;font-size:16px;font-weight:600;letter-spacing:-.01em;',
    '  transition:transform .15s cubic-bezier(.32,.72,0,1),opacity .15s,filter .15s}',
    '.cf-btn-primary:hover{filter:brightness(1.08)}',
    '.cf-btn-primary:active{transform:scale(.98)}',
    '.cf-btn-primary[disabled]{opacity:.4;cursor:default}',

    /* ── 角色选择（menu 模式：一个链接选音控 / 敬拜）── */
    /* 外层滚动 + margin:auto 居中：内容超高时可滚（纯 justify-center 会顶部截断） */
    '.cf-menu{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;-webkit-overflow-scrolling:touch}',
    '.cf-menu-inner{margin:auto;width:100%;text-align:center;padding:clamp(20px,5cqi,40px) clamp(16px,5cqi,40px)}',
    '.cf-menu-kicker{font-size:clamp(11px,2.8cqi,13px);font-weight:600;color:var(--acc);text-align:center}',
    '.cf-menu h2{font-size:clamp(20px,5.5cqi,28px);font-weight:700;letter-spacing:-.02em;text-align:center;margin:3px 0 4px}',
    '.cf-menu-sub{color:var(--muted);font-size:clamp(12px,3cqi,14px);text-align:center;margin-bottom:clamp(12px,3.5cqi,20px)}',
    '.cf-role-grid{display:grid;grid-template-columns:1fr;gap:12px;max-width:520px;width:100%;margin:0 auto}',
    '@container (min-width:520px){.cf-role-grid{grid-template-columns:1fr 1fr}}',
    '.cf-role{display:flex;flex-direction:column;align-items:center;gap:8px;padding:clamp(18px,5cqi,30px) 16px;border-radius:var(--r-lg);',
    '  border:1px solid var(--border);background:var(--card);box-shadow:var(--shadow-soft);text-align:center;',
    '  transition:transform .15s cubic-bezier(.32,.72,0,1),box-shadow .15s}',
    '.cf-role:hover{box-shadow:0 8px 28px rgba(0,0,0,.1)}',
    '.cf-role:active{transform:scale(.97)}',
    '.cf-role-icon{width:clamp(48px,14cqi,64px);height:clamp(48px,14cqi,64px);border-radius:50%;display:flex;align-items:center;justify-content:center;',
    '  font-size:clamp(24px,7cqi,32px);background:var(--acc-soft);color:var(--acc)}',
    '.cf-role.is-op .cf-role-icon{background:var(--orange-soft);color:var(--orange)}',
    '.cf-role-title{font-size:clamp(15px,4cqi,18px);font-weight:600}',
    '.cf-role-sub{font-size:clamp(11px,3cqi,12.5px);color:var(--muted)}',
    '.cf-role-lock{color:var(--orange);font-weight:600}',
    /* ── 音控密码 ── */
    '.cf-pin{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:clamp(20px,6cqi,40px);gap:14px;text-align:center}',
    '.cf-pin-icon{font-size:34px}',
    '.cf-pin h2{font-size:clamp(18px,5cqi,22px);font-weight:700}',
    '.cf-pin-sub{color:var(--muted);font-size:13px;max-width:300px}',
    '.cf-pin-input{width:min(240px,80%);text-align:center;letter-spacing:.4em;font-size:22px;font-weight:700;padding:12px;',
    '  border-radius:var(--r-md);border:1.5px solid var(--border-strong);background:var(--card);outline:none}',
    '.cf-pin-input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}',
    '.cf-pin-error{color:var(--red);font-size:13px;font-weight:600;min-height:18px}',
    '.cf-pin-actions{display:flex;gap:10px;width:min(300px,92%)}',
    '.cf-pin-actions .cf-btn-primary{margin-top:0;flex:1;width:auto}',
    '.cf-back-btn{flex:none;padding:12px 18px;border-radius:var(--r-md);background:var(--card3);font-size:15px;font-weight:600;color:var(--text)}',

    /* ── 敬拜端 ── */
    '.cf-client-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 16px;background:var(--card);border-bottom:1px solid var(--border)}',
    '.cf-banner{display:none;gap:10px;align-items:flex-start;margin:10px 14px 0;padding:12px 14px;border-radius:var(--r-md);',
    '  background:var(--card);box-shadow:0 8px 28px rgba(0,0,0,.1);border:1px solid var(--border);animation:cf-pop .3s cubic-bezier(.32,.72,0,1)}',
    '.cf-banner.show{display:flex}',
    '.cf-banner-icon{font-size:18px;flex:none}',
    '.cf-banner-body{flex:1;min-width:0}',
    '.cf-banner-head{font-size:11px;font-weight:600;color:var(--acc);letter-spacing:.02em}',
    '.cf-banner-text{font-size:14.5px;font-weight:500;word-break:break-word}',
    '.cf-banner-time{font-size:11px;color:var(--muted)}',
    '.cf-banner-read{flex:none;align-self:center;padding:7px 14px;border-radius:999px;background:var(--acc);color:#fff;font-size:12.5px;font-weight:600}',
    '@keyframes cf-pop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',

    /* Tab = Apple 分段控件 */
    '.cf-tabs{display:flex;gap:2px;margin:12px 14px 0;padding:3px;border-radius:11px;background:var(--card3)}',
    '.cf-tab{position:relative;flex:1;min-height:36px;border-radius:9px;font-size:13.5px;font-weight:500;color:var(--muted);transition:color .15s,background .15s,box-shadow .15s}',
    '.cf-tab.is-active{color:var(--text);background:var(--card);box-shadow:0 1px 4px rgba(0,0,0,.12);font-weight:600}',
    '.cf-tab-badge{position:absolute;top:4px;right:8px;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--red);color:#fff;font-size:10.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}',
    '.cf-pane{flex:1;display:none;flex-direction:column;min-height:0}',
    '.cf-pane.is-active{display:flex}',
    /* 宽容器（桌面/横屏）：敬拜端双栏——快捷信息 + 群聊并排，Tab 收起 */
    '@container (min-width:720px){',
    '  .cf-app.is-client{display:grid!important;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr)}',
    '  .cf-app.is-client .cf-client-head{grid-column:1/-1}',
    '  .cf-app.is-client .cf-banner{grid-column:1/-1}',
    '  .cf-app.is-client .cf-tabs{display:none}',
    '  .cf-app.is-client .cf-pane{display:flex;grid-row:3}',
    '  .cf-app.is-client .cf-pane-cues{grid-column:1}',
    '  .cf-app.is-client .cf-pane-chat{grid-column:2;border-left:1px solid var(--border)}',
    '  .cf-app.is-client .cf-pane-cues:last-child{grid-column:1/-1}',
    '}',

    '.cf-cues-scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 14px 6px;-webkit-overflow-scrolling:touch}',
    '.cf-cue-group{margin-bottom:18px}',
    '.cf-cue-group-label{font-size:clamp(11px,2.8cqi,12px);font-weight:600;color:var(--muted);letter-spacing:.02em;margin-bottom:8px}',
    /* 列数随组件宽度自适应（容器查询，不看视口） */
    '.cf-cue-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
    '@container (min-width:560px){.cf-cue-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}',
    '@container (min-width:900px){.cf-cue-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}',
    '.cf-cue{position:relative;display:flex;align-items:center;gap:10px;min-height:58px;padding:9px 12px;border-radius:var(--r-md);',
    '  border:1px solid transparent;background:var(--card);box-shadow:var(--shadow-soft);text-align:left;',
    '  transition:transform .15s cubic-bezier(.32,.72,0,1);overflow:hidden}',
    '.cf-cue:active{transform:scale(.96)}',
    '.cf-cue.is-high{border-color:var(--red);background:var(--red-soft);box-shadow:none}',
    '.cf-cue-icon{font-size:21px;flex:none}',
    '.cf-cue-copy{display:flex;flex-direction:column;min-width:0}',
    '.cf-cue-label{font-size:14px;font-weight:600;line-height:1.3}',
    '.cf-cue-desc{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cf-cue.sent::after{content:"✓ 已发送";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    '  background:var(--green);color:#fff;font-weight:600;font-size:15px;animation:cf-sent .9s ease forwards}',
    '@keyframes cf-sent{0%{opacity:0}12%{opacity:1}80%{opacity:1}100%{opacity:0}}',

    '.cf-myreqs{margin-bottom:18px}',
    '.cf-myreq{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r-sm);background:var(--card);box-shadow:var(--shadow-soft);margin-bottom:6px;transition:opacity .3s}',
    '.cf-myreq.is-done{opacity:.5;box-shadow:none}',
    '.cf-myreq-icon{flex:none;font-size:15px}',
    '.cf-myreq-label{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.cf-myreq-time{font-size:11px;color:var(--muted)}',
    '.cf-chip{flex:none;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600}',
    '.cf-chip.st-pending{background:var(--orange-soft);color:var(--orange)}',
    '.cf-chip.st-doing{background:var(--acc-soft);color:var(--acc)}',
    '.cf-chip.st-done{background:var(--green-soft);color:var(--green)}',
    '.cf-chip.st-high{background:var(--red-soft);color:var(--red)}',

    '.cf-compose{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border);background:var(--card)}',
    '.cf-compose input{flex:1;min-width:0;padding:11px 13px;border-radius:var(--r-md);border:1px solid var(--border-strong);background:var(--card);outline:none;font-size:16px;transition:border-color .15s,box-shadow .15s}',
    '.cf-compose input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}',
    '.cf-compose button{flex:none;min-width:72px;min-height:44px;padding:0 16px;border-radius:var(--r-md);background:var(--acc);color:#fff;font-size:14px;font-weight:600;transition:transform .15s,filter .15s}',
    '.cf-compose button:hover{filter:brightness(1.08)}',
    '.cf-compose button:active{transform:scale(.95)}',

    /* ── 聊天 ── */
    '.cf-thread{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:10px}',
    '.cf-empty{color:var(--muted);font-size:13px;text-align:center;padding:26px 10px}',
    '.cf-msg{max-width:86%;display:flex;flex-direction:column;gap:3px;align-self:flex-start}',
    '.cf-msg.mine{align-self:flex-end;align-items:flex-end}',
    '.cf-msg-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}',
    '.cf-msg-bubble{padding:9px 13px;border-radius:17px;border-top-left-radius:5px;background:var(--card3);font-size:14.5px;word-break:break-word}',
    '.cf-msg.mine .cf-msg-bubble{border-radius:17px;border-top-right-radius:5px;background:var(--acc);color:#fff}',
    '.cf-msg-card{align-self:stretch;max-width:100%;display:flex;gap:10px;padding:11px 13px;border-radius:var(--r-md);',
    '  background:var(--card);border:1px solid var(--border);box-shadow:var(--shadow-soft)}',
    '.cf-msg-card.is-reply{border-color:var(--acc);background:var(--acc-soft)}',
    '.cf-msg-card.is-unread{box-shadow:0 0 0 3px var(--acc-soft);animation:cf-pop .3s cubic-bezier(.32,.72,0,1)}',
    '.cf-msg-card-icon{font-size:17px;flex:none}',
    '.cf-msg-card-body{flex:1;min-width:0}',
    '.cf-msg-card-head{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--muted)}',
    '.cf-msg-card-text{font-size:14.5px;font-weight:500;word-break:break-word}',
    '.cf-msg-card-time{font-size:10.5px;color:var(--muted)}',

    /* ── 音控台 ── */
    '.cf-op{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}',
    '.cf-op-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(6px,1.5cqi,10px);padding:12px 16px 0}',
    '.cf-stat{padding:clamp(8px,2cqi,12px) clamp(10px,2.4cqi,14px);border-radius:var(--r-md);background:var(--card);box-shadow:var(--shadow-soft)}',
    '.cf-stat-label{font-size:clamp(10.5px,2.4cqi,11.5px);color:var(--muted);font-weight:500}',
    '.cf-stat-value{font-size:clamp(20px,4.6cqi,26px);font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
    '.cf-stat.is-alert .cf-stat-value{color:var(--red)}',
    /* 三栏按面板自身宽度断点（容器查询），嵌进窄容器也不挤扁 */
    '.cf-op-grid{flex:1;display:grid;grid-template-columns:240px minmax(0,1fr) 280px;gap:12px;padding:12px 16px 16px;min-height:0}',
    '@container (max-width:1020px){.cf-op-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.cf-op-panel.p-members{grid-column:1 / -1;max-height:220px}}',
    '@container (max-width:640px){.cf-op-grid{grid-template-columns:minmax(0,1fr)}.cf-op-panel{max-height:none;min-height:220px}}',
    /* 旧 iOS（<16，无容器查询）兜底：按视口宽度堆叠 */
    '@media (max-width:640px){.cf-op-grid{grid-template-columns:minmax(0,1fr)}.cf-op-panel{max-height:none;min-height:220px}}',
    '.cf-op-panel{display:flex;flex-direction:column;min-height:0;border-radius:var(--r-md);background:var(--card);box-shadow:var(--shadow-soft);overflow:hidden;border:1px solid transparent}',
    '.cf-op-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 13px;border-bottom:1px solid var(--border)}',
    '.cf-op-panel-title{font-size:13px;font-weight:600;letter-spacing:-.01em}',
    '.cf-op-scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px;-webkit-overflow-scrolling:touch}',
    '.cf-member{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}',
    '.cf-member:last-child{border-bottom:none}',
    '.cf-kick{flex:none;padding:4px 10px;border-radius:999px;background:var(--red-soft);color:var(--red);font-size:11.5px;font-weight:600}',
    '.cf-feed-item{display:flex;gap:9px;padding:9px 10px;border-radius:var(--r-sm);background:var(--card2);margin-bottom:8px}',
    '.cf-feed-item.is-high{background:var(--red-soft)}',
    '.cf-feed-icon{font-size:17px;flex:none}',
    '.cf-feed-body{flex:1;min-width:0}',
    '.cf-feed-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px}',
    '.cf-feed-kindchip{padding:2px 8px;border-radius:999px;background:var(--card3);color:var(--muted);font-size:10.5px;font-weight:600}',
    '.cf-feed-kindchip.k-chat{background:var(--acc-soft);color:var(--acc)}',
    '.cf-feed-kindchip.k-bcast{background:var(--orange-soft);color:var(--orange)}',
    '.cf-feed-kindchip.k-reply{background:var(--acc-soft);color:var(--acc)}',
    '.cf-feed-item.is-out{background:var(--acc-soft)}',
    '.cf-feed-text{font-size:14px;font-weight:500;word-break:break-word}',
    '.cf-feed-time{flex:none;font-size:10.5px;color:var(--muted)}',
    '.cf-bcast-presets{display:flex;flex-wrap:wrap;gap:7px;padding:10px 12px 4px}',
    '.cf-bcast-preset{padding:8px 13px;border-radius:999px;background:var(--card2);font-size:13px;font-weight:500;transition:background .15s}',
    '.cf-bcast-preset:hover{background:var(--acc-soft);color:var(--acc)}',
    '.cf-bcast-log-item{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:var(--r-sm);background:var(--card2);margin-bottom:6px;font-size:13px;font-weight:500}',
    '.cf-bcast-log-time{flex:none;font-size:10.5px;color:var(--muted);align-self:center}',

    /* ── 音控台看板 ── */
    '.cf-op-tabs{display:flex;gap:2px;margin:9px 12px 0;padding:3px;border-radius:10px;background:var(--card3);align-self:flex-start}',
    '.cf-op-tab{position:relative;padding:6px 14px;border-radius:8px;font-size:12.5px;font-weight:500;color:var(--muted);transition:color .15s,background .15s}',
    '.cf-op-tab.is-active{color:var(--text);background:var(--card);box-shadow:0 1px 4px rgba(0,0,0,.12);font-weight:600}',
    '.cf-op-tab-badge{display:inline-flex;min-width:17px;height:17px;padding:0 5px;margin-left:5px;border-radius:999px;background:var(--red);color:#fff;font-size:10px;font-weight:600;align-items:center;justify-content:center}',
    '.cf-sec{margin-bottom:16px}',
    '.cf-sec-head{display:flex;align-items:center;gap:7px;margin-bottom:7px;font-size:12px;font-weight:600;color:var(--muted)}',
    '.cf-sec-badge{min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:var(--acc);color:#fff;font-size:10.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}',
    '.cf-sec-badge.is-zero{background:var(--card3);color:var(--muted)}',
    '.cf-req{border:1px solid transparent;border-radius:var(--r-md);background:var(--card2);padding:10px 11px;margin-bottom:8px;transition:opacity .25s}',
    '.cf-req-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px}',
    '.cf-req-time{margin-left:auto;font-size:10.5px;color:var(--muted)}',
    '.cf-req-text{font-size:14px;font-weight:500;word-break:break-word}',
    '.cf-req.is-high{border-color:var(--red);background:var(--red-soft);animation:cf-req-pulse 1.2s ease-in-out infinite}',
    '@keyframes cf-req-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,59,48,0)}50%{box-shadow:0 0 0 3px var(--red-soft)}}',
    '.cf-req.st-done{opacity:.5;animation:none}',
    '.cf-req-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;flex-wrap:wrap}',
    '.cf-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--card3)}',
    '.cf-seg button{padding:5px 11px;border-radius:7px;font-size:11.5px;font-weight:500;color:var(--muted);transition:background .15s,color .15s}',
    '.cf-seg button.on{color:#fff;font-weight:600}',
    '.cf-seg button.on.sg-pending{background:var(--orange)}',
    '.cf-seg button.on.sg-doing{background:var(--acc)}',
    '.cf-seg button.on.sg-done{background:var(--green)}',
    '.cf-reply-btn{padding:6px 13px;border-radius:999px;background:var(--acc-soft);color:var(--acc);font-size:12px;font-weight:600}',
    '.cf-reply-row{margin-top:9px;padding-top:9px;border-top:1px solid var(--border)}',
    '.cf-reply-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px}',
    '.cf-reply-presets button{padding:6px 11px;border-radius:999px;background:var(--card3);font-size:12px;font-weight:500;transition:background .15s}',
    '.cf-reply-presets button:hover{background:var(--acc-soft);color:var(--acc)}',
    '.cf-reply-input-row{display:flex;gap:7px}',
    '.cf-reply-input-row input{flex:1;min-width:0;padding:8px 11px;border-radius:var(--r-sm);border:1px solid var(--border-strong);background:var(--card);outline:none;font-size:16px}',
    '.cf-reply-input-row input:focus{border-color:var(--acc)}',
    '.cf-reply-input-row button{padding:0 14px;border-radius:var(--r-sm);background:var(--acc);color:#fff;font-size:13px;font-weight:600;min-height:36px}',
    '.cf-replied{margin-top:7px;font-size:12px;color:var(--acc);background:var(--acc-soft);border-radius:var(--r-sm);padding:6px 9px}',
    '.cf-high-strip-label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--red);margin-bottom:7px}',
    '.cf-op-panel.has-alarm{border-color:var(--red);animation:cf-alarm 1.15s ease-in-out infinite}',
    '@keyframes cf-alarm{0%,100%{box-shadow:0 0 0 0 rgba(255,59,48,0)}50%{box-shadow:0 0 0 5px var(--red-soft)}}',
    '.cf-icon-btn{width:32px;height:32px;border-radius:50%;background:var(--card3);display:inline-flex;align-items:center;justify-content:center;font-size:15px}',
    '.cf-icon-btn.is-on{background:var(--red-soft)}',
    '.cf-op-head-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',

    /* ── 广播定向 ── */
    '.cf-target-row{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px 0}',
    '.cf-target-chip{padding:6px 11px;border-radius:999px;background:var(--card2);font-size:12px;font-weight:500;color:var(--muted);border:1px solid transparent;transition:background .15s,color .15s}',
    '.cf-target-chip.is-on{border-color:var(--acc);background:var(--acc-soft);color:var(--acc);font-weight:600}',

    /* ── Toast（跟随停靠角）── */
    '.cf-toasts{position:fixed;z-index:2147483647;display:flex;flex-direction:column;gap:10px;',
    '  max-width:min(340px,calc(100vw - 32px));pointer-events:none}',
    '.cf.dock-br .cf-toasts{right:calc(16px + var(--sar));bottom:calc(var(--dy,20px) + var(--sab) + 74px);align-items:flex-end}',
    '.cf.dock-bl .cf-toasts{left:calc(16px + var(--sal));bottom:calc(var(--dy,20px) + var(--sab) + 74px);align-items:flex-start}',
    '.cf.dock-tr .cf-toasts{right:calc(16px + var(--sar));top:calc(var(--dy,20px) + var(--sat) + 74px);align-items:flex-end}',
    '.cf.dock-tl .cf-toasts{left:calc(16px + var(--sal));top:calc(var(--dy,20px) + var(--sat) + 74px);align-items:flex-start}',
    '.cf-toast{pointer-events:auto;display:flex;gap:10px;padding:12px 14px;border-radius:var(--r-md);cursor:pointer;',
    '  background:var(--card);',
    '  border:1px solid var(--border);box-shadow:var(--shadow);animation:cf-toast-in .32s cubic-bezier(.32,.72,0,1)}',
    '@supports ((backdrop-filter:blur(4px)) or (-webkit-backdrop-filter:blur(4px))){',
    '  .cf-toast{background:var(--glass);-webkit-backdrop-filter:blur(20px) saturate(1.8);backdrop-filter:blur(20px) saturate(1.8)}',
    '}',
    '.cf-toast-icon{font-size:18px;flex:none}',
    '.cf-toast-body{flex:1;min-width:0}',
    '.cf-toast-head{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--acc)}',
    '.cf-toast-text{font-size:14px;font-weight:500;word-break:break-word}',
    '.cf-toast-time{font-size:10.5px;color:var(--muted)}',
    '@keyframes cf-toast-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}',
    '.cf-toast.hide{opacity:0;transform:translateY(10px) scale(.97);transition:opacity .25s,transform .25s}',

    /* ── flash 提示（HUD 胶囊）── */
    '.cf-flash{position:absolute;left:50%;bottom:76px;transform:translateX(-50%) translateY(8px);z-index:50;',
    '  padding:9px 18px;border-radius:999px;background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);',
    '  color:#fff;font-size:13.5px;font-weight:500;',
    '  opacity:0;pointer-events:none;transition:opacity .2s,transform .25s cubic-bezier(.32,.72,0,1);white-space:nowrap}',
    '.cf-flash.show{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.cf-flash.is-error{background:rgba(215,35,35,.9)}',

    /* ── 错误占位 ── */
    '.cf-fatal{padding:18px;color:var(--red);font-size:14px}',

    /* 滚动条 */
    '.cf ::-webkit-scrollbar{width:8px;height:8px}',
    '.cf ::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:99px}',
    '.cf ::-webkit-scrollbar-track{background:transparent}',

    /* ── 无障碍：减弱动效 ── */
    '@media (prefers-reduced-motion:reduce){',
    '  .cf,.cf *,.cf *::before,.cf *::after{animation:none!important;transition:none!important}',
    '  .cf.is-floating .cf-panel{transform:none}',
    '}'
  ].join('\n');

  /* ────────────────────────────────────────────
     悬浮球图标（Yesicon · solar:headphones-round-sound-bold，内联 SVG）
     声波三条竖线拆成独立 path（.cf-ic-bars）以便做呼吸动效
  ──────────────────────────────────────────── */

  var ICON_SVG = '<svg class="cf-ic" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">'
    + '<path fill="currentColor" d="M2 12.124C2 6.533 6.477 2 12 2s10 4.533 10 10.124v5.243c0 .817 0 1.378-.143 1.87a3.52 3.52 0 0 1-1.847 2.188c-.458.22-1.004.307-1.801.434l-.13.02a13 13 0 0 1-.727.105c-.209.02-.422.027-.64-.016a2.1 2.1 0 0 1-1.561-1.35a2.2 2.2 0 0 1-.116-.639c-.012-.204-.012-.452-.012-.742v-4.173c0-.425 0-.791.097-1.105a2.1 2.1 0 0 1 1.528-1.43c.316-.073.677-.044 1.096-.01l.093.007l.11.01c.783.062 1.32.104 1.775.275q.481.181.883.487v-1.174c0-4.811-3.853-8.711-8.605-8.711s-8.605 3.9-8.605 8.711v1.174c.267-.203.563-.368.883-.487c.455-.17.992-.213 1.775-.276l.11-.009l.093-.007c.42-.034.78-.063 1.096.01a2.1 2.1 0 0 1 1.528 1.43c.098.314.097.68.097 1.105v4.172c0 .291 0 .54-.012.743c-.012.213-.04.427-.116.638a2.1 2.1 0 0 1-1.56 1.35a2.2 2.2 0 0 1-.641.017c-.201-.02-.444-.059-.727-.104l-.13-.02c-.797-.128-1.344-.215-1.801-.436a3.52 3.52 0 0 1-1.847-2.188c-.118-.405-.139-.857-.142-1.461L2 17.58z"/>'
    + '<path class="cf-ic-bars" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M12 5.75a.75.75 0 0 1 .75.75v5a.75.75 0 1 1-1.5 0v-5a.75.75 0 0 1 .75-.75m3 1.5a.75.75 0 0 1 .75.75v2a.75.75 0 1 1-1.5 0V8a.75.75 0 0 1 .75-.75m-6 0a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-1.5 0V8A.75.75 0 0 1 9 7.25"/>'
    + '</svg>';

  /* 话筒图形（着 --tone 色，选身份卡片用） */
  var MIC_SVG = '<svg class="cf-mic" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<rect x="9" y="2.5" width="6" height="11" rx="3" fill="currentColor" stroke="none"/>'
    + '<path d="M5.5 11a6.5 6.5 0 0 0 13 0"/>'
    + '<path d="M12 17.5V21"/><path d="M8.5 21h7"/>'
    + '</svg>';

  /* 服务端拒绝音控鉴权时的 WebSocket close code（与 worker 的 OP_DENY_CLOSE_CODE 一致） */
  var CLOSE_OP_DENIED = 4001;

  /* 四角停靠 */
  var CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
  var CORNER_CLASS = { 'top-left': 'dock-tl', 'top-right': 'dock-tr', 'bottom-left': 'dock-bl', 'bottom-right': 'dock-br' };
  var CORNER_LABEL = { 'top-left': '左上', 'top-right': '右上', 'bottom-left': '左下', 'bottom-right': '右下' };
  var CORNER_GLYPH = { 'top-left': '◤', 'top-right': '◥', 'bottom-left': '◣', 'bottom-right': '◢' };

  /* ────────────────────────────────────────────
     应用实例（每个宿主元素一个）
  ──────────────────────────────────────────── */

  function CecpApp(host) {
    this.host = host;
    this.destroyed = false;
    this.readConfig();
    this.initState();
    this.buildShell();
    if (!this.wsUrl) {
      this.$stage.innerHTML = '<p class="cf-fatal">缺少 data-ws-url 属性</p>';
      return;
    }
    this.initTheme();
    this.bindEvents();
    this.boot();
  }

  CecpApp.prototype.readConfig = function () {
    var d = this.host.dataset || {};
    this.wsUrl = String(d.wsUrl || '').trim();

    var mode = String(d.mode || new URLSearchParams(location.search).get('mode') || 'client').trim().toLowerCase();
    if (['operator', 'client', 'listener', 'auto', 'menu'].indexOf(mode) < 0) mode = 'client';
    this.configMode = mode;

    var room = String(d.room || '').trim();
    this.room = /^[\w-]{1,64}$/.test(room) ? room : 'cecp-main';
    this.wsFullUrl = this.wsUrl
      ? this.wsUrl + (this.wsUrl.indexOf('?') >= 0 ? '&' : '?') + 'room=' + encodeURIComponent(this.room)
      : '';

    var layout = String(d.layout || '').trim().toLowerCase();
    if (layout === 'widget') layout = 'floating';
    this.isFloating = layout
      ? layout === 'floating'
      : (mode === 'auto' || mode === 'listener');

    this.presets = readPresetList(d.presets, DEFAULT_PRESETS);
    this.cueGroups = readCueGroups(d.cues);
    this.bcastPresets = readPresetList(d.broadcastPresets, DEFAULT_BCAST_PRESETS);
    this.launcherIcon = String(d.launcherIcon || '🎧');
    this.launcherLabel = String(d.launcherLabel || '调音助手');
    /* 教会名统一走 data-app-name（config.js 里改一处即可），不再散落在各界面里 */
    this.appName = String(d.appName || 'LAMEZIA 敬拜内通').trim() || 'LAMEZIA 敬拜内通';
    this.widgetTitle = String(d.widgetTitle || this.appName);
    this.pageKey = String(d.pageKey || location.pathname || 'global').trim();
    this.defaultPreset = String(d.defaultPreset || '').trim();
    this.enableChat = d.memberChat !== '0';
    this.floatRight = String(d.floatRight || '').trim();
    this.floatBottom = String(d.floatBottom || '').trim();
    /* 四角停靠：data-corner 显式指定 > 用户上次选择 > 自动避让；旧 data-float-side 映射为底部两角 */
    var corner = String(d.corner || '').trim().toLowerCase();
    if (CORNERS.indexOf(corner) < 0) {
      corner = d.floatSide === 'right' ? 'bottom-right' : (d.floatSide === 'left' ? 'bottom-left' : '');
    }
    this.cornerAttr = corner;
    /* data-launcher-icon 显式给了 emoji 就用 emoji，否则用内置声波耳机 SVG */
    this.launcherIconCustom = typeof d.launcherIcon === 'string' && d.launcherIcon.trim() !== '';
    /* data-fullscreen：单独页面用，铺满整个视口 + 内部滚动（menu 模式默认开） */
    this.fullscreen = ('fullscreen' in d)
      ? (d.fullscreen !== '0' && d.fullscreen !== 'false')
      : (this.configMode === 'menu');
  };

  CecpApp.prototype.initState = function () {
    this.ws = null;
    this.role = null;               // 'operator' | 'client' | 'listener' | null
    this.whoAmI = '';
    this.online = false;
    this.open = !this.isFloating;
    this.reconnectTimer = null;
    this.reconnectDelay = 3000;
    this.pingTimer = null;
    this.clockTimer = null;
    this.midnightTimer = null;
    this.flashTimer = null;
    this.suppressReconnect = false;
    this.wasEverOnline = false;
    this.pendingJoin = null;        // 加入中的身份（等 ack / name_taken）
    this.pendingOp = false;         // menu 模式选了音控、等服务器验证密码后才显示看板
    this.pendingOpPin = '';         // 本次输入的音控密码（等服务器校验）
    this.opKey = lsGet(this.storeKey('opkey')); // 已验证过的音控密钥，下次自动带上

    this.takenDevices = [];
    this.members = [];

    /* client 数据 */
    this.requests = [];             // 我发出的请求 {id,kind,icon,label,priority,ts,status}
    this.chat = [];                 // 群聊 + 广播 + 定向回复 {id,type,from,text,ts,mine,read}
    this.chatSeenTs = Date.now();
    this.activeTab = 'cues';

    /* operator 数据 */
    this.opReqs = [];               // 舞台请求 {id,from,kind,text,priority,status,ts,replied}
    this.opChat = [];               // 成员群聊 {id,from,text,ts}
    this.opBcasts = [];             // 已发广播
    this.opUnread = 0;
    this.opChatUnread = 0;
    this.opTab = 'board';           // 'board' | 'chat'
    this.opShowDone = false;        // 看板是否显示已解决
    this.opReplyOpenId = '';        // 展开回复框的请求 id
    this.alertMuted = lsGet(this.storeKey('opmute')) === '1';
    this.audioCtx = null;
    this.bcastTargets = [];         // 定向广播勾选的成员 name（空 = 全体）

    /* setup 状态 */
    this.setupSelected = '';
    this.setupPerson = '';
  };

  CecpApp.prototype.storeKey = function (suffix) {
    return 'cecp2:' + this.wsUrl + ':' + this.room + ':' + this.pageKey + ':' + suffix;
  };

  /* ── 视口方向（横向视口 = 面板横铺；纵向 = 竖排）── */

  CecpApp.prototype.syncViewport = function () {
    if (!this.$root) return;
    var landscape = window.innerWidth > window.innerHeight;
    this.$root.classList.toggle('orient-l', landscape);
    this.$root.classList.toggle('orient-p', !landscape);
  };

  CecpApp.prototype.startViewportWatch = function () {
    var self = this;
    var pending = null;
    this.viewportHandler = function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        if (self.destroyed) return;
        self.syncViewport();
        if (self.isFloating) self.applyCorner(self.corner, false);
      }, 120);
    };
    window.addEventListener('resize', this.viewportHandler);
    window.addEventListener('orientationchange', this.viewportHandler);
    /* 双保险：部分 WebView 只报 visualViewport / matchMedia */
    try {
      if (window.visualViewport) window.visualViewport.addEventListener('resize', this.viewportHandler);
    } catch (err) {}
    try {
      this.orientMedia = window.matchMedia('(orientation: portrait)');
      if (this.orientMedia.addEventListener) this.orientMedia.addEventListener('change', this.viewportHandler);
      else if (this.orientMedia.addListener) this.orientMedia.addListener(this.viewportHandler);
    } catch (err) {}
  };

  /* ── 四角停靠 + 避让页面固定元素 ── */

  /* 在角落取样：该角是否被页面其它固定元素占用 */
  CecpApp.prototype.probeCorner = function (corner) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = corner.indexOf('right') >= 0 ? vw - 30 : 30;
    var y = corner.indexOf('bottom') >= 0 ? vh - 30 : 30;
    var stack;
    try { stack = document.elementsFromPoint(x, y) || []; } catch (err) { return null; }
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (!el || el === this.host || el === this.portal || el === document.documentElement || el === document.body) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (err) { continue; }
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 18 || r.height < 14) continue;
      /* 大覆盖层（lightbox 遮罩等）不算角落元素 */
      if (r.width > vw * 0.7 && r.height > vh * 0.7) continue;
      return { el: el, rect: r };
    }
    return null;
  };

  /* 「工具导游」（Ring Coach，#rt5-enable 及其运行时生成的 rt5 系元素）所在的角。
     硬规则：intercom 永远不与它同角。导游元素初始在文档流里（static、零高），
     运行时才被库改成 fixed 按钮，所以要扫 rt5 家族里当前真正 fixed 的那个。 */
  CecpApp.prototype.tourCorner = function () {
    var list;
    try { list = document.querySelectorAll('#rt5-enable,[id^="rt5-"],[class*="rt5-"]'); } catch (err) { return ''; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var cs, r;
      try {
        cs = getComputedStyle(el);
        r = el.getBoundingClientRect();
      } catch (err) { continue; }
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (r.width < 10 || r.height < 10) continue;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      return (cy < window.innerHeight / 2 ? 'top' : 'bottom') + '-' + (cx < window.innerWidth / 2 ? 'left' : 'right');
    }
    return '';
  };

  CecpApp.prototype.resolveCorner = function () {
    var saved = lsGet(this.storeKey('corner'));
    var pref = [];
    if (this.cornerAttr) pref.push(this.cornerAttr);
    if (CORNERS.indexOf(saved) >= 0 && pref.indexOf(saved) < 0) pref.push(saved);
    CORNERS.forEach(function (c) { if (pref.indexOf(c) < 0) pref.push(c); });
    var tour = this.tourCorner();
    var firstFree = '';
    for (var i = 0; i < pref.length; i++) {
      var c = pref[i];
      if (c === tour) continue;             /* 硬规则 */
      if (!firstFree) firstFree = c;
      if (!this.probeCorner(c)) return c;   /* 完全空角优先 */
    }
    return firstFree || 'bottom-left';      /* 都有软障碍：取首选，靠偏移让开 */
  };

  CecpApp.prototype.applyCorner = function (corner) {
    if (!this.$root || !this.isFloating) return;
    corner = CORNERS.indexOf(corner) >= 0 ? corner : 'bottom-left';
    this.corner = corner;
    var self = this;
    CORNERS.forEach(function (c) { self.$root.classList.remove(CORNER_CLASS[c]); });
    this.$root.classList.add(CORNER_CLASS[corner]);
    /* 软障碍（回到顶部按钮、footer FAB 等）：纵向偏移让开 */
    var dx = this.floatRight || '20px';
    var dy = this.floatBottom || '20px';
    if (!this.floatBottom) {
      var ob = this.probeCorner(corner);
      if (ob) {
        var clear = corner.indexOf('bottom') >= 0
          ? Math.ceil(window.innerHeight - ob.rect.top) + 12
          : Math.ceil(ob.rect.bottom) + 12;
        if (clear > 8 && clear < 160) dy = clear + 'px';
      }
    }
    this.$root.style.setProperty('--dx', dx);
    this.$root.style.setProperty('--dy', dy);
    var pops = this.$root.querySelectorAll('.cf-dock-pop button');
    for (var i = 0; i < pops.length; i++) pops[i].classList.toggle('on', pops[i].dataset.corner === corner);
  };

  CecpApp.prototype.setCorner = function (corner, fromUser) {
    if (CORNERS.indexOf(corner) < 0) return;
    if (corner === this.tourCorner()) {
      this.flash('该角被「工具导游」占用', true);
      return;
    }
    lsSet(this.storeKey('corner'), corner);
    this.applyCorner(corner);
    if (fromUser) this.flash('已停靠' + CORNER_LABEL[corner]);
  };

  CecpApp.prototype.initDock = function () {
    var self = this;
    this.applyCorner(this.resolveCorner());
    /* 工具导游可能晚注入或移动：DOM 变化后重新避让 */
    var pending = null;
    var recheck = function () {
      clearTimeout(pending);
      pending = setTimeout(function () {
        if (self.destroyed) return;
        var tour = self.tourCorner();
        if (tour && tour === self.corner) self.applyCorner(self.resolveCorner());
        else self.applyCorner(self.corner);
      }, 400);
    };
    try {
      this.dockObserver = new MutationObserver(recheck);
      /* attributes 也要看：导游是运行时给已有元素改 style/class 变成 fixed 的 */
      this.dockObserver.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['style', 'class']
      });
    } catch (err) {}
    this.dockLateTimer = setTimeout(recheck, 1600);
  };

  /* ── Shadow DOM 外壳 ── */

  CecpApp.prototype.buildShell = function () {
    /* 悬浮模式：UI 传送到 document.body 的独立宿主（portal）。
       CMS 文章会被 youth-engine 等脚本加 transform/filter 动画，
       position:fixed 元素若留在文章 DOM 里会被变换祖先「困住」——
       坐标基准变成祖先、z-index 也被压进祖先的层叠上下文，
       表现为面板与站点顶栏重合、被标签弹层/灯箱盖住。 */
    if (this.isFloating || this.fullscreen) {
      if (!this.portal) {
        this.portal = document.createElement('cecp-intercom-layer');
        this.portal.style.cssText = this.isFloating
          /* 悬浮：零干扰宿主，不占布局、不挡触摸——只有球/面板/toast 自身可交互 */
          ? 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483644'
          /* 全屏页：铺满视口盖住站点（像 musictool 独占屏幕） */
          : 'position:fixed;inset:0;z-index:2147483600';
        (document.body || document.documentElement).appendChild(this.portal);
      }
      this.shadow = this.portal.shadowRoot || this.portal.attachShadow({ mode: 'open' });
      /* 全屏页：锁背景滚动，销毁时恢复 */
      if (this.fullscreen && !this.isFloating && this._prevHtmlOverflow === undefined) {
        this._prevHtmlOverflow = document.documentElement.style.overflow;
        this._prevBodyOverflow = document.body ? document.body.style.overflow : '';
        document.documentElement.style.overflow = 'hidden';
        if (document.body) document.body.style.overflow = 'hidden';
      }
    } else {
      this.shadow = this.host.shadowRoot || this.host.attachShadow({ mode: 'open' });
    }
    this.shadow.innerHTML = '';

    var style = document.createElement('style');
    style.textContent = CSS;
    this.shadow.appendChild(style);

    var root = document.createElement('div');
    root.className = 'cf ' + (this.isFloating ? 'is-floating' : 'is-page')
      + (!this.isFloating && this.fullscreen ? ' is-fullscreen' : '');

    var html = '';
    if (this.isFloating) {
      html += '<button class="cf-launcher" type="button" data-action="toggle" aria-label="' + esc(this.launcherLabel) + '" aria-expanded="false">'
        + (this.launcherIconCustom ? '<span style="font-size:25px">' + esc(this.launcherIcon) + '</span>' : ICON_SVG)
        + '<span class="cf-launcher-badge" hidden>0</span>'
        + '</button>'
        + '<div class="cf-mask" data-action="close"></div>';
    }
    html += '<section class="cf-panel" role="' + (this.isFloating ? 'dialog' : 'region') + '" aria-label="' + esc(this.widgetTitle) + '">'
      + '<div class="cf-bar">'
      + '  <div><span class="cf-bar-kicker">' + esc(this.appName) + '</span>'
      + (this.widgetTitle && this.widgetTitle !== this.appName
          ? '<span class="cf-bar-title">' + esc(this.widgetTitle) + '</span>' : '')
      + '</div>'
      + '  <div class="cf-bar-tools">'
      + '    <span class="cf-status"><span class="cf-dot"></span><span class="cf-status-label">未连接</span></span>'
      + (this.isFloating
          ? '    <button class="cf-dock-btn" type="button" data-action="dock-pick" aria-label="切换停靠角" title="切换停靠角"><span class="cf-dock-glyph"></span></button>'
            + '    <div class="cf-dock-pop" role="menu">'
            + CORNERS.map(function (c) {
                return '<button type="button" role="menuitem" data-action="dock-set" data-corner="' + c + '" aria-label="' + CORNER_LABEL[c] + '">' + CORNER_GLYPH[c] + '</button>';
              }).join('')
            + '</div>'
          : '')
      + '    <button class="cf-bar-close" type="button" data-action="close" aria-label="关闭">✕</button>'
      + '  </div>'
      + '</div>'
      + '<div class="cf-offline" role="status" hidden>⚠️ 连接断开，正在自动重连…</div>'
      + '<div class="cf-stage"></div>'
      + '<div class="cf-flash" role="status"></div>'
      + '</section>'
      + '<div class="cf-toasts" aria-live="polite"></div>';

    root.innerHTML = html;
    this.shadow.appendChild(root);

    this.$root = root;
    this.$panel = root.querySelector('.cf-panel');
    this.$stage = root.querySelector('.cf-stage');
    this.$toasts = root.querySelector('.cf-toasts');
    this.$launcher = root.querySelector('.cf-launcher');
    this.$badge = root.querySelector('.cf-launcher-badge');
    this.$flash = root.querySelector('.cf-flash');
    this.syncViewport();
    this.syncOpenState();
  };

  /* ── 主题探测（页面显式声明 → 背景亮度 → 系统偏好）── */

  CecpApp.prototype.detectTheme = function () {
    var hostAttr = (this.host.getAttribute('data-theme') || '').toLowerCase();
    if (hostAttr === 'dark' || hostAttr === 'light') return hostAttr;

    var els = [document.documentElement, document.body];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      var text = [
        el.getAttribute('data-theme'), el.getAttribute('data-color-mode'), el.getAttribute('data-bs-theme'), el.className
      ].join(' ').toLowerCase();
      if (/\b(dark|night|theme-dark|is-dark)\b/.test(text)) return 'dark';
      if (/\b(light|day|theme-light|is-light)\b/.test(text)) return 'light';
    }

    for (var j = 0; j < els.length; j++) {
      var cand = els[j];
      if (!cand) continue;
      var match = String(getComputedStyle(cand).backgroundColor || '').match(/rgba?\(([^)]+)\)/i);
      if (!match) continue;
      var parts = match[1].split(',').map(parseFloat);
      if (parts.length < 3 || parts.some(function (p, idx) { return idx < 3 && isNaN(p); })) continue;
      var alpha = parts.length > 3 && !isNaN(parts[3]) ? parts[3] : 1;
      if (alpha <= 0.55) continue;
      var luma = parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
      return luma < 128 ? 'dark' : 'light';
    }

    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (err) {
      return 'light';
    }
  };

  CecpApp.prototype.syncTheme = function () {
    if (this.destroyed || !this.$root) return;
    this.$root.classList.toggle('is-dark', this.detectTheme() === 'dark');
  };

  CecpApp.prototype.initTheme = function () {
    var self = this;
    this.syncTheme();
    try {
      this.themeObserver = new MutationObserver(function () { self.syncTheme(); });
      var opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme'] };
      this.themeObserver.observe(document.documentElement, opts);
      if (document.body) this.themeObserver.observe(document.body, opts);
      this.themeObserver.observe(this.host, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (err) {}
    try {
      if (window.matchMedia) {
        this.themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
        this.themeMediaHandler = function () { self.syncTheme(); };
        if (this.themeMedia.addEventListener) this.themeMedia.addEventListener('change', this.themeMediaHandler);
        else if (this.themeMedia.addListener) this.themeMedia.addListener(this.themeMediaHandler);
      }
    } catch (err) {}
  };

  /* ── 事件委托 ── */

  CecpApp.prototype.bindEvents = function () {
    var self = this;

    this.$root.addEventListener('click', function (event) {
      var el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
      if (!el) return;
      self.onAction(el.dataset.action, el, event);
    });

    this.$root.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      var el = event.target && event.target.closest ? event.target.closest('[data-enter]') : null;
      if (!el) return;
      event.preventDefault();
      self.onAction(el.dataset.enter, el, event);
    });

    this.$root.addEventListener('input', function (event) {
      var el = event.target;
      if (el && el.classList && el.classList.contains('cf-name-input')) {
        self.setupPerson = String(el.value || '').trim();
        self.syncSetupPreview();
      }
    });

    this.docKeyHandler = function (event) {
      if (event.key === 'Escape' && self.isFloating && self.open) self.closeWidget();
    };
    document.addEventListener('keydown', this.docKeyHandler);

    /* 触摸/滚轮隔离：面板打开时，手指落在面板里就只作用于面板——
       能滚的内部区域自己滚（overscroll-contain 挡边界串联），
       落在不可滚区域的滑动直接吞掉，绝不透给底下的网页；
       遮罩上的滑动同样吞掉。页面模式（嵌入文档流）不拦截。 */
    var guardScroll = function (event) {
      if (!self.isFloating || !self.open) return;
      var node = event.target;
      var scrollable = null;
      while (node && node !== self.$panel) {
        if (node.nodeType === 1) {
          var cs;
          try { cs = getComputedStyle(node); } catch (err) { break; }
          if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1) {
            scrollable = node;
            break;
          }
        }
        node = node.parentNode;
      }
      if (!scrollable) event.preventDefault();
    };
    if (this.$panel) {
      this.$panel.addEventListener('touchmove', guardScroll, { passive: false });
      this.$panel.addEventListener('wheel', guardScroll, { passive: false });
    }
    var mask = this.$root.querySelector('.cf-mask');
    if (mask) {
      mask.addEventListener('touchmove', function (event) { event.preventDefault(); }, { passive: false });
      mask.addEventListener('wheel', function (event) { event.preventDefault(); }, { passive: false });
    }
  };

  CecpApp.prototype.onAction = function (action, el) {
    switch (action) {
      case 'toggle': this.open ? this.closeWidget() : this.openWidget(); break;
      case 'close': this.closeWidget(); break;
      case 'pick-device': this.pickDevice(el.dataset.name || ''); break;
      case 'join': this.joinAsClient(); break;
      case 'reset-device': this.resetDevice(); break;
      case 'pick-role':
        /* 记住过密钥就直接验证登录，省掉每次输密码；失效会退回密码框 */
        if (el.dataset.role === 'operator') {
          if (this.opKey) this.enterOperator(this.opKey);
          else this.showOpPin();
        } else { this.role = null; this.showSetup(); }
        break;
      case 'op-pin-submit': this.enterOperator(); break;
      case 'back-menu': this.backToMenu(); break;
      case 'tab': this.switchTab(el.dataset.tab || 'cues'); break;
      case 'cue': this.sendCue(el); break;
      case 'send-custom': this.sendCustom(el); break;
      case 'send-chat': this.sendChat(el); break;
      case 'read-broadcast': this.markRead(el.dataset.id || ''); break;
      case 'dismiss-toast': this.dismissToast(el.closest('.cf-toast')); break;
      case 'bcast-send': this.opSendBroadcast(); break;
      case 'bcast-preset': this.opSendBroadcast(el.dataset.text || ''); break;
      case 'bcast-target': this.bcastTargetToggle(el.dataset.name || ''); break;
      case 'bcast-target-all': this.bcastTargetToggle(''); break;
      case 'kick': this.opKick(el.dataset.name || ''); break;
      case 'kick-all': this.opKickAll(); break;
      case 'op-status': this.opSetStatus(el.dataset.id || '', el.dataset.status || ''); break;
      case 'op-reply-toggle': this.opReplyToggle(el.dataset.id || ''); break;
      case 'op-reply-preset': this.opReplySend(el.dataset.id || '', el.dataset.text || ''); break;
      case 'op-reply-send': this.opReplySend(el.dataset.id || '', ''); break;
      case 'op-tab': this.opSwitchTab(el.dataset.tab || 'board'); break;
      case 'op-toggle-done': this.opShowDone = !this.opShowDone; this.renderOpBoard(); break;
      case 'op-mute': this.opToggleMute(); break;
      case 'clear-feed':
        if (this.opTab === 'chat') {
          this.opChat = [];
          this.opChatUnread = 0;
          this.renderOpChat();
        } else {
          this.opReqs = [];
          this.opReplyOpenId = '';
          this.renderOpBoard();
          this.updateOpStats();
        }
        break;
      case 'clear-chat': this.chat = []; this.saveChat(); this.renderChatPane(); this.syncBanner(); this.syncBadge(); break;
      case 'dock-pick': {
        var pop = this.$root.querySelector('.cf-dock-pop');
        if (pop) pop.classList.toggle('show');
        break;
      }
      case 'dock-set': {
        this.setCorner(el.dataset.corner || '', true);
        var pop2 = this.$root.querySelector('.cf-dock-pop');
        if (pop2) pop2.classList.remove('show');
        break;
      }
      case 'fullscreen': this.toggleFullscreen(); break;
      default: break;
    }
  };

  /* ── 启动分流 ── */

  CecpApp.prototype.boot = function () {
    this.checkDailyClear();
    this.scheduleMidnightClear();
    this.syncViewport();
    this.startViewportWatch();
    if (this.isFloating) this.initDock();

    if (this.configMode === 'menu') {
      /* 合体入口：先选角色，不预连接 */
      this.showMenu();
      return;
    }

    if (this.configMode === 'operator') {
      this.role = 'operator';
      this.showOperator();
      this.connect();
      return;
    }

    if (this.configMode === 'listener') {
      this.role = 'listener';
      this.connect();
      return;
    }

    /* client / auto */
    var remembered = lsGet(this.storeKey('name'));
    if (!remembered && this.defaultPreset && this.presets.indexOf(this.defaultPreset) >= 0) {
      remembered = this.defaultPreset;
    }

    if (remembered) {
      this.whoAmI = remembered;
      this.role = 'client';
      this.loadHistory();
      this.showClient();
      this.connect();
      return;
    }

    if (this.configMode === 'auto') {
      /* 被动 listener：不弹身份选择，等用户点开再升级 */
      this.role = 'listener';
      this.connect();
      return;
    }

    this.showSetup();
  };

  /* ── WebSocket 连接管理 ── */

  CecpApp.prototype.wsReady = function () {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  };

  CecpApp.prototype.wsSend = function (obj) {
    if (!this.wsReady()) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (err) { return false; }
  };

  CecpApp.prototype.connect = function () {
    if (this.destroyed || !this.role) return;
    var self = this;
    this.suppressReconnect = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) { try { this.ws.close(); } catch (err) {} this.ws = null; }

    var socket;
    try {
      socket = new WebSocket(this.wsFullUrl);
    } catch (err) {
      this.setStatus(false);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', function () {
      if (self.destroyed || self.ws !== socket) return;
      self.reconnectDelay = 3000;
      self.setStatus(true);
      self.startPing();
      self.sendRegister();
    });

    socket.addEventListener('close', function (event) {
      if (self.destroyed || self.ws !== socket) return;
      self.setStatus(false);
      self.stopPing();
      /* 4001 = 服务端拒绝音控鉴权。兜底：万一 op_denied 没先到，也绝不无脑重连硬撞密码 */
      if (event && event.code === CLOSE_OP_DENIED) {
        self.suppressReconnect = true;
        if (self.pendingOp || self.role === 'operator') self.onOpDenied('key_wrong');
        return;
      }
      if (!self.suppressReconnect) self.scheduleReconnect();
    });

    socket.addEventListener('error', function () {
      try { socket.close(); } catch (err) {}
    });

    socket.addEventListener('message', function (event) {
      if (self.destroyed) return;
      var msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      self.handleMessage(msg);
    });
  };

  CecpApp.prototype.sendRegister = function () {
    if (this.role === 'operator') {
      var reg = { type: 'register', name: '音控组', role: 'operator', identityType: 'operator' };
      /* 密钥走消息体而不是 URL 查询串：查询串会进 Cloudflare 日志 / 中间代理 */
      var opKey = this.pendingOpPin || this.opKey;
      if (opKey) reg.key = opKey;
      this.wsSend(reg);
    } else if (this.role === 'client') {
      this.wsSend({
        type: 'register',
        name: this.whoAmI,
        role: 'client',
        identityType: detectIdentityType(this.whoAmI)
      });
    } else if (this.role === 'listener') {
      this.wsSend({ type: 'register', name: '', role: 'listener', identityType: 'listener' });
    }
  };

  CecpApp.prototype.scheduleReconnect = function () {
    if (this.destroyed || this.suppressReconnect || !this.role) return;
    var self = this;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(function () { self.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(Math.round(this.reconnectDelay * 1.5), 15000);
  };

  CecpApp.prototype.startPing = function () {
    var self = this;
    this.stopPing();
    this.pingTimer = setInterval(function () {
      self.wsSend({ type: 'ping' });
    }, 25000);
  };

  CecpApp.prototype.stopPing = function () {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  };

  CecpApp.prototype.stopConnection = function () {
    this.suppressReconnect = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    if (this.ws) { try { this.ws.close(); } catch (err) {} this.ws = null; }
    this.setStatus(false);
  };

  /* ── 服务端消息处理 ── */

  CecpApp.prototype.handleMessage = function (msg) {
    var type = String(msg.type || '');

    if (type === 'pong') return;

    if (type === 'ack') {
      if (this.pendingJoin && msg.role === 'client') this.pendingJoin = null;
      /* menu 模式音控：密码通过、服务器确认后才显示看板 */
      if (this.pendingOp && msg.role === 'operator') {
        this.pendingOp = false;
        /* 服务端认过了才记住，避免把错密码存进去 */
        if (this.pendingOpPin) {
          this.opKey = this.pendingOpPin;
          lsSet(this.storeKey('opkey'), this.opKey);
        }
        this.pendingOpPin = '';
        this.showOperator();
      }
      return;
    }

    if (type === 'op_denied') {
      this.onOpDenied(msg.reason);
      return;
    }

    if (type === 'name_taken') {
      var takenName = msg.name || this.whoAmI;
      this.pendingJoin = null;
      lsDel(this.storeKey('name'));
      this.whoAmI = '';
      if (this.configMode === 'auto' || this.configMode === 'listener') {
        /* 升级失败：退回 listener 继续被动收听（同一连接，服务端未改写身份，重注册保险起见） */
        this.role = 'listener';
        this.sendRegister();
      } else {
        this.role = null;
        this.stopConnection();
      }
      this.showSetup('「' + takenName + '」已有人在使用，请选择其他设备。');
      if (this.isFloating) this.openWidget();
      return;
    }

    if (type === 'kicked') {
      lsDel(this.storeKey('name'));
      this.whoAmI = '';
      this.requests = [];
      this.chat = [];
      this.saveRequests();
      this.saveChat();
      this.stopConnection();
      var reason = msg.reason === 'daily_reset'
        ? '系统已在午夜自动重置，请重新选择设备。'
        : '你已被音控组请出，请重新选择设备。';
      if (this.configMode === 'auto') {
        this.role = 'listener';
        this.connect();
      } else {
        this.role = null;
      }
      this.showSetup(reason);
      if (this.isFloating) this.openWidget();
      return;
    }

    if (type === 'daily_reset') {
      this.requests = [];
      this.chat = [];
      this.saveRequests();
      this.saveChat();
      this.opReqs = [];
      this.opChat = [];
      this.opBcasts = [];
      this.opUnread = 0;
      this.opChatUnread = 0;
      this.opReplyOpenId = '';
      if (this.role === 'operator') {
        this.members = [];
        this.renderMembers();
        this.renderOpBoard();
        this.renderOpChat();
        this.renderBcastTargets();
        this.renderOpBcastLog();
        this.updateOpStats();
      } else if (this.role === 'client') {
        this.renderRequests();
        this.renderChatPane();
        this.syncBanner();
      }
      this.syncBadge();
      return;
    }

    if (type === 'taken_devices') {
      this.takenDevices = Array.isArray(msg.names) ? msg.names : [];
      this.syncSetupTaken();
      return;
    }

    if (type === 'member_list') {
      var members = Array.isArray(msg.members) ? msg.members : [];
      this.takenDevices = members.map(function (m) { return m.name; });
      this.members = members;
      this.syncSetupTaken();
      if (this.role === 'operator') {
        this.renderMembers();
        this.updateOpStats();
      }
      return;
    }

    if (type === 'broadcast') {
      if (this.role === 'operator') return;
      var entry = {
        id: String(msg.id || nowId('broadcast')),
        type: 'broadcast',
        from: '音控组',
        text: String(msg.text || ''),
        ts: Number(msg.ts || Date.now()),
        mine: false,
        read: false
      };
      if (!entry.text) return;
      this.appendChat(entry);
      this.syncBanner();
      if (this.role === 'listener' || (this.isFloating && !this.open)) {
        this.toast('📢', '音控组消息', entry.text, entry.ts);
      }
      vibrate([20, 40, 20]);
      this.syncBadge();
      return;
    }

    if (type === 'operator_reply') {
      if (this.role !== 'client') return;
      var reply = {
        id: String(msg.id || nowId('reply')),
        type: 'reply',
        from: '音控组',
        text: String(msg.text || ''),
        ts: Number(msg.ts || Date.now()),
        mine: false,
        read: false
      };
      if (!reply.text) return;
      this.appendChat(reply);
      this.syncBanner();
      if (this.isFloating && !this.open) this.toast('🎧', '音控回复', reply.text, reply.ts);
      vibrate([20, 40, 20]);
      this.syncBadge();
      return;
    }

    if (type === 'member_chat') {
      var chatEntry = {
        id: String(msg.id || nowId('member')),
        type: 'chat',
        from: String(msg.from || '?'),
        text: String(msg.text || ''),
        ts: Number(msg.ts || Date.now()),
        mine: false,
        read: true
      };
      if (!chatEntry.text) return;
      if (this.role === 'operator') {
        if (this.opChat.some(function (c) { return c.id === chatEntry.id; })) return; // 去重
        this.opChat.unshift({ kind: 'member', id: chatEntry.id, from: chatEntry.from, text: chatEntry.text, ts: chatEntry.ts });
        if (this.opChat.length > 200) this.opChat.pop();
        if (this.isFloating && !this.open && !msg.replay) this.opUnread += 1;
        if (this.opTab !== 'chat' && !msg.replay) this.opChatUnread += 1;
        this.renderOpChat();
        this.syncBadge();
      } else if (this.role === 'client') {
        this.appendChat(chatEntry);
        this.syncBadge();
      }
      return;
    }

    if (type === 'worship_msg') {
      if (this.role !== 'operator') return;
      var wId = String(msg.id || nowId('worship'));
      if (this.opReqs.some(function (r) { return r.id === wId; })) return; // 去重（回放/重连）
      var newReq = {
        id: wId,
        from: String(msg.from || '?'),
        kind: String(msg.kind || 'custom'),
        text: String(msg.text || ''),
        priority: msg.priority === 'high' ? 'high' : 'normal',
        status: ['pending', 'doing', 'done'].indexOf(msg.status) >= 0 ? msg.status : 'pending',
        replied: '',
        ts: Number(msg.ts || Date.now())
      };
      this.opReqs.unshift(newReq);
      if (this.opReqs.length > 120) this.opReqs.pop();
      if (this.isFloating && !this.open && !msg.replay) this.opUnread += 1;
      /* 回放不响警报，只有实时高优才响 */
      if (newReq.priority === 'high' && newReq.status !== 'done' && !msg.replay) this.playAlert();
      this.renderOpBoard();
      this.updateOpStats();
      this.syncBadge();
      return;
    }

    if (type === 'msg_status') {
      var id = String(msg.id || '');
      var status = ['pending', 'doing', 'done'].indexOf(msg.status) >= 0 ? msg.status : '';
      if (!id || !status) return;
      var changed = false;
      this.requests.forEach(function (req) {
        if (req.id === id && req.status !== status) { req.status = status; changed = true; }
      });
      if (changed && this.role === 'client') {
        this.saveRequests();
        this.renderRequests();
      }
      this.opReqs.forEach(function (item) {
        if (item.id === id) item.status = status;
      });
      if (this.role === 'operator') {
        this.renderOpBoard();
        this.updateOpStats();
      }
      return;
    }

    /* 未知类型：安全忽略 */
  };

  /* ── 状态指示 ── */

  CecpApp.prototype.statusLabel = function () {
    if (this.online) return '在线';
    return this.role ? '离线' : '未连接';
  };

  CecpApp.prototype.setStatus = function (online) {
    var wasOnline = this.online;
    this.online = !!online;
    var dots = this.$root.querySelectorAll('.cf-dot');
    var labels = this.$root.querySelectorAll('.cf-status-label');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('online', this.online);
    for (var j = 0; j < labels.length; j++) labels[j].textContent = this.statusLabel();
    /* 断线提示条：有身份连接中断时显示，恢复即撤并提示 */
    var strip = this.$root.querySelector('.cf-offline');
    if (strip) strip.hidden = this.online || !this.role;
    if (!wasOnline && this.online && this.wasEverOnline) this.flash('已重新连接 ✓');
    if (this.online) this.wasEverOnline = true;
  };

  CecpApp.prototype.statusHtml = function () {
    return '<span class="cf-status"><span class="cf-dot' + (this.online ? ' online' : '') + '"></span>'
      + '<span class="cf-status-label">' + this.statusLabel() + '</span></span>';
  };

  /* ── 悬浮开合 ── */

  CecpApp.prototype.syncOpenState = function () {
    if (!this.isFloating) return;
    this.$root.classList.toggle('is-open', !!this.open);
    if (this.$launcher) this.$launcher.setAttribute('aria-expanded', this.open ? 'true' : 'false');
  };

  CecpApp.prototype.openWidget = function () {
    if (!this.isFloating) return;
    /* auto 模式且尚未选身份：点开 = 想发消息 → 进入选身份流程 */
    if (this.role === 'listener' && !this.$stage.querySelector('.cf-app')) {
      this.showSetup();
    }
    this.open = true;
    this.opUnread = 0;
    this.syncOpenState();
    this.syncBadge();
  };

  CecpApp.prototype.closeWidget = function () {
    if (!this.isFloating) return;
    this.open = false;
    var pop = this.$root.querySelector('.cf-dock-pop');
    if (pop) pop.classList.remove('show');
    this.syncOpenState();
    this.syncBadge();
  };

  CecpApp.prototype.syncBadge = function () {
    if (!this.$badge) return;
    var count = 0;
    if (this.role === 'operator') {
      count = this.open ? 0 : this.opUnread;
    } else {
      var seen = this.chatSeenTs;
      var showingChat = this.open && this.activeTab === 'chat';
      count = this.chat.reduce(function (acc, item) {
        if ((item.type === 'broadcast' || item.type === 'reply') && !item.read) return acc + 1;
        if (item.type === 'chat' && !item.mine && item.ts > seen && !showingChat) return acc + 1;
        return acc;
      }, 0);
      if (this.open && this.activeTab === 'chat') {
        count = this.chat.filter(function (item) {
          return (item.type === 'broadcast' || item.type === 'reply') && !item.read;
        }).length;
      }
    }
    this.$badge.hidden = !count;
    this.$badge.textContent = count > 99 ? '99+' : String(count || 0);
    /* 未读：悬浮球声波扩散动效 */
    if (this.$launcher) this.$launcher.classList.toggle('has-unread', count > 0 && !this.open);
  };

  /* ── Toast ── */

  CecpApp.prototype.toast = function (icon, head, text, ts) {
    if (!this.$toasts) return;
    var self = this;
    var el = document.createElement('div');
    el.className = 'cf-toast';
    el.setAttribute('data-action', 'dismiss-toast');
    el.innerHTML = '<span class="cf-toast-icon">' + esc(icon) + '</span>'
      + '<div class="cf-toast-body">'
      + '<div class="cf-toast-head">' + esc(head) + '</div>'
      + '<div class="cf-toast-text">' + esc(text) + '</div>'
      + '<div class="cf-toast-time">' + esc(fmtTime(ts)) + '</div>'
      + '</div>';
    this.$toasts.appendChild(el);
    while (this.$toasts.children.length > 3) this.$toasts.removeChild(this.$toasts.firstChild);
    el.__timer = setTimeout(function () { self.dismissToast(el); }, 9000);
  };

  CecpApp.prototype.dismissToast = function (el) {
    if (!el || !el.parentElement) return;
    clearTimeout(el.__timer);
    el.classList.add('hide');
    setTimeout(function () {
      if (el.parentElement) el.parentElement.removeChild(el);
    }, 260);
  };

  /* ── flash 提示 ── */

  CecpApp.prototype.flash = function (text, isError) {
    if (!this.$flash) return;
    var self = this;
    this.$flash.textContent = text;
    this.$flash.classList.toggle('is-error', !!isError);
    this.$flash.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(function () {
      self.$flash.classList.remove('show');
      self.$flash.classList.remove('is-error');
    }, 1700);
  };

  /* ── 本地存储 ── */

  CecpApp.prototype.loadHistory = function () {
    this.requests = [];
    this.chat = [];
    var reqRaw = parseJsonMaybe(lsGet(this.storeKey('req:' + this.whoAmI)));
    if (Array.isArray(reqRaw)) {
      this.requests = reqRaw.filter(function (r) { return r && r.id && r.label; }).slice(0, 40);
    }
    var chatRaw = parseJsonMaybe(lsGet(this.storeKey('chat')));
    if (Array.isArray(chatRaw)) {
      this.chat = chatRaw.filter(function (c) { return c && c.id && c.text; }).slice(-160);
    }
  };

  CecpApp.prototype.saveRequests = function () {
    if (!this.whoAmI) return;
    lsSet(this.storeKey('req:' + this.whoAmI), JSON.stringify(this.requests.slice(0, 40)));
  };

  CecpApp.prototype.saveChat = function () {
    lsSet(this.storeKey('chat'), JSON.stringify(this.chat.slice(-160)));
  };

  CecpApp.prototype.checkDailyClear = function () {
    var today = fmtDayStamp();
    if (lsGet(this.storeKey('day')) === today) return;
    lsSet(this.storeKey('day'), today);
    lsDel(this.storeKey('chat'));
    if (this.whoAmI) lsDel(this.storeKey('req:' + this.whoAmI));
  };

  CecpApp.prototype.scheduleMidnightClear = function () {
    var self = this;
    clearTimeout(this.midnightTimer);
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
    this.midnightTimer = setTimeout(function () {
      self.checkDailyClear();
      self.requests = [];
      self.chat = [];
      if (self.role === 'client') {
        self.renderRequests();
        self.renderChatPane();
        self.syncBanner();
        self.syncBadge();
      }
      self.scheduleMidnightClear();
    }, Math.max(1000, next.getTime() - now.getTime()));
  };

  /* ────────────────────────────────────────────
     Setup：选设备 + 名字
  ──────────────────────────────────────────── */

  /* ── menu 模式：角色选择 + 音控密码 ── */

  CecpApp.prototype.showMenu = function () {
    var html = '<div class="cf-app is-menu" style="display:flex;flex-direction:column;flex:1;min-height:0">'
      + '<div class="cf-menu"><div class="cf-menu-inner">'
      + '  <span class="cf-menu-kicker">' + esc(this.appName) + '</span>'
      + '  <h2>你是哪一位？</h2>'
      + '  <p class="cf-menu-sub">选择你今天的角色</p>'
      + '  <div class="cf-role-grid">'
      + '    <button class="cf-role" type="button" data-action="pick-role" data-role="client">'
      + '      <span class="cf-role-icon">🎤</span>'
      + '      <span class="cf-role-title">敬拜团</span>'
      + '      <span class="cf-role-sub">发送快捷消息给音控组</span>'
      + '    </button>'
      + '    <button class="cf-role is-op" type="button" data-action="pick-role" data-role="operator">'
      + '      <span class="cf-role-icon">🎚️</span>'
      + '      <span class="cf-role-title">音控组</span>'
      + '      <span class="cf-role-sub">接收消息 · 发全体通知<br><span class="cf-role-lock">🔒 需密码</span></span>'
      + '    </button>'
      + '  </div>'
      + '</div></div>'
      + '</div>';
    this.$stage.innerHTML = html;
    this.setStatus(this.online);
  };

  CecpApp.prototype.showOpPin = function (errorText) {
    var html = '<div class="cf-app is-pin" style="display:flex;flex-direction:column;flex:1;min-height:0">'
      + '<div class="cf-pin">'
      + '  <div class="cf-pin-icon">🎛️</div>'
      + '  <h2>音控台登录</h2>'
      + '  <p class="cf-pin-sub">输入音控密码进入。只有负责音控的同工需要。</p>'
      + '  <input class="cf-pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="••••" data-enter="op-pin-submit">'
      + '  <div class="cf-pin-error">' + esc(errorText || '') + '</div>'
      + '  <div class="cf-pin-actions">'
      + '    <button class="cf-back-btn" type="button" data-action="back-menu">返回</button>'
      + '    <button class="cf-btn-primary" type="button" data-action="op-pin-submit">进入</button>'
      + '  </div>'
      + '</div>'
      + '</div>';
    this.$stage.innerHTML = html;
    var input = this.$stage.querySelector('.cf-pin-input');
    if (input) setTimeout(function () { try { input.focus(); } catch (err) {} }, 60);
  };

  /* presetKey：已记住的密钥自动登录（不弹密码框）；不传则读密码框 */
  CecpApp.prototype.enterOperator = function (presetKey) {
    var pin = presetKey || '';
    if (!pin) {
      var input = this.$stage.querySelector('.cf-pin-input');
      pin = input && input.value ? input.value.trim() : '';
      if (!pin) { this.showOpPin('请输入密码'); return; }
    }
    this.pendingOpPin = pin;
    this.pendingOp = true;
    this.role = 'operator';
    var err = this.$stage.querySelector('.cf-pin-error');
    if (err) { err.style.color = 'var(--muted)'; err.textContent = '验证中…'; }
    if (this.wsReady()) this.sendRegister();
    else this.connect();
  };

  CecpApp.prototype.onOpDenied = function (reason) {
    this.pendingOp = false;
    this.pendingOpPin = '';
    this.role = null;
    /* 记住的密钥失效（改过密钥 / 存的是错的）→ 清掉，回到手输 */
    this.opKey = '';
    lsDel(this.storeKey('opkey'));
    this.stopConnection(); // 密码错就别自动重连反复重试

    var text = '密码不对，再试一次';
    if (reason === 'not_configured') {
      text = '服务器还没设置音控密码，请管理员先运行 wrangler secret put OPERATOR_KEY';
    } else if (reason === 'key_required' || reason === 'pin_required') {
      text = '这个房间需要音控密码';
    }
    this.showOpPin(text);
  };

  CecpApp.prototype.backToMenu = function () {
    this.pendingOp = false;
    this.pendingOpPin = '';
    this.role = null;
    this.stopConnection();
    this.showMenu();
  };

  CecpApp.prototype.showSetup = function (errorText) {
    var self = this;
    var remembered = lsGet(this.storeKey('name'));
    this.setupSelected = this.presets.indexOf(getDeviceFromDisplayName(remembered)) >= 0
      ? getDeviceFromDisplayName(remembered) : '';
    /* 换设备/被踢后名字保留（单独存 person 键），只需重选设备 */
    this.setupPerson = getPersonFromDisplayName(remembered) || this.setupPerson || lsGet(this.storeKey('person')) || '';

    var html = '<div class="cf-app is-setup" style="display:flex;flex-direction:column;flex:1;min-height:0">'
      + '<div class="cf-head">'
      + '  <div class="cf-head-copy"><span class="cf-head-title">' + esc(this.appName) + '</span><span class="cf-head-sub">与音控台实时连线</span></div>'
      + '  <div class="cf-head-tools">' + this.statusHtml() + '</div>'
      + '</div>'
      + '<div class="cf-setup">'
      + (this.configMode === 'menu' ? '  <button class="cf-ghost-btn" type="button" data-action="back-menu" style="margin-bottom:10px">← 返回角色选择</button><br>' : '')
      + '  <span class="cf-setup-kicker">STEP 1 · 选择身份</span>'
      + '  <h2>你今天用哪个设备？</h2>'
      + '  <p class="cf-setup-sub">先点你的话筒或乐器，再填名字。音控台会看到「设备｜名字」。</p>'
      + '  <div class="cf-preset-grid">'
      + this.presets.map(function (preset) {
          return self.presetButtonHtml(preset);
        }).join('')
      + '  </div>'
      + '  <div class="cf-name-panel">'
      + '    <label class="cf-name-label">STEP 2 · 填写你的名字</label>'
      + '    <div class="cf-name-row">'
      + '      <span class="cf-name-device">请选择设备</span>'
      + '      <input class="cf-name-input" type="text" maxlength="18" autocomplete="name" placeholder="例如：小明 / David" data-enter="join" value="' + esc(this.setupPerson) + '">'
      + '    </div>'
      + '    <p class="cf-name-hint">音控端会看到：<strong class="cf-name-preview">请选择设备</strong></p>'
      + '  </div>'
      + '  <div class="cf-setup-error' + (errorText ? ' show' : '') + '">' + esc(errorText || '') + '</div>'
      + '  <button class="cf-btn-primary" type="button" data-action="join">进入成员端</button>'
      + '</div>'
      + '</div>';

    this.$stage.innerHTML = html;
    this.syncSetupPreview();
    this.syncSetupTaken();
  };

  /* 占用列表里存的是完整名「设备｜人名」，比对时只看设备段；自己占用的设备不算 */
  CecpApp.prototype.isDeviceTaken = function (preset) {
    var device = getDeviceFromDisplayName(preset);
    if (!device) return false;
    if (device === getDeviceFromDisplayName(this.whoAmI)) return false;
    return this.takenDevices.some(function (n) {
      return getDeviceFromDisplayName(n) === device;
    });
  };

  CecpApp.prototype.presetButtonHtml = function (preset) {
    var meta = identityMeta(preset);
    var isSel = preset === this.setupSelected;
    var isTaken = this.isDeviceTaken(preset);
    return '<button class="cf-preset tone-' + meta.tone + (isSel ? ' sel' : '') + (isTaken ? ' taken' : '') + '" type="button"'
      + ' data-action="pick-device" data-name="' + esc(preset) + '"' + (isTaken ? ' disabled aria-disabled="true"' : '') + '>'
      + '<span class="cf-preset-swatch">'
      + (meta.section === 'mic' ? MIC_SVG : '<span class="cf-preset-emoji">' + esc(meta.icon) + '</span>')
      + '</span>'
      + '<span class="cf-preset-name">' + esc(meta.title) + '</span>'
      + '<span class="cf-preset-sub">' + (isTaken ? '已有人使用' : (meta.type === 'mic' ? '无线话筒' : '乐器通道')) + '</span>'
      + '<span class="cf-preset-check" aria-hidden="true">✓</span>'
      + '</button>';
  };

  CecpApp.prototype.pickDevice = function (name) {
    if (!name) return;
    if (this.isDeviceTaken(name)) return;
    this.setupSelected = name;
    var buttons = this.$stage.querySelectorAll('.cf-preset');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('sel', buttons[i].dataset.name === name);
    }
    this.syncSetupPreview();
    var input = this.$stage.querySelector('.cf-name-input');
    if (input) setTimeout(function () { try { input.focus(); } catch (err) {} }, 60);
  };

  CecpApp.prototype.syncSetupPreview = function () {
    var panel = this.$stage.querySelector('.cf-name-panel');
    var deviceEl = this.$stage.querySelector('.cf-name-device');
    var preview = this.$stage.querySelector('.cf-name-preview');
    if (!panel) return;
    panel.classList.toggle('show', !!this.setupSelected);
    var base = this.setupSelected ? (stripIdentityPrefix(this.setupSelected) || this.setupSelected) : '请选择设备';
    if (deviceEl) deviceEl.textContent = base;
    if (preview) {
      preview.textContent = this.setupSelected
        ? base + '｜' + (this.setupPerson || '你的名字')
        : '请选择设备';
    }
  };

  CecpApp.prototype.syncSetupTaken = function () {
    var self = this;
    var buttons = this.$stage.querySelectorAll('.cf-preset');
    if (!buttons.length) return;
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      var name = button.dataset.name || '';
      var taken = this.isDeviceTaken(name);
      button.classList.toggle('taken', taken);
      button.disabled = taken;
      if (taken) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
      var sub = button.querySelector('.cf-preset-sub');
      if (sub) {
        var meta = identityMeta(name);
        sub.textContent = taken ? '已有人使用' : (meta.type === 'mic' ? '无线话筒' : '乐器通道');
      }
      var badge = button.querySelector('.cf-preset-taken-badge');
      if (taken && !badge) {
        badge = document.createElement('span');
        badge.className = 'cf-preset-taken-badge';
        badge.textContent = '占用中';
        button.appendChild(badge);
      } else if (!taken && badge) {
        badge.parentElement.removeChild(badge);
      }
    }
    void self;
  };

  CecpApp.prototype.setSetupError = function (text) {
    var el = this.$stage.querySelector('.cf-setup-error');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('show', !!text);
  };

  CecpApp.prototype.joinAsClient = function () {
    if (!this.setupSelected) {
      this.setSetupError('请先选择你的设备');
      return;
    }
    if (this.isDeviceTaken(this.setupSelected)) {
      this.setSetupError('「' + this.setupSelected + '」已有人在使用，请选择其他设备。');
      return;
    }
    var input = this.$stage.querySelector('.cf-name-input');
    this.setupPerson = String((input && input.value) || '').trim();
    if (!this.setupPerson) {
      this.setSetupError('请填写你的名字，方便音控知道是谁。');
      if (input) { try { input.focus(); } catch (err) {} }
      return;
    }

    this.whoAmI = buildDisplayName(this.setupSelected, this.setupPerson);
    lsSet(this.storeKey('name'), this.whoAmI);
    lsSet(this.storeKey('person'), this.setupPerson);
    this.pendingJoin = { name: this.whoAmI };
    this.role = 'client';
    this.loadHistory();
    this.showClient();

    if (this.wsReady()) this.sendRegister();
    else this.connect();
  };

  CecpApp.prototype.resetDevice = function () {
    /* 台上误触保护：在线状态下换设备需确认 */
    if (this.role === 'client' && this.online) {
      var ok = true;
      try { ok = window.confirm('要断开当前设备并重新选择吗？'); } catch (err) {}
      if (!ok) return;
    }
    lsDel(this.storeKey('name'));
    this.whoAmI = '';
    this.requests = [];
    this.pendingJoin = null;
    if (this.configMode === 'auto' || this.configMode === 'listener') {
      /* 退回被动 listener，同一连接重注册 */
      this.role = 'listener';
      if (this.wsReady()) this.sendRegister();
      else this.connect();
    } else {
      this.role = null;
      this.stopConnection();
    }
    this.showSetup();
  };

  /* ────────────────────────────────────────────
     敬拜端（client）
  ──────────────────────────────────────────── */

  CecpApp.prototype.showClient = function () {
    var self = this;
    this.activeTab = 'cues';

    var html = '<div class="cf-app is-client" style="display:flex;flex-direction:column;flex:1;min-height:0">'
      + '<div class="cf-client-head">'
      + identityPill(this.whoAmI, 'cf-me')
      + '<div class="cf-head-tools">'
      + this.statusHtml()
      + '<button class="cf-ghost-btn" type="button" data-action="reset-device">换设备</button>'
      + '</div>'
      + '</div>'
      + '<div class="cf-banner" role="status">'
      + '  <span class="cf-banner-icon">📢</span>'
      + '  <div class="cf-banner-body">'
      + '    <div class="cf-banner-head"></div>'
      + '    <div class="cf-banner-text"></div>'
      + '    <div class="cf-banner-time"></div>'
      + '  </div>'
      + '  <button class="cf-banner-read" type="button" data-action="read-broadcast">知道了</button>'
      + '</div>'
      + '<nav class="cf-tabs" role="tablist">'
      + '  <button class="cf-tab is-active" type="button" role="tab" aria-selected="true" data-action="tab" data-tab="cues">快捷信息</button>'
      + (this.enableChat
          ? '  <button class="cf-tab" type="button" role="tab" aria-selected="false" data-action="tab" data-tab="chat">聊天<span class="cf-tab-badge" hidden></span></button>'
          : '')
      + '</nav>'

      /* 快捷信息 pane */
      + '<div class="cf-pane cf-pane-cues is-active">'
      + '  <div class="cf-cues-scroll">'
      + '    <section class="cf-myreqs" hidden>'
      + '      <div class="cf-cue-group-label">我发出的请求</div>'
      + '      <div class="cf-myreq-list"></div>'
      + '    </section>'
      + this.cueGroups.map(function (group) {
          return '<section class="cf-cue-group">'
            + '<div class="cf-cue-group-label">' + esc(group.label) + '</div>'
            + '<div class="cf-cue-grid">'
            + group.cues.map(function (cue) {
                return '<button class="cf-cue' + (cue.priority === 'high' ? ' is-high' : '') + '" type="button" data-action="cue"'
                  + ' data-kind="' + esc(cue.kind) + '" data-label="' + esc(cue.label) + '"'
                  + ' data-icon="' + esc(cue.icon) + '" data-priority="' + esc(cue.priority) + '">'
                  + '<span class="cf-cue-icon">' + esc(cue.icon) + '</span>'
                  + '<span class="cf-cue-copy">'
                  + '  <span class="cf-cue-label">' + esc(cue.label) + '</span>'
                  + '  <span class="cf-cue-desc">' + esc(cue.desc) + '</span>'
                  + '</span>'
                  + '</button>';
              }).join('')
            + '</div>'
            + '</section>';
        }).join('')
      + '  </div>'
      + '  <div class="cf-compose">'
      + '    <input type="text" maxlength="120" placeholder="其它要发给音控的信息…" data-enter="send-custom">'
      + '    <button type="button" data-action="send-custom">发送</button>'
      + '  </div>'
      + '</div>'

      /* 聊天 pane */
      + (this.enableChat
          ? '<div class="cf-pane cf-pane-chat">'
            + '  <div class="cf-thread"></div>'
            + '  <div class="cf-compose">'
            + '    <input type="text" maxlength="200" placeholder="发给大家的群聊消息…" data-enter="send-chat">'
            + '    <button type="button" data-action="send-chat">发送</button>'
            + '  </div>'
            + '</div>'
          : '')
      + '</div>';

    this.$stage.innerHTML = html;
    this.renderRequests();
    this.renderChatPane();
    this.syncBanner();
    this.syncBadge();
    this.setStatus(this.online);
    void self;
  };

  CecpApp.prototype.switchTab = function (tab) {
    this.activeTab = tab;
    var tabs = this.$stage.querySelectorAll('.cf-tab');
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].dataset.tab === tab;
      tabs[i].classList.toggle('is-active', active);
      tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    var cues = this.$stage.querySelector('.cf-pane-cues');
    var chat = this.$stage.querySelector('.cf-pane-chat');
    if (cues) cues.classList.toggle('is-active', tab === 'cues');
    if (chat) chat.classList.toggle('is-active', tab === 'chat');
    if (tab === 'chat') {
      this.chatSeenTs = Date.now();
      this.scrollThread();
    }
    this.syncTabBadge();
    this.syncBadge();
  };

  CecpApp.prototype.syncTabBadge = function () {
    var badge = this.$stage.querySelector('.cf-tab-badge');
    if (!badge) return;
    var seen = this.chatSeenTs;
    var count = this.activeTab === 'chat' ? 0 : this.chat.reduce(function (acc, item) {
      if (item.mine) return acc;
      if (item.type === 'chat' && item.ts > seen) return acc + 1;
      if ((item.type === 'broadcast' || item.type === 'reply') && !item.read) return acc + 1;
      return acc;
    }, 0);
    badge.hidden = !count;
    badge.textContent = count > 99 ? '99+' : String(count || 0);
  };

  CecpApp.prototype.sendCue = function (el) {
    var kind = el.dataset.kind || 'custom';
    var label = el.dataset.label || '';
    var icon = el.dataset.icon || '💬';
    var priority = el.dataset.priority === 'high' ? 'high' : 'normal';
    if (!label) return;

    if (!this.wsReady()) {
      this.flash('当前离线，正在重连…', true);
      return;
    }

    var id = nowId('worship');
    this.wsSend({ type: 'worship_msg', id: id, kind: kind, text: label, priority: priority });
    this.requests.unshift({ id: id, kind: kind, icon: icon, label: label, priority: priority, ts: Date.now(), status: 'pending' });
    if (this.requests.length > 40) this.requests.pop();
    this.saveRequests();
    this.renderRequests();

    el.classList.remove('sent');
    void el.offsetWidth; /* 重新触发动画 */
    el.classList.add('sent');
    vibrate(priority === 'high' ? [25, 40, 25] : 15);
    this.flash(priority === 'high' ? '已加急发送 ✓' : '已发送 ✓');
  };

  CecpApp.prototype.sendCustom = function (el) {
    var wrap = el.closest('.cf-compose');
    var input = wrap ? wrap.querySelector('input') : null;
    var text = input && input.value ? input.value.trim() : '';
    if (!text) return;
    if (!this.wsReady()) {
      this.flash('当前离线，正在重连…', true);
      return;
    }
    var id = nowId('worship');
    this.wsSend({ type: 'worship_msg', id: id, kind: 'custom', text: text, priority: 'normal' });
    this.requests.unshift({ id: id, kind: 'custom', icon: '💬', label: text, priority: 'normal', ts: Date.now(), status: 'pending' });
    if (this.requests.length > 40) this.requests.pop();
    this.saveRequests();
    this.renderRequests();
    if (input) input.value = '';
    vibrate(15);
    this.flash('已发送 ✓');
  };

  CecpApp.prototype.sendChat = function (el) {
    var wrap = el.closest('.cf-compose');
    var input = wrap ? wrap.querySelector('input') : null;
    var text = input && input.value ? input.value.trim() : '';
    if (!text) return;
    if (!this.wsReady()) {
      this.flash('当前离线，正在重连…', true);
      return;
    }
    var id = nowId('member');
    this.wsSend({ type: 'member_chat', id: id, from: this.whoAmI, text: text });
    this.appendChat({ id: id, type: 'chat', from: this.whoAmI, text: text, ts: Date.now(), mine: true, read: true });
    if (input) input.value = '';
    vibrate(10);
  };

  CecpApp.prototype.appendChat = function (entry) {
    if (this.chat.some(function (item) { return item.id === entry.id; })) return;
    this.chat.push(entry);
    if (this.chat.length > 160) this.chat = this.chat.slice(-160);
    this.saveChat();
    this.renderChatPane();
    this.syncTabBadge();
  };

  CecpApp.prototype.renderRequests = function () {
    var section = this.$stage.querySelector('.cf-myreqs');
    var list = this.$stage.querySelector('.cf-myreq-list');
    if (!section || !list) return;
    var items = this.requests.slice(0, 5);
    section.hidden = !items.length;
    list.innerHTML = items.map(function (req) {
      var status = STATUS_LABEL[req.status] ? req.status : 'pending';
      return '<div class="cf-myreq' + (status === 'done' ? ' is-done' : '') + '">'
        + '<span class="cf-myreq-icon">' + esc(req.icon || '💬') + '</span>'
        + '<span class="cf-myreq-label">' + esc(req.label) + '</span>'
        + (req.priority === 'high' ? '<span class="cf-chip st-high">加急</span>' : '')
        + '<span class="cf-chip st-' + status + '">' + STATUS_LABEL[status] + '</span>'
        + '<span class="cf-myreq-time">' + esc(fmtTime(req.ts)) + '</span>'
        + '</div>';
    }).join('');
  };

  CecpApp.prototype.renderChatPane = function () {
    var thread = this.$stage.querySelector('.cf-thread');
    if (!thread) return;
    var self = this;
    if (!this.chat.length) {
      thread.innerHTML = '<div class="cf-empty">成员群聊、音控广播和回复会显示在这里</div>';
      return;
    }
    thread.innerHTML = this.chat.map(function (item) {
      if (item.type === 'broadcast' || item.type === 'reply') {
        var isReply = item.type === 'reply';
        return '<div class="cf-msg-card' + (isReply ? ' is-reply' : '') + (item.read ? '' : ' is-unread') + '">'
          + '<span class="cf-msg-card-icon">' + (isReply ? '🎧' : '📢') + '</span>'
          + '<div class="cf-msg-card-body">'
          + '<div class="cf-msg-card-head">' + (isReply ? '音控回复（只发给你）' : '音控组消息') + '</div>'
          + '<div class="cf-msg-card-text">' + esc(item.text) + '</div>'
          + '<div class="cf-msg-card-time">' + esc(fmtTime(item.ts)) + '</div>'
          + '</div>'
          + '</div>';
      }
      var mine = !!item.mine || item.from === self.whoAmI;
      return '<div class="cf-msg' + (mine ? ' mine' : '') + '">'
        + '<div class="cf-msg-head">'
        + (mine ? '' : identityPill(item.from))
        + '<span>' + esc(fmtTime(item.ts)) + '</span>'
        + '</div>'
        + '<div class="cf-msg-bubble">' + esc(item.text) + '</div>'
        + '</div>';
    }).join('');
    this.scrollThread();
  };

  CecpApp.prototype.scrollThread = function () {
    var thread = this.$stage.querySelector('.cf-thread');
    if (!thread) return;
    requestAnimationFrame(function () {
      thread.scrollTop = thread.scrollHeight;
    });
  };

  CecpApp.prototype.latestUnread = function () {
    for (var i = this.chat.length - 1; i >= 0; i--) {
      var item = this.chat[i];
      if ((item.type === 'broadcast' || item.type === 'reply') && !item.read) return item;
    }
    return null;
  };

  CecpApp.prototype.syncBanner = function () {
    var banner = this.$stage.querySelector('.cf-banner');
    if (!banner) return;
    var entry = this.latestUnread();
    if (!entry) {
      banner.classList.remove('show');
      return;
    }
    banner.classList.add('show');
    banner.querySelector('.cf-banner-head').textContent = entry.type === 'reply' ? '🎧 音控回复（只发给你）' : '📢 音控组消息';
    banner.querySelector('.cf-banner-text').textContent = entry.text;
    banner.querySelector('.cf-banner-time').textContent = fmtTime(entry.ts);
    banner.querySelector('.cf-banner-read').setAttribute('data-id', entry.id);
  };

  CecpApp.prototype.markRead = function (id) {
    var changed = false;
    this.chat.forEach(function (item) {
      if ((id ? item.id === id : true) && (item.type === 'broadcast' || item.type === 'reply') && !item.read) {
        item.read = true;
        changed = true;
      }
    });
    if (!changed) return;
    this.saveChat();
    this.renderChatPane();
    this.syncBanner();
    this.syncTabBadge();
    this.syncBadge();
  };

  /* ────────────────────────────────────────────
     音控台（operator）— Phase 1 基础版
  ──────────────────────────────────────────── */

  CecpApp.prototype.showOperator = function () {
    var html = '<div class="cf-app is-operator cf-op">'
      + '<div class="cf-head">'
      + '  <div class="cf-head-copy"><span class="cf-head-title">' + esc(this.appName) + ' 音控台</span><span class="cf-head-sub">' + esc(this.room) + ' 房间 · 请求与群聊实时汇总</span></div>'
      + '  <div class="cf-head-tools">'
      + '    <span class="cf-clock">🕒 <span data-clock>--:--:--</span></span>'
      + (this.isFloating ? '' : '    <button class="cf-ghost-btn" type="button" data-action="fullscreen">进入全屏</button>')
      + this.statusHtml()
      + '  </div>'
      + '</div>'
      + '<div class="cf-op-stats">'
      + '  <div class="cf-stat"><div class="cf-stat-label">在线设备</div><div class="cf-stat-value" data-stat="members">0</div></div>'
      + '  <div class="cf-stat"><div class="cf-stat-label">未处理请求</div><div class="cf-stat-value" data-stat="pending">0</div></div>'
      + '  <div class="cf-stat is-alert"><div class="cf-stat-label">高优先级</div><div class="cf-stat-value" data-stat="high">0</div></div>'
      + '</div>'
      + '<div class="cf-op-grid">'
      + '  <div class="cf-op-panel p-members">'
      + '    <div class="cf-op-panel-head"><span class="cf-op-panel-title" data-member-title>在线设备</span>'
      + '      <button class="cf-ghost-btn" type="button" data-action="kick-all">踢出全员</button></div>'
      + '    <div class="cf-op-scroll cf-member-list"><div class="cf-empty">当前没有设备在线</div></div>'
      + '  </div>'
      + '  <div class="cf-op-panel p-board">'
      + '    <div class="cf-op-panel-head">'
      + '      <span class="cf-op-panel-title">舞台请求看板</span>'
      + '      <span class="cf-op-head-tools">'
      + '        <button class="cf-icon-btn' + (this.alertMuted ? ' is-on' : '') + '" type="button" data-action="op-mute" title="高优先级警报声音/震动开关">' + (this.alertMuted ? '🔕' : '🔔') + '</button>'
      + '        <button class="cf-ghost-btn" type="button" data-action="op-toggle-done">已解决 0</button>'
      + '        <button class="cf-ghost-btn" type="button" data-action="clear-feed">清空</button>'
      + '      </span>'
      + '    </div>'
      + '    <div class="cf-op-tabs">'
      + '      <button class="cf-op-tab is-active" type="button" data-action="op-tab" data-tab="board">请求看板<span class="cf-op-tab-badge" data-board-badge hidden></span></button>'
      + '      <button class="cf-op-tab" type="button" data-action="op-tab" data-tab="chat">群聊<span class="cf-op-tab-badge" data-chat-badge hidden></span></button>'
      + '    </div>'
      + '    <div class="cf-op-scroll cf-board"><div class="cf-empty">成员的舞台请求会按声部显示在这里</div></div>'
      + '    <div class="cf-op-scroll cf-op-chat" style="display:none"><div class="cf-empty">成员群聊会显示在这里</div></div>'
      + '  </div>'
      + '  <div class="cf-op-panel p-bcast">'
      + '    <div class="cf-op-panel-head"><span class="cf-op-panel-title">📢 广播通知</span></div>'
      + '    <div class="cf-target-row" data-target-row></div>'
      + '    <div class="cf-compose" style="border-top:none">'
      + '      <input type="text" maxlength="120" placeholder="输入广播消息…" data-enter="bcast-send">'
      + '      <button type="button" data-action="bcast-send">发送</button>'
      + '    </div>'
      + '    <div class="cf-bcast-presets">'
      + this.bcastPresets.map(function (text) {
          return '<button class="cf-bcast-preset" type="button" data-action="bcast-preset" data-text="' + esc(text) + '">' + esc(text) + '</button>';
        }).join('')
      + '    </div>'
      + '    <div class="cf-op-scroll cf-bcast-log"><div class="cf-empty">广播记录会显示在这里</div></div>'
      + '  </div>'
      + '</div>'
      + '</div>';

    this.$stage.innerHTML = html;
    this.renderMembers();
    this.renderOpBoard();
    this.renderOpChat();
    this.renderBcastTargets();
    this.renderOpBcastLog();
    this.updateOpStats();
    this.setStatus(this.online);
    this.startClock();
  };

  CecpApp.prototype.startClock = function () {
    var self = this;
    if (this.clockTimer) return;
    var tick = function () {
      var el = self.$stage.querySelector('[data-clock]');
      if (el) el.textContent = fmtClock();
    };
    tick();
    this.clockTimer = setInterval(tick, 1000);
  };

  CecpApp.prototype.renderMembers = function () {
    var list = this.$stage.querySelector('.cf-member-list');
    var title = this.$stage.querySelector('[data-member-title]');
    if (!list) return;
    if (title) title.textContent = '在线设备（' + this.members.length + '）';
    if (!this.members.length) {
      list.innerHTML = '<div class="cf-empty">当前没有设备在线</div>';
      return;
    }
    list.innerHTML = this.members.map(function (member) {
      return '<div class="cf-member">'
        + identityPill(member.name)
        + '<button class="cf-kick" type="button" data-action="kick" data-name="' + esc(member.name) + '">踢出</button>'
        + '</div>';
    }).join('');
    this.renderBcastTargets();
  };

  /* ── (c) 分组看板 ── */

  var SECTION_ORDER = ['mic', 'keys', 'guitar', 'bass', 'drum', 'other'];
  var SECTION_ICON = { mic: '🎤', keys: '🎹', guitar: '🎸', bass: '🎸', drum: '🥁', other: '📋' };
  var REPLY_PRESETS = ['好了', '稍等一下', '正在调', '换个位置试试', '已收到'];

  CecpApp.prototype.reqItemHtml = function (req) {
    var st = STATUS_LABEL[req.status] ? req.status : 'pending';
    var isHigh = req.priority === 'high' && st !== 'done';
    var html = '<div class="cf-req' + (isHigh ? ' is-high' : '') + ' st-' + st + '" data-req-id="' + esc(req.id) + '">'
      + '<div class="cf-req-meta">'
      + identityPill(req.from)
      + (req.priority === 'high' ? '<span class="cf-chip st-high">加急</span>' : '')
      + '<span class="cf-req-time">' + esc(fmtTime(req.ts)) + '</span>'
      + '</div>'
      + '<div class="cf-req-text">' + esc(req.text) + '</div>'
      + '<div class="cf-req-actions">'
      + '<span class="cf-seg">'
      + ['pending', 'doing', 'done'].map(function (s) {
          return '<button type="button" class="sg-' + s + (st === s ? ' on' : '') + '" data-action="op-status"'
            + ' data-id="' + esc(req.id) + '" data-status="' + s + '">' + STATUS_LABEL[s] + '</button>';
        }).join('')
      + '</span>'
      + '<button class="cf-reply-btn" type="button" data-action="op-reply-toggle" data-id="' + esc(req.id) + '">回复</button>'
      + '</div>';
    if (this.opReplyOpenId === req.id) {
      html += '<div class="cf-reply-row">'
        + '<div class="cf-reply-presets">'
        + REPLY_PRESETS.map(function (text) {
            return '<button type="button" data-action="op-reply-preset" data-id="' + esc(req.id) + '" data-text="' + esc(text) + '">' + esc(text) + '</button>';
          }).join('')
        + '</div>'
        + '<div class="cf-reply-input-row">'
        + '<input type="text" maxlength="120" placeholder="回复只发给 ' + esc(identityMeta(req.from).title) + '…" data-enter="op-reply-send" data-id="' + esc(req.id) + '">'
        + '<button type="button" data-action="op-reply-send" data-id="' + esc(req.id) + '">发送</button>'
        + '</div>'
        + '</div>';
    }
    if (req.replied) {
      html += '<div class="cf-replied">↩️ 已回复：' + esc(req.replied) + '</div>';
    }
    return html + '</div>';
  };

  CecpApp.prototype.renderOpBoard = function () {
    var self = this;
    var board = this.$stage.querySelector('.cf-board');
    if (!board) return;

    var doneCount = this.opReqs.filter(function (r) { return r.status === 'done'; }).length;
    var toggleBtn = this.$stage.querySelector('[data-action="op-toggle-done"]');
    if (toggleBtn) toggleBtn.textContent = (this.opShowDone ? '收起已解决 ' : '已解决 ') + doneCount;

    var visible = this.opReqs.filter(function (r) { return self.opShowDone || r.status !== 'done'; });

    if (!visible.length) {
      board.innerHTML = '<div class="cf-empty">' + (this.opReqs.length ? '没有未处理的请求 🎉' : '成员的舞台请求会按声部显示在这里') + '</div>';
    } else {
      /* 高优先级未解决：全局置顶；其余按声部分组，各组内未解决在前、新的在前 */
      var highs = visible.filter(function (r) { return r.priority === 'high' && r.status !== 'done'; });
      var rest = visible.filter(function (r) { return !(r.priority === 'high' && r.status !== 'done'); });
      rest.sort(function (a, b) {
        return ((a.status === 'done') - (b.status === 'done')) || (b.ts - a.ts);
      });

      var html = '';
      if (highs.length) {
        html += '<div class="cf-sec"><div class="cf-high-strip-label">🚨 高优先级（' + highs.length + '）</div>'
          + highs.map(function (r) { return self.reqItemHtml(r); }).join('') + '</div>';
      }
      SECTION_ORDER.forEach(function (sec) {
        var list = rest.filter(function (r) { return identityMeta(r.from).section === sec; });
        if (!list.length) return;
        var open = list.filter(function (r) { return r.status !== 'done'; }).length;
        html += '<div class="cf-sec">'
          + '<div class="cf-sec-head">' + SECTION_ICON[sec] + ' ' + SECTION_LABEL[sec]
          + '<span class="cf-sec-badge' + (open ? '' : ' is-zero') + '">' + open + '</span></div>'
          + list.map(function (r) { return self.reqItemHtml(r); }).join('')
          + '</div>';
      });
      board.innerHTML = html;
    }

    /* (d) 高优警报：面板边框持续闪烁，直到全部标记已解决 */
    var hasAlarm = this.opReqs.some(function (r) { return r.priority === 'high' && r.status !== 'done'; });
    var panel = this.$stage.querySelector('.p-board');
    if (panel) panel.classList.toggle('has-alarm', hasAlarm);
    /* 高优未解决：悬浮球红色警示动效 */
    if (this.$launcher) this.$launcher.classList.toggle('is-alert', hasAlarm);
    var boardBadge = this.$stage.querySelector('[data-board-badge]');
    if (boardBadge) {
      var openCount = this.opReqs.filter(function (r) { return r.status !== 'done'; }).length;
      boardBadge.hidden = !openCount;
      boardBadge.textContent = String(openCount);
    }
  };

  CecpApp.prototype.renderOpChat = function () {
    var log = this.$stage.querySelector('.cf-op-chat');
    if (!log) return;
    if (!this.opChat.length) {
      log.innerHTML = '<div class="cf-empty">成员群聊、你发的广播和定向回复都会显示在这里</div>';
    } else {
      log.innerHTML = this.opChat.map(function (item) {
        if (item.kind === 'broadcast') {
          return '<div class="cf-feed-item is-out">'
            + '<span class="cf-feed-icon">📢</span>'
            + '<div class="cf-feed-body">'
            + '<div class="cf-feed-meta"><span class="cf-feed-kindchip k-bcast">广播'
            + (item.scope ? ' · ' + esc(item.scope) : ' · 全体') + '</span></div>'
            + '<div class="cf-feed-text">' + esc(item.text) + '</div>'
            + '</div>'
            + '<span class="cf-feed-time">' + esc(fmtTime(item.ts)) + '</span>'
            + '</div>';
        }
        if (item.kind === 'reply') {
          return '<div class="cf-feed-item is-out">'
            + '<span class="cf-feed-icon">↩️</span>'
            + '<div class="cf-feed-body">'
            + '<div class="cf-feed-meta"><span class="cf-feed-kindchip k-reply">回复 ' + esc(identityMeta(item.to).title) + '</span></div>'
            + '<div class="cf-feed-text">' + esc(item.text) + '</div>'
            + '</div>'
            + '<span class="cf-feed-time">' + esc(fmtTime(item.ts)) + '</span>'
            + '</div>';
        }
        return '<div class="cf-feed-item">'
          + '<span class="cf-feed-icon">🗨️</span>'
          + '<div class="cf-feed-body">'
          + '<div class="cf-feed-meta">' + identityPill(item.from) + '</div>'
          + '<div class="cf-feed-text">' + esc(item.text) + '</div>'
          + '</div>'
          + '<span class="cf-feed-time">' + esc(fmtTime(item.ts)) + '</span>'
          + '</div>';
      }).join('');
    }
    var badge = this.$stage.querySelector('[data-chat-badge]');
    if (badge) {
      badge.hidden = !this.opChatUnread;
      badge.textContent = String(this.opChatUnread);
    }
  };

  CecpApp.prototype.opChatPush = function (entry) {
    this.opChat.unshift(entry);
    if (this.opChat.length > 200) this.opChat.pop();
    this.renderOpChat();
  };

  CecpApp.prototype.opSwitchTab = function (tab) {
    this.opTab = tab === 'chat' ? 'chat' : 'board';
    var tabs = this.$stage.querySelectorAll('.cf-op-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('is-active', tabs[i].dataset.tab === this.opTab);
    var board = this.$stage.querySelector('.cf-board');
    var chat = this.$stage.querySelector('.cf-op-chat');
    if (board) board.style.display = this.opTab === 'board' ? '' : 'none';
    if (chat) chat.style.display = this.opTab === 'chat' ? '' : 'none';
    if (this.opTab === 'chat') {
      this.opChatUnread = 0;
      this.renderOpChat();
    }
  };

  /* ── (a) 状态机 ── */

  CecpApp.prototype.opSetStatus = function (id, status) {
    if (!id || ['pending', 'doing', 'done'].indexOf(status) < 0) return;
    if (!this.wsReady()) {
      this.flash('当前离线，无法标记', true);
      return;
    }
    this.wsSend({ type: 'msg_status', id: id, status: status });
    /* 本地立即更新（服务端回显幂等） */
    this.opReqs.forEach(function (r) { if (r.id === id) r.status = status; });
    this.renderOpBoard();
    this.updateOpStats();
  };

  /* ── (b) 定向回复 ── */

  CecpApp.prototype.opReplyToggle = function (id) {
    this.opReplyOpenId = this.opReplyOpenId === id ? '' : id;
    this.renderOpBoard();
    if (this.opReplyOpenId) {
      var input = this.$stage.querySelector('.cf-reply-input-row input');
      if (input) setTimeout(function () { try { input.focus(); } catch (err) {} }, 50);
    }
  };

  CecpApp.prototype.opReplySend = function (id, presetText) {
    var req = null;
    for (var i = 0; i < this.opReqs.length; i++) {
      if (this.opReqs[i].id === id) { req = this.opReqs[i]; break; }
    }
    if (!req) return;
    var text = presetText;
    if (!text) {
      var row = this.$stage.querySelector('.cf-req[data-req-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      var input = row ? row.querySelector('.cf-reply-input-row input') : this.$stage.querySelector('.cf-reply-input-row input');
      text = input && input.value ? input.value.trim() : '';
    }
    if (!text) return;
    if (!this.wsReady()) {
      this.flash('当前离线，无法回复', true);
      return;
    }
    this.wsSend({ type: 'operator_reply', to: req.from, id: req.id, text: text });
    req.replied = text;
    this.opReplyOpenId = '';
    this.renderOpBoard();
    this.opChatPush({ kind: 'reply', id: nowId('opreply'), to: req.from, text: text, ts: Date.now() });
    this.flash('已回复 ' + identityMeta(req.from).title + ' ✓');
  };

  /* ── (d) 高优警报：声音 + 震动，可静音 ── */

  CecpApp.prototype.opToggleMute = function () {
    this.alertMuted = !this.alertMuted;
    lsSet(this.storeKey('opmute'), this.alertMuted ? '1' : '0');
    var btn = this.$stage.querySelector('[data-action="op-mute"]');
    if (btn) {
      btn.textContent = this.alertMuted ? '🔕' : '🔔';
      btn.classList.toggle('is-on', this.alertMuted);
    }
    this.flash(this.alertMuted ? '警报已静音' : '警报已开启 ✓');
  };

  CecpApp.prototype.playAlert = function () {
    if (this.alertMuted) return;
    vibrate([80, 60, 80]);
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var t = ctx.currentTime;
      [0, 0.22].forEach(function (off) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t + off);
        gain.gain.exponentialRampToValueAtTime(0.2, t + off + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t + off);
        osc.stop(t + off + 0.2);
      });
    } catch (err) {}
  };

  /* ── 广播定向 ── */

  CecpApp.prototype.renderBcastTargets = function () {
    var row = this.$stage.querySelector('[data-target-row]');
    if (!row) return;
    var self = this;
    /* 清理已下线的勾选 */
    var online = this.members.map(function (m) { return m.name; });
    this.bcastTargets = this.bcastTargets.filter(function (n) { return online.indexOf(n) >= 0; });

    var allOn = !this.bcastTargets.length;
    row.innerHTML = '<button class="cf-target-chip' + (allOn ? ' is-on' : '') + '" type="button" data-action="bcast-target-all">全体（含旁听）</button>'
      + this.members.map(function (m) {
          var on = self.bcastTargets.indexOf(m.name) >= 0;
          return '<button class="cf-target-chip' + (on ? ' is-on' : '') + '" type="button" data-action="bcast-target" data-name="' + esc(m.name) + '">'
            + esc(identityMeta(m.name).title) + '</button>';
        }).join('');
  };

  CecpApp.prototype.bcastTargetToggle = function (name) {
    if (!name) {
      this.bcastTargets = [];
    } else {
      var idx = this.bcastTargets.indexOf(name);
      if (idx >= 0) this.bcastTargets.splice(idx, 1);
      else this.bcastTargets.push(name);
    }
    this.renderBcastTargets();
  };

  CecpApp.prototype.renderOpBcastLog = function () {
    var log = this.$stage.querySelector('.cf-bcast-log');
    if (!log) return;
    if (!this.opBcasts.length) {
      log.innerHTML = '<div class="cf-empty">广播记录会显示在这里</div>';
      return;
    }
    log.innerHTML = this.opBcasts.map(function (item) {
      return '<div class="cf-bcast-log-item"><span>' + esc(item.text)
        + (item.scope ? '<br><small style="color:var(--muted);font-weight:400">' + esc(item.scope) + '</small>' : '')
        + '</span>'
        + '<span class="cf-bcast-log-time">' + esc(fmtTime(item.ts)) + '</span></div>';
    }).join('');
  };

  CecpApp.prototype.updateOpStats = function () {
    var stats = {
      members: this.members.length,
      pending: this.opReqs.filter(function (r) { return r.status !== 'done'; }).length,
      high: this.opReqs.filter(function (r) { return r.priority === 'high' && r.status !== 'done'; }).length
    };
    var els = this.$stage.querySelectorAll('[data-stat]');
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-stat');
      els[i].textContent = String(stats[key] != null ? stats[key] : 0);
    }
  };

  CecpApp.prototype.opSendBroadcast = function (presetText) {
    var input = this.$stage.querySelector('.p-bcast .cf-compose input');
    var text = presetText || (input && input.value ? input.value.trim() : '');
    if (!text) return;
    if (!this.wsReady()) {
      this.flash('当前离线，无法广播', true);
      return;
    }
    var targets = this.bcastTargets.slice();
    this.wsSend({
      type: 'broadcast',
      id: nowId('broadcast'),
      text: text,
      target: targets.length ? { names: targets } : 'all'
    });
    var scope = targets.length
      ? '→ ' + targets.map(function (n) { return identityMeta(n).title; }).join('、')
      : '';
    this.opBcasts.unshift({ text: text, scope: scope, ts: Date.now() });
    if (this.opBcasts.length > 40) this.opBcasts.pop();
    this.renderOpBcastLog();
    this.opChatPush({ kind: 'broadcast', id: nowId('opbcast'), text: text, scope: scope.replace(/^→ /, ''), ts: Date.now() });
    if (input && !presetText) input.value = '';
    this.flash(targets.length ? '已定向广播（' + targets.length + '人）✓' : '已广播全体 ✓');
  };

  CecpApp.prototype.opKick = function (name) {
    if (!name) return;
    if (!this.wsReady()) {
      this.flash('当前离线，无法踢出', true);
      return;
    }
    this.wsSend({ type: 'kick', name: name });
    this.flash('已踢出 ' + name + ' ✓');
  };

  CecpApp.prototype.opKickAll = function () {
    if (!this.wsReady()) {
      this.flash('当前离线，无法踢出', true);
      return;
    }
    var ok = true;
    try { ok = window.confirm('确定要踢出全部在线成员吗？'); } catch (err) {}
    if (!ok) return;
    this.wsSend({ type: 'kick_all' });
    this.flash('已踢出全员 ✓');
  };

  CecpApp.prototype.toggleFullscreen = function () {
    var btn = this.$stage.querySelector('[data-action="fullscreen"]');
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      if (btn) btn.textContent = '进入全屏';
      return;
    }
    if (this.host.requestFullscreen) {
      this.host.requestFullscreen();
      if (btn) btn.textContent = '退出全屏';
    }
  };

  /* ── 销毁 ── */

  CecpApp.prototype.destroy = function () {
    this.destroyed = true;
    this.stopConnection();
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    clearTimeout(this.midnightTimer);
    clearTimeout(this.flashTimer);
    if (this.docKeyHandler) {
      document.removeEventListener('keydown', this.docKeyHandler);
      this.docKeyHandler = null;
    }
    if (this.viewportHandler) {
      window.removeEventListener('resize', this.viewportHandler);
      window.removeEventListener('orientationchange', this.viewportHandler);
      try { if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.viewportHandler); } catch (err) {}
      try {
        if (this.orientMedia && this.orientMedia.removeEventListener) this.orientMedia.removeEventListener('change', this.viewportHandler);
        else if (this.orientMedia && this.orientMedia.removeListener) this.orientMedia.removeListener(this.viewportHandler);
      } catch (err) {}
      this.orientMedia = null;
      this.viewportHandler = null;
    }
    if (this.dockObserver) {
      try { this.dockObserver.disconnect(); } catch (err) {}
      this.dockObserver = null;
    }
    clearTimeout(this.dockLateTimer);
    if (this.themeObserver) {
      try { this.themeObserver.disconnect(); } catch (err) {}
      this.themeObserver = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (err) {}
      this.audioCtx = null;
    }
    if (this.themeMedia && this.themeMediaHandler) {
      try {
        if (this.themeMedia.removeEventListener) this.themeMedia.removeEventListener('change', this.themeMediaHandler);
        else if (this.themeMedia.removeListener) this.themeMedia.removeListener(this.themeMediaHandler);
      } catch (err) {}
      this.themeMedia = null;
      this.themeMediaHandler = null;
    }
    if (this.shadow) this.shadow.innerHTML = '';
    if (this.portal && this.portal.parentNode) {
      this.portal.parentNode.removeChild(this.portal);
      this.portal = null;
    }
    if (this._prevHtmlOverflow !== undefined) {
      document.documentElement.style.overflow = this._prevHtmlOverflow;
      if (document.body) document.body.style.overflow = this._prevBodyOverflow;
      this._prevHtmlOverflow = undefined;
    }
    this.host.__cecpApp = null;
  };

  CecpApp.prototype.getApi = function () {
    var self = this;
    return {
      open: function () { self.openWidget(); },
      close: function () { self.closeWidget(); },
      destroy: function () { self.destroy(); }
    };
  };

  /* ────────────────────────────────────────────
     挂载：自定义元素 + 旧 div 兼容
  ──────────────────────────────────────────── */

  function mountOn(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.__cecpApp) return el.__cecpApp.getApi();
    el.__cecpApp = new CecpApp(el);
    return el.__cecpApp.getApi();
  }

  if (window.customElements && !customElements.get('cecp-intercom')) {
    var CecpIntercomElement = function () {
      return Reflect.construct(HTMLElement, [], CecpIntercomElement);
    };
    CecpIntercomElement.prototype = Object.create(HTMLElement.prototype);
    CecpIntercomElement.prototype.constructor = CecpIntercomElement;
    Object.setPrototypeOf(CecpIntercomElement, HTMLElement);

    CecpIntercomElement.prototype.connectedCallback = function () {
      var el = this;
      if (el.__cecpApp) return;
      /* 等一拍：HTML 流式解析时属性已就绪，但脚本动态创建的元素可能随后才 setAttribute */
      queueMicrotask(function () {
        if (el.isConnected && !el.__cecpApp) mountOn(el);
      });
    };

    CecpIntercomElement.prototype.disconnectedCallback = function () {
      var el = this;
      setTimeout(function () {
        /* 仅在真正离开文档时销毁（避免 DOM 移动误销毁） */
        if (!el.isConnected && el.__cecpApp) {
          el.__cecpApp.destroy();
        }
      }, 0);
    };

    customElements.define('cecp-intercom', CecpIntercomElement);
  }

  function mountLegacy(root) {
    var el = root;
    if (typeof root === 'string') el = document.querySelector(root);
    if (!el) {
      el = document.getElementById('cecp-root') || document.querySelector('[data-cecp-root]');
    }
    if (!el || el.nodeType !== 1) return null;
    if (String(el.tagName).toLowerCase() === 'cecp-intercom') return mountOn(el);
    return mountOn(el);
  }

  window.CECPIntercom = window.CECPIntercom || {};
  window.CECPIntercom.version = '2.0.0';
  window.CECPIntercom.mount = mountLegacy;

  function autoBoot() {
    var legacy = document.getElementById('cecp-root') || document.querySelector('[data-cecp-root]');
    if (legacy && !legacy.__cecpApp && String(legacy.tagName).toLowerCase() !== 'cecp-intercom') {
      mountOn(legacy);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBoot);
  } else {
    autoBoot();
  }
})();
