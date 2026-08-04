// ============================================================
//  Lamezia Worship Team Intercom — Cloudflare Worker
//  Durable Object: WorshipRoom
//
//  Frontend:
//    data-ws-url="wss://你的-worker域名"
//    data-mode="client" | "operator" | "listener" | "auto" | "menu"
//    data-room="lamezia"（可选，房间名 → ?room=xxx）
//
//  Routes:
//    GET /            -> health check page
//    GET /health      -> json health check
//    WebSocket ?room= -> Durable Object room（缺省 lamezia）
//
//  音控鉴权（必配）：
//    wrangler secret put OPERATOR_KEY
//    role:"operator" 的 register 必须带 key。两条路径：
//      1) register.key（前端默认走这条）→ 失败：op_denied + close 4001
//      2) 握手 ?key=（存书签用）        → 失败：HTTP 401，握手根本不建立
//    密钥未配置 → 一律拒绝（fail closed），不存在「没配就放行」。
//
//  v2 协议新增（全部向后兼容，旧客户端安全忽略）：
//    register.role 支持 'listener'（只收广播，不占设备名）
//    worship_msg.priority: 'normal' | 'high'
//    msg_status: operator → 全体 operator + client（按 id 前端自行匹配）
//    operator_reply: operator → 指定 name 的 client
//    broadcast.target: 'all'（含 listener）| {names:[...]}（定向 client）
// ============================================================

const DAILY_RESET_STAMP_KEY = 'daily_reset_stamp';
const DEFAULT_DAILY_RESET_TZ = 'Europe/Rome';

// 音控鉴权：operator 角色必须出示 OPERATOR_KEY（`wrangler secret put OPERATOR_KEY`）。
// 密钥没配置时一律拒绝（fail closed）——旧版在未配置时放行，等于任何人手工发一条
// role:"operator" 的 register 就能拿到广播 / 踢人 / 改状态的全部权限。
const OP_DENY_CLOSE_CODE = 4001;
const OP_DENY_DELAY_MAX_MS = 2000;
const OP_DENY_DELAY_STEP_MS = 250;

// 消息历史：音控台可能晚于成员上线，需把当天的舞台请求 / 群聊暂存，
// operator 一注册就回放。持久化到 DO storage 以扛住 WebSocket 休眠回收。
const HISTORY_KEY = 'msg_history_v1';
const HISTORY_MAX = 120;

// 共享歌单：现场随手改歌，改完广播给全房间，并持久化以扛住 DO 休眠。
const SETLIST_KEY = 'setlist_v1';
const SETLIST_MAX = 30;

// 同步标注（墨迹）：按歌分组存在一个 key 里，必须自己控总量。
// SQLite-backed DO 的「键+值」上限是 2MB，而单笔最坏 600 点 ≈ 9.7KB，
// 光一首歌 400 笔就约 3.9MB —— 所以除了每首笔数上限，还要有歌曲数量上限
// 和总字节预算，否则 put 会抛异常，而那时 _broadcast 已经不会执行（静默失效）。
const INK_KEY = 'ink_v1';
const INK_MAX_PER_SONG = 400;   // 每首歌最多存这么多笔，超了丢最早的
const INK_MAX_PTS = 600;        // 单笔最多点数，防止有人画一条巨长的线撑爆存储
const INK_MAX_SONGS = 40;       // 最多保留这么多首歌的标注，超了丢最旧的
const INK_MAX_BYTES = 1500000;  // 总字节预算，留足余量顶住 2MB 硬上限

export class WorshipRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.resetTimeZone = String((env && env.DAILY_RESET_TZ) || DEFAULT_DAILY_RESET_TZ).trim() || DEFAULT_DAILY_RESET_TZ;
    this._history = null; // 懒加载缓存
    this._opFailures = 0; // 连续音控鉴权失败次数（内存态，用于递增延迟）
    this._setlist = undefined; // undefined = 还没读过；null = 读过但没有
    this._ink = undefined;     // 同上：标注按歌分组 { songId: [stroke,...] }
  }

  async fetch(request) {
    await this._ensureDailyResetAlarm();

    const upgrade = request.headers.get('Upgrade');

    if (upgrade !== 'websocket') {
      return json({
        ok: true,
        service: 'Lamezia Worship Team Intercom Room',
        websocket: false,
        message: 'Expected WebSocket upgrade request.',
        time: new Date().toISOString(),
      }, 426);
    }

    // 握手带 ?key= 时先校验一次：正确就把这条连接标记为已授权（register 时不用再出示）。
    // 前端默认走 register 里的 key 字段（查询串会进 Cloudflare 日志 / 中间代理，消息体不会），
    // 这条路径留给「音控台电脑存书签」这类场景。
    //
    // 错误的 key 直接用 HTTP 401 拒掉握手，压根不建立 WebSocket：
    // 试过「先 accept 再 close(4001)」，workerd 里在 fetch 上下文中 close() 会静默失效
    // （返回正常、readyState=2，但 close frame 永远到不了客户端），客户端只会干等。
    // 401 还顺带省掉给坏 key 分配连接的开销。注意：浏览器这时只能看到 error/1006，
    // 拿不到 4001 —— 所以前端不用这条路径，走 register 那条（那里的 4001 是好的）。
    const handshakeKey = new URL(request.url).searchParams.get('key');
    let handshakeAuthed = false;

    if (handshakeKey != null) {
      const verdict = this._checkOperatorKey(handshakeKey);
      if (!verdict.ok) {
        await this._penalizeOpFailure();
        return json({ ok: false, error: 'operator_key_rejected', reason: verdict.reason }, 401);
      }
      handshakeAuthed = true;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    if (handshakeAuthed) this._setMeta(server, { opAuth: true });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: corsHeaders(),
    });
  }

  // ── Incoming messages ──────────────────────────────────────
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      safeSend(ws, {
        type: 'error',
        code: 'bad_json',
        message: '消息格式错误',
        ts: Date.now(),
      });
      return;
    }

    const type = String(msg.type || '').trim();

    switch (type) {
      case 'register': {
        const regName = cleanName(msg.name);
        const regRole = cleanRole(msg.role);

        // listener：被动只收广播，不占设备名、不进 member_list / taken_devices，
        // 允许匿名。用户选身份后会在同一连接上重新 register 成 client。
        if (regRole === 'listener') {
          this._setMeta(ws, {
            name: regName || 'listener',
            role: 'listener',
            identityType: 'listener',
            ts: Date.now(),
          });
          safeSend(ws, {
            type: 'ack',
            name: regName || 'listener',
            role: 'listener',
            ts: Date.now(),
          });
          // 补发占用列表：listener 升级为 client 前的选设备界面需要置灰已占设备
          safeSend(ws, {
            type: 'taken_devices',
            names: this._takenNames(),
            ts: Date.now(),
          });
          break;
        }

        // 音控密码闸（fail closed）：operator 必须出示 OPERATOR_KEY，要么握手时 ?key=
        // 已经验过（opAuth），要么这条 register 里带 key。密钥未配置 = 全部拒绝，
        // 绝不放行——这是唯一挡住「手工发 role:"operator" 抢权限」的地方。
        // 失败一律 4001 断开，逼迫攻击者每试一次都要重新握手。
        if (regRole === 'operator') {
          if (safeMeta(ws)?.opAuth !== true) {
            const verdict = this._checkOperatorKey(msg.key != null ? msg.key : msg.pin);
            if (!verdict.ok) {
              safeSend(ws, {
                type: 'op_denied',
                reason: verdict.reason,
                ts: Date.now(),
              });
              await this._penalizeOpFailure();
              try { ws.close(OP_DENY_CLOSE_CODE, verdict.reason); } catch {}
              break;
            }
            this._setMeta(ws, { opAuth: true });
          }
          this._opFailures = 0;
        }

        if (!regName) {
          safeSend(ws, {
            type: 'error',
            code: 'empty_name',
            message: '请选择设备或身份',
            ts: Date.now(),
          });
          break;
        }

        // 只对 client 做重复占用检查；operator 可以重复进入。
        // 注意比的是「设备」而不是完整显示名：显示名是「设备｜人名」，
        // 直接比全名的话「话筒3｜小明」和「话筒3｜小红」不相等，同一支话筒会被多人同时占用。
        if (regRole === 'client') {
          const regDevice = deviceOf(regName);
          const alreadyTaken = this.state.getWebSockets().some((s) => {
            if (s === ws) return false;
            const m = safeMeta(s);
            return m?.role === 'client' && deviceOf(m?.name) === regDevice;
          });

          if (alreadyTaken) {
            safeSend(ws, {
              type: 'name_taken',
              name: regName,
              ts: Date.now(),
            });
            break;
          }
        }

        this._setMeta(ws, {
          name: regName,
          role: regRole,
          identityType: cleanIdentityType(msg.identityType),
          ts: Date.now(),
        });

        safeSend(ws, {
          type: 'ack',
          name: regName,
          role: regRole,
          ts: Date.now(),
        });

        this._pushMemberList();

        // 给新加入的 client 单独补发当前占用列表，避免 UI 状态慢半拍。
        if (regRole === 'client') {
          safeSend(ws, {
            type: 'taken_devices',
            names: this._takenNames(),
            ts: Date.now(),
          });
        }

        // operator 晚上线：回放当天暂存的舞台请求 / 群聊，避免漏收。
        if (regRole === 'operator') {
          await this._replayHistoryTo(ws);
        }

        // 新加入的人补发当前歌单（现场模式要用）
        await this._sendSetlistTo(ws);

        break;
      }

      // ── 同步标注（墨迹）：画在谱面上，全房间同步 ──
      // 任何已注册的人都能画（台上台下都要能标记），但 undo 只撤自己的那一笔。
      case 'ink': {
        const meta = safeMeta(ws);
        if (!meta || !meta.role) break;

        const song = cleanText(msg.song, 120);
        const op = ['stroke', 'undo', 'clear'].indexOf(msg.op) >= 0 ? msg.op : '';
        if (!song || !op) break;

        const ink = await this._loadInk();
        if (!ink[song]) ink[song] = [];

        let payload = null;
        if (op === 'stroke') {
          const s = msg.stroke || {};
          const pts = Array.isArray(s.pts) ? s.pts.slice(0, INK_MAX_PTS)
            .filter((p) => Array.isArray(p) && p.length >= 2)
            .map((p) => [round3(p[0]), round3(p[1])]) : [];
          if (!pts.length) break;
          const stroke = {
            id: cleanId(s.id, 'ink'),
            tool: ['pen', 'hl', 'shape', 'text'].indexOf(s.tool) >= 0 ? s.tool : 'pen',
            text: s.tool === 'text' ? cleanText(s.text, 120) : undefined,
            shape: ['free', 'line', 'rect', 'ellipse', 'arrow'].indexOf(s.shape) >= 0 ? s.shape : 'free',
            color: cleanText(s.color, 24) || '#ff3b30',
            width: Math.max(1, Math.min(40, Number(s.width) || 3)),
            pts,
            by: meta.name || '',
            ts: Date.now(),
          };
          ink[song].push(stroke);
          if (ink[song].length > INK_MAX_PER_SONG) ink[song].splice(0, ink[song].length - INK_MAX_PER_SONG);
          payload = { type: 'ink', op: 'stroke', song, stroke, ts: stroke.ts };
        } else if (op === 'undo') {
          // 前端撤销 / 橡皮 / 局部擦都会带上具体 id（见 cecp.js 的 wsSend op:'undo'）。
          // 必须按 id 删，否则「擦掉一条早先画的线」会变成删掉自己最新那笔 ——
          // 被擦的那条刷新后复活，最新那笔却永久消失。
          // 不带 id 时（老客户端）才退回「撤自己最后一笔」。
          // 注意：按 id 删不校验归属，与前端橡皮一致（前端允许擦别人的记号）。
          const wantId = cleanText(msg.id, 120);
          let idx = -1;
          if (wantId) {
            idx = ink[song].findIndex((x) => x.id === wantId);
          } else {
            const mine = meta.name || '';
            for (let i = ink[song].length - 1; i >= 0; i--) {
              if (ink[song][i].by === mine) { idx = i; break; }
            }
          }
          if (idx < 0) break;
          const removed = ink[song].splice(idx, 1)[0];
          payload = { type: 'ink', op: 'undo', song, id: removed.id, ts: Date.now() };
        } else {
          // 清空会抹掉所有人的标注且服务端无从恢复，所以不能让免凭据的 listener 干这事。
          if (meta.role !== 'client' && meta.role !== 'operator') break;
          ink[song] = [];
          payload = { type: 'ink', op: 'clear', song, by: meta.name || '', ts: Date.now() };
        }

        // put 失败必须回滚内存缓存：_loadInk() 返回的就是 this._ink 本体，
        // 上面已经改脏了；不回滚的话之后每一笔都会带着超限对象反复失败。
        const saved = await this._saveInk(ink);
        if (!saved) {
          this._ink = undefined;   // 丢掉脏缓存，下次从存储重读
          safeSend(ws, { type: 'error', code: 'ink_full', message: '标注太多，暂时存不下了', ts: Date.now() });
          break;
        }
        this._broadcast(payload);
        break;
      }

      // 拉某首歌已有的标注（换歌 / 刚进来时）
      case 'ink_get': {
        const song = cleanText(msg.song, 120);
        if (!song) break;
        const ink = await this._loadInk();
        safeSend(ws, { type: 'ink', op: 'all', song, strokes: ink[song] || [], ts: Date.now() });
        break;
      }

      // ── 激光笔：即时指示，不存盘，只转发给别人 ──
      case 'laser': {
        const meta = safeMeta(ws);
        if (!meta || !meta.role) break;
        const mode = msg.mode === 'line' ? 'line' : 'dot';
        const pts = Array.isArray(msg.pts) ? msg.pts.slice(0, 120)
          .filter((p) => Array.isArray(p) && p.length >= 2)
          .map((p) => [round3(p[0]), round3(p[1])]) : [];
        this._broadcast({
          type: 'laser', mode, pts,
          done: !!msg.done,
          color: cleanText(msg.color, 24) || '#ff3b30',
          by: meta.name || '', ts: Date.now(),
        }, ws);
        break;
      }

      case 'setlist_set': {
        // 共享歌单：任何已注册的人都能改（现场随手选歌），改完广播给全房间。
        // 注意这里刻意不要求 operator —— 敬拜团在台上也要能翻歌。
        const meta = safeMeta(ws);
        if (!meta || !meta.role) break;

        const songs = Array.isArray(msg.songs) ? msg.songs.slice(0, SETLIST_MAX).map((s) => ({
          id: cleanText(s && s.id, 120),
          title: cleanText(s && s.title, 120),
          key: cleanText(s && s.key, 20),
        })).filter((s) => s.id || s.title) : [];

        const setlistPayload = {
          type: 'setlist',
          songs,
          title: cleanText(msg.title, 80),
          by: meta.name || '',
          ts: Date.now(),
        };

        await this.state.storage.put(SETLIST_KEY, setlistPayload);
        this._setlist = setlistPayload;
        this._broadcast(setlistPayload);   // 房间里所有人（含 listener）都更新
        break;
      }

      case 'worship_msg': {
        // Member → Operator(s)
        const meta = safeMeta(ws);
        if (meta?.role !== 'client') break;

        const text = cleanText(msg.text, 500);
        if (!text) break;

        const worshipPayload = {
          type: 'worship_msg',
          id: cleanId(msg.id, 'worship'),
          from: meta.name || '?',
          identityType: meta.identityType || 'other',
          kind: String(msg.kind || 'custom').trim() || 'custom',
          priority: msg.priority === 'high' ? 'high' : 'normal',
          text,
          ts: Date.now(),
        };
        this._broadcast(worshipPayload, ws, 'operator');
        // 暂存供晚上线的 operator 回放（带初始状态）
        await this._pushHistory({ ...worshipPayload, status: 'pending' });

        break;
      }

      case 'member_chat': {
        // Member chat: client/operator 都可以收到；发送方主要是 client。
        const meta = safeMeta(ws);
        if (meta?.role && meta.role !== 'client') break;

        const senderName = meta?.name || cleanName(msg.from) || '?';
        const text = cleanText(msg.text, 500);
        if (!text) break;

        const chatPayload = {
          type: 'member_chat',
          id: cleanId(msg.id, 'member'),
          from: senderName,
          identityType: meta?.identityType || 'other',
          text,
          ts: Date.now(),
        };
        this._broadcast(chatPayload, ws, null, (target) => target?.role === 'client' || target?.role === 'operator');
        await this._pushHistory(chatPayload);

        break;
      }

      case 'broadcast': {
        // Operator → Members（含 listener）；target:{names:[...]} 时只投递给命中的 client
        const meta = safeMeta(ws);
        if (meta?.role !== 'operator') break;

        const text = cleanText(msg.text, 800);
        if (!text) break;

        let targetNames = null;
        if (msg.target && typeof msg.target === 'object' && Array.isArray(msg.target.names)) {
          targetNames = msg.target.names.map(cleanName).filter(Boolean).slice(0, 100);
          if (!targetNames.length) targetNames = null;
        }

        const payload = {
          type: 'broadcast',
          id: cleanId(msg.id, 'broadcast'),
          text,
          target: targetNames ? { names: targetNames } : 'all',
          ts: Date.now(),
        };

        if (targetNames) {
          this._broadcast(payload, null, null, (m) => m?.role === 'client' && targetNames.indexOf(m?.name) >= 0);
        } else {
          this._broadcast(payload, null, null, (m) => m?.role === 'client' || m?.role === 'listener');
        }

        break;
      }

      case 'msg_status': {
        // Operator 标记请求状态：广播给所有 operator（看板同步）+ 所有 client（前端按 id 匹配自己的请求）
        const meta = safeMeta(ws);
        if (meta?.role !== 'operator') break;

        const rawId = String(msg.id || '').trim().slice(0, 120);
        const status = ['pending', 'doing', 'done'].indexOf(msg.status) >= 0 ? msg.status : '';
        if (!rawId || !status) break;

        this._broadcast({
          type: 'msg_status',
          id: rawId,
          status,
          ts: Date.now(),
        }, null, null, (m) => m?.role === 'operator' || m?.role === 'client');

        // 同步进历史，第二个 operator 回放时看到的是最新状态
        await this._updateHistoryStatus(rawId, status);

        break;
      }

      case 'operator_reply': {
        // Operator → 指定 name 的 client 定向回复
        const meta = safeMeta(ws);
        if (meta?.role !== 'operator') break;

        const to = cleanName(msg.to);
        const text = cleanText(msg.text, 500);
        if (!to || !text) break;

        const payload = {
          type: 'operator_reply',
          id: cleanId(msg.id, 'reply'),
          to,
          text,
          ts: Date.now(),
        };

        for (const s of this.state.getWebSockets()) {
          const m = safeMeta(s);
          if (m?.role === 'client' && m?.name === to) safeSend(s, payload);
        }

        break;
      }

      case 'kick': {
        // Operator kicks a single member by name
        const meta = safeMeta(ws);
        if (meta?.role !== 'operator') break;

        const targetName = cleanName(msg.name);
        if (!targetName) break;

        for (const s of this.state.getWebSockets()) {
          const m = safeMeta(s);
          if (m?.name === targetName && m?.role === 'client') {
            safeSend(s, {
              type: 'kicked',
              reason: 'operator',
              ts: Date.now(),
            });
            try {
              s.close(1000, 'kicked');
            } catch {}
          }
        }

        await delay(30);
        this._pushMemberList();
        break;
      }

      case 'kick_all': {
        // Operator kicks every member
        const meta = safeMeta(ws);
        if (meta?.role !== 'operator') break;

        for (const s of this.state.getWebSockets()) {
          const m = safeMeta(s);
          if (m?.role === 'client') {
            safeSend(s, {
              type: 'kicked',
              reason: 'operator',
              ts: Date.now(),
            });
            try {
              s.close(1000, 'kicked');
            } catch {}
          }
        }

        await delay(30);
        this._pushMemberList();
        break;
      }

      case 'ping': {
        safeSend(ws, {
          type: 'pong',
          ts: Date.now(),
        });
        break;
      }

      default: {
        safeSend(ws, {
          type: 'error',
          code: 'unknown_type',
          message: '未知消息类型',
          ts: Date.now(),
        });
      }
    }
  }

  async webSocketClose(ws) {
    await delay(50);
    this._pushMemberList();
  }

  async webSocketError(ws) {
    await delay(50);
    this._pushMemberList();
  }

  async alarm() {
    await this._runDailyReset();
    await this._ensureDailyResetAlarm(true);
  }

  // ── Helpers ────────────────────────────────────────────────

  // 合并写 attachment：register 会重写整个 attachment，直接 serializeAttachment 会把
  // 握手阶段验过的 opAuth 冲掉，导致「?key= 已通过但 register 又被要一次 key」。
  _setMeta(ws, patch) {
    const prev = safeMeta(ws) || {};
    try {
      ws.serializeAttachment({ ...prev, ...patch });
    } catch {}
  }

  // 校验音控密钥。未配置密钥 → not_configured（拒绝，不是放行）。
  _checkOperatorKey(supplied) {
    const expected = String((this.env && (this.env.OPERATOR_KEY || this.env.OP_PIN)) || '').trim();
    if (!expected) return { ok: false, reason: 'not_configured' };

    const got = String(supplied == null ? '' : supplied).trim();
    if (!got) return { ok: false, reason: 'key_required' };
    if (!timingSafeEqual(got, expected)) return { ok: false, reason: 'key_wrong' };

    return { ok: true, reason: '' };
  }

  // 失败递增延迟：DO 实例内存计数即可，攻击者每次失败都被 4001 断开，
  // 重连要重新握手，配合延迟让在线暴力破解不划算。合法用户输错一次几乎无感。
  async _penalizeOpFailure() {
    this._opFailures = (this._opFailures || 0) + 1;
    await delay(Math.min(OP_DENY_DELAY_MAX_MS, OP_DENY_DELAY_STEP_MS * this._opFailures));
  }

  _broadcast(payload, sender, targetRole, predicate) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

    for (const ws of this.state.getWebSockets()) {
      try {
        if (sender && ws === sender) continue;

        const meta = safeMeta(ws);
        if (targetRole && meta?.role !== targetRole) continue;
        if (predicate && !predicate(meta)) continue;

        ws.send(data);
      } catch {}
    }
  }

  _members() {
    return this.state.getWebSockets()
      .map((ws) => safeMeta(ws))
      .filter((a) => a?.role === 'client' && a?.name)
      .map((a) => ({
        name: a.name,
        ts: a.ts,
        identityType: a.identityType || 'other',
      }));
  }

  _takenNames() {
    return this._members().map((m) => m.name);
  }

  _pushMemberList() {
    const members = this._members();
    const takenNames = members.map((m) => m.name);

    this._broadcast({
      type: 'member_list',
      members,
      ts: Date.now(),
    }, null, 'operator');

    this._broadcast({
      type: 'taken_devices',
      names: takenNames,
      ts: Date.now(),
    }, null, null, (meta) => meta?.role === 'client' || meta?.role === 'listener');
  }

  // ── 消息历史（operator 晚上线也能看到之前的请求 / 群聊）──────
  async _loadHistory() {
    if (this._history == null) {
      this._history = (await this.state.storage.get(HISTORY_KEY)) || [];
    }
    return this._history;
  }

  async _pushHistory(entry) {
    const hist = await this._loadHistory();
    hist.push(entry);
    if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
    await this.state.storage.put(HISTORY_KEY, hist);
  }

  async _updateHistoryStatus(id, status) {
    const hist = await this._loadHistory();
    let changed = false;
    for (const e of hist) {
      if (e.type === 'worship_msg' && e.id === id && e.status !== status) {
        e.status = status;
        changed = true;
      }
    }
    if (changed) await this.state.storage.put(HISTORY_KEY, hist);
  }

  async _clearHistory() {
    this._history = [];
    await this.state.storage.delete(HISTORY_KEY);
  }

  // operator 注册后回放当天历史（按时间顺序，前端各自归类）
  async _replayHistoryTo(ws) {
    const hist = await this._loadHistory();
    for (const entry of hist) {
      safeSend(ws, { ...entry, replay: true });
    }
  }

  // ── 同步标注 ────────────────────────────────────────────────
  // 写入前先裁到预算内，再落盘。返回 false 表示没存成功（调用方要回滚缓存）。
  async _saveInk(ink) {
    // 1) 歌曲数量：按每首最后一笔的时间，丢最旧的
    const songs = Object.keys(ink);
    if (songs.length > INK_MAX_SONGS) {
      const lastTs = (k) => {
        const arr = ink[k];
        return (arr && arr.length) ? (arr[arr.length - 1].ts || 0) : 0;
      };
      songs.sort((a, b) => lastTs(a) - lastTs(b));
      for (const k of songs.slice(0, songs.length - INK_MAX_SONGS)) delete ink[k];
    }

    // 2) 总字节：还超就从「笔数最多的那首」丢最早的笔，直到进预算
    let guard = 0;
    while (JSON.stringify(ink).length > INK_MAX_BYTES && guard++ < 5000) {
      let biggest = null;
      for (const k of Object.keys(ink)) {
        if (!biggest || (ink[k] || []).length > (ink[biggest] || []).length) biggest = k;
      }
      if (!biggest || !(ink[biggest] || []).length) break;
      ink[biggest].splice(0, Math.max(1, Math.ceil(ink[biggest].length * 0.1)));
      if (!ink[biggest].length) delete ink[biggest];
    }

    try {
      await this.state.storage.put(INK_KEY, ink);
      this._ink = ink;
      return true;
    } catch {
      return false;
    }
  }

  async _loadInk() {
    if (this._ink === undefined) {
      this._ink = (await this.state.storage.get(INK_KEY)) || {};
    }
    return this._ink;
  }

  // ── 共享歌单 ────────────────────────────────────────────────
  async _sendSetlistTo(ws) {
    if (this._setlist === undefined) {
      this._setlist = (await this.state.storage.get(SETLIST_KEY)) || null;
    }
    if (this._setlist) safeSend(ws, this._setlist);
  }

  async _ensureDailyResetAlarm(force) {
    const currentAlarm = await this.state.storage.getAlarm();
    if (!force && currentAlarm != null && currentAlarm > Date.now() + 1000) return;
    await this.state.storage.setAlarm(nextMidnightInTimeZone(this.resetTimeZone, Date.now()));
  }

  async _runDailyReset() {
    const stamp = zonedDateStamp(this.resetTimeZone, new Date());
    const lastStamp = await this.state.storage.get(DAILY_RESET_STAMP_KEY);
    if (lastStamp === stamp) return;

    await this.state.storage.put(DAILY_RESET_STAMP_KEY, stamp);
    await this._clearHistory();
    /* 标注跟当天的谱走，隔天清掉（歌单是「本周诗歌」所以保留） */
    this._ink = {};
    await this.state.storage.delete(INK_KEY);

    this._broadcast({
      type: 'daily_reset',
      reason: 'daily_reset',
      ts: Date.now(),
    });

    await delay(60);

    for (const ws of this.state.getWebSockets()) {
      const meta = safeMeta(ws);
      if (meta?.role === 'client') {
        safeSend(ws, {
          type: 'kicked',
          reason: 'daily_reset',
          ts: Date.now(),
        });
        try {
          ws.close(1000, 'daily_reset');
        } catch {}
      }
    }

    await delay(80);
    this._pushMemberList();
  }
}

// ── Main Worker ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders({}, request, env) });
    }

    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // 普通浏览器打开 Worker 地址时显示健康检查，不再只看到 Expected WebSocket。
    if (upgrade !== 'websocket') {
      if (url.pathname === '/health' || url.pathname === '/healthz') {
        return json({
          ok: true,
          service: 'Lamezia Worship Team Intercom',
          websocket: false,
          path: url.pathname,
          time: new Date().toISOString(),
        });
      }

      return htmlHealthPage(request);
    }

    // 来源白名单只挡浏览器发起的跨站连接（健康检查页不限制，方便部署后自查）
    const origin = request.headers.get('Origin');
    if (!isAllowedOrigin(origin, env)) {
      return json({
        ok: false,
        error: 'origin_not_allowed',
        message: '这个来源不在 ALLOWED_ORIGINS 里，请检查 worker/wrangler.toml',
        origin,
      }, 403);
    }

    if (!env.ROOM) {
      return json({
        ok: false,
        error: 'Missing Durable Object binding: ROOM',
      }, 500);
    }

    // 房间路由：?room=xxx（字母/数字/下划线/连字符，最长 64），缺省 lamezia
    const roomParam = String(url.searchParams.get('room') || '').trim();
    const roomName = /^[\w-]{1,64}$/.test(roomParam) ? roomParam : 'lamezia';

    const id = env.ROOM.idFromName(roomName);
    const room = env.ROOM.get(id);
    return room.fetch(request);
  },
};

// ── Utils ────────────────────────────────────────────────────
// 允许的来源：wrangler.toml 的 ALLOWED_ORIGINS（逗号分隔）+ 任意端口的 localhost / 127.0.0.1。
//
// 注意边界：浏览器对 WebSocket 不做 CORS 拦截，所以这里的收紧只能挡住「别的网站用浏览器
// 驱动你的房间」，挡不住 curl / 脚本这类非浏览器客户端（它们根本不发 Origin）。
// 真正的权限边界是 OPERATOR_KEY，不是这个。
function isAllowedOrigin(origin, env) {
  if (!origin) return true; // 非浏览器客户端不发 Origin，放行（挡它没意义，见上）

  let parsed;
  try { parsed = new URL(origin); } catch { return false; }

  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;

  const allowed = String((env && env.ALLOWED_ORIGINS) || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return allowed.indexOf(parsed.origin) >= 0;
}

function corsHeaders(extra = {}, request, env) {
  const origin = request && request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Upgrade, Connection',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
    ...extra,
  };

  // 只回显通过白名单的来源，不再无脑 '*'
  if (origin && isAllowedOrigin(origin, env)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}

function htmlHealthPage(request) {
  const url = new URL(request.url);
  const wsUrl = `wss://${url.host}${url.pathname === '/' ? '' : url.pathname}`;

  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Lamezia Intercom Worker</title>
<style>
:root{
  color-scheme: light dark;
  --bg:#f5f3ef;
  --card:#fff;
  --text:#1a1916;
  --muted:#6b6660;
  --border:#e4e0d8;
  --gold:#c9922a;
  --green:#3a7d5e;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#090b12;
    --card:#111724;
    --text:#edf1ff;
    --muted:#9aa4bd;
    --border:rgba(157,172,209,.18);
    --gold:#f3d283;
    --green:#59d68c;
  }
}
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  padding:24px;
  background:
    radial-gradient(circle at top left, rgba(201,146,42,.18), transparent 32%),
    radial-gradient(circle at bottom right, rgba(58,125,94,.16), transparent 30%),
    var(--bg);
  color:var(--text);
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans SC",sans-serif;
}
.card{
  width:min(720px,100%);
  padding:28px;
  border:1px solid var(--border);
  border-radius:24px;
  background:color-mix(in srgb, var(--card) 92%, transparent);
  box-shadow:0 18px 42px rgba(0,0,0,.12);
}
.kicker{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:7px 12px;
  border-radius:999px;
  background:rgba(58,125,94,.12);
  color:var(--green);
  font-size:12px;
  font-weight:700;
  letter-spacing:.08em;
}
h1{margin:18px 0 8px;font-size:clamp(28px,5vw,42px);line-height:1.05}
p{margin:0 0 18px;color:var(--muted);line-height:1.7}
.code{
  display:block;
  overflow:auto;
  padding:14px 16px;
  border:1px solid var(--border);
  border-radius:14px;
  background:rgba(0,0,0,.04);
  color:var(--text);
  font-size:13px;
}
.row{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
  margin-top:18px;
}
.badge{
  padding:8px 12px;
  border:1px solid var(--border);
  border-radius:999px;
  color:var(--muted);
  font-size:13px;
}
strong{color:var(--gold)}
</style>
</head>
<body>
  <main class="card">
    <span class="kicker">● WORKER ONLINE</span>
    <h1>Lamezia Intercom Worker</h1>
    <p>后端已经运行。前端请使用下面这个 WebSocket 地址填到 <strong>data-ws-url</strong>。</p>
    <code class="code">${escapeHtml(wsUrl)}</code>
    <div class="row">
      <span class="badge">Durable Object: ROOM</span>
      <span class="badge">Room: ?room=xxx（默认 lamezia）</span>
      <span class="badge">Health: /health</span>
    </div>
  </main>
</body>
</html>`, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}

function safeSend(ws, data) {
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  } catch {}
}

// 定长比较，避免逐字符提前返回泄漏前缀信息。长度本身仍会泄漏，属可接受范围。
function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const ba = encoder.encode(String(a));
  const bb = encoder.encode(String(b));
  if (ba.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function safeMeta(ws) {
  try {
    return ws.deserializeAttachment() || {};
  } catch {
    return {};
  }
}

// 标注坐标是相对谱面的 0–1 归一化值，留点余量后压到 3 位小数，控制存储与带宽。
function round3(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(Math.max(-0.5, Math.min(1.5, v)) * 1000) / 1000;
}

// 显示名格式是「设备｜人名」（前端 buildDisplayName）。取设备部分用于占用判断。
function deviceOf(value) {
  return String(value || '').trim().split(/[｜|]/)[0].trim();
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 80);
}

function cleanRole(value) {
  const role = String(value || 'client').trim();
  if (role === 'operator') return 'operator';
  if (role === 'listener') return 'listener';
  return 'client';
}

function cleanIdentityType(value) {
  const type = String(value || 'other').trim();
  return ['operator', 'mic', 'instrument', 'listener', 'other'].includes(type) ? type : 'other';
}

function cleanText(value, maxLen = 500) {
  return String(value || '').trim().slice(0, maxLen);
}

function cleanId(value, prefix) {
  const raw = String(value || '').trim();
  if (raw) return raw.slice(0, 120);
  return `${prefix || 'msg'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function pad2(value) {
  return String(value || 0).padStart(2, '0');
}

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  return {
    year: Number(map.year || 0),
    month: Number(map.month || 0),
    day: Number(map.day || 0),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
    second: Number(map.second || 0),
  };
}

function addDaysYmd(year, month, day, deltaDays) {
  const date = new Date(Date.UTC(year, month - 1, day + (deltaDays || 0)));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareDateTimeParts(a, b) {
  const keys = ['year', 'month', 'day', 'hour', 'minute', 'second'];
  for (const key of keys) {
    const diff = Number(a[key] || 0) - Number(b[key] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function zonedDateStamp(timeZone, date) {
  const parts = getZonedParts(date || new Date(), timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function nextMidnightInTimeZone(timeZone, nowMs) {
  const now = Number(nowMs || Date.now());
  const nowParts = getZonedParts(new Date(now), timeZone);
  const nextDate = addDaysYmd(nowParts.year, nowParts.month, nowParts.day, 1);
  const target = {
    year: nextDate.year,
    month: nextDate.month,
    day: nextDate.day,
    hour: 0,
    minute: 0,
    second: 0,
  };

  let low = now + 1000;
  let high = now + 48 * 60 * 60 * 1000;

  while (compareDateTimeParts(getZonedParts(new Date(high), timeZone), target) < 0) {
    high += 12 * 60 * 60 * 1000;
  }

  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2);
    const parts = getZonedParts(new Date(mid), timeZone);
    if (compareDateTimeParts(parts, target) >= 0) high = mid;
    else low = mid + 1;
  }

  return high;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
