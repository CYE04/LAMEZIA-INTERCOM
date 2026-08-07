/* ============================================================
   worker 回归测试（构建期工具，不参与运行时）

       node tools/test-worker.mjs

   只用 Node 标准库，不需要 npm install、不需要 wrangler。
   用桩替掉 Durable Object runtime，直接驱动真实的 WorshipRoom 类。

   ⚠️ 每次从 CECP 上游合并之后都跑一遍。
   本项目相对上游有几处本地修复（音控 fail-closed 鉴权、设备占用按设备比对、
   墨迹的三个修复），上游那边都没有——这个套件就是防止合并时把它们冲掉。
   ============================================================ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(here, '..', 'worker', 'index.js');
const { WorshipRoom } = await import(pathToFileURL(workerPath).href);

let PASS = 0, FAIL = 0;
const ok = (n, c, x) => c ? (PASS++, console.log(`  ✓ ${n}`))
  : (FAIL++, console.log(`  ✗ ${n}${x !== undefined ? '  → ' + JSON.stringify(x) : ''}`));

/* ── DO runtime 的桩 ────────────────────────────────────── */
class FakeWS {
  constructor() { this.sent = []; this.closed = null; this.attachment = undefined; }
  send(d) { this.sent.push(JSON.parse(d)); }
  close(code, reason) { this.closed = { code, reason }; }
  serializeAttachment(v) { this.attachment = JSON.parse(JSON.stringify(v)); }
  deserializeAttachment() { return this.attachment; }
  last(t) { return [...this.sent].reverse().find((m) => m.type === t); }
  has(t) { return this.sent.some((m) => m.type === t); }
  clear() { this.sent.length = 0; }
}

function makeRoom(env) {
  const sockets = [];
  const store = new Map();
  const state = {
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => {
        const j = JSON.stringify(v);
        // 模拟 SQLite-backed DO 的「键+值」2MB 上限
        if (j.length > 2_000_000) throw new Error('value too large');
        store.set(k, JSON.parse(j));
      },
      delete: async (k) => store.delete(k),
      getAlarm: async () => Date.now() + 3600e3,
      setAlarm: async () => {},
    },
  };
  return { room: new WorshipRoom(state, env), sockets, store };
}

const join = (s) => { const w = new FakeWS(); s.push(w); return w; };
const REG = (o) => JSON.stringify({ type: 'register', ...o });
const stroke = (id, pts) => ({ id, tool: 'pen', pts: pts || [[0.1, 0.1], [0.2, 0.2]] });
const KEY = 'sw0rdf1sh';

/* ── A. 音控鉴权：fail-closed ───────────────────────────── */
console.log('\n【A. 音控鉴权 fail-closed】（本地修复，上游是 fail-open）');
{
  const { room, sockets } = makeRoom({});
  const w = join(sockets);
  await room.webSocketMessage(w, REG({ name: '音控组', role: 'operator' }));
  ok('未配置密钥 → not_configured', w.last('op_denied')?.reason === 'not_configured');
  ok('未配置密钥 → 4001 断开', w.closed?.code === 4001);
  ok('未配置密钥 → 没成为 operator', w.attachment?.role !== 'operator');
}
{
  const { room, sockets } = makeRoom({ OPERATOR_KEY: KEY });
  const bad = join(sockets);
  await room.webSocketMessage(bad, REG({ name: '音控组', role: 'operator', key: 'x' }));
  ok('错密码 → key_wrong + 4001', bad.last('op_denied')?.reason === 'key_wrong' && bad.closed?.code === 4001);

  const good = join(sockets);
  await room.webSocketMessage(good, REG({ name: '音控组', role: 'operator', key: KEY }));
  ok('对密码 → ack operator', good.last('ack')?.role === 'operator');
  ok('对密码 → opAuth=true', good.attachment?.opAuth === true);

  const atk = join(sockets);
  await room.webSocketMessage(atk, REG({ name: '🎤 话筒1｜坏人', role: 'client' }));
  await room.webSocketMessage(atk, REG({ name: '音控组', role: 'operator' }));
  ok('client 提权被拒', atk.attachment?.role !== 'operator');
}

/* ── B. 设备占用按「设备」比对 ──────────────────────────── */
console.log('\n【B. 设备占用按设备比对】（本地修复，上游比完整显示名）');
{
  const { room, sockets } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets);
  await room.webSocketMessage(a, REG({ name: '🎤 话筒3｜小明', role: 'client' }));
  ok('第一个人进得来', a.last('ack')?.role === 'client');

  const b = join(sockets);
  await room.webSocketMessage(b, REG({ name: '🎤 话筒3｜小红', role: 'client' }));
  ok('同设备不同人名 → name_taken', !!b.last('name_taken'));
  ok('同设备不同人名 → 没拿到 ack', !b.has('ack'));

  const c = join(sockets);
  await room.webSocketMessage(c, REG({ name: '🎤 话筒4｜小刚', role: 'client' }));
  ok('不同设备不受影响', c.last('ack')?.role === 'client');

  const l = join(sockets);
  await room.webSocketMessage(l, REG({ name: '', role: 'listener' }));
  const taken = l.last('taken_devices');
  ok('listener 收到占用列表（选设备界面置灰要用）', !!taken);
  ok('占用列表含已占设备', (taken?.names || []).some((n) => n.includes('话筒3')));
}

/* ── C. 墨迹标注 ────────────────────────────────────────── */
console.log('\n【C. 墨迹标注】');
{
  const { room, sockets, store } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets); await room.webSocketMessage(a, REG({ name: '🎤 话筒1｜甲', role: 'client' }));
  const b = join(sockets); await room.webSocketMessage(b, REG({ name: '🎤 话筒2｜乙', role: 'client' }));
  a.clear(); b.clear();

  await room.webSocketMessage(a, JSON.stringify({
    type: 'ink', op: 'stroke', song: 's1',
    stroke: { id: 'k1', tool: 'pen', color: '#ff0000', width: 3, pts: [[0.1, 0.2], [0.3, 0.4]] },
  }));
  ok('画笔广播给其他人', b.last('ink')?.op === 'stroke');
  ok('坐标压到 3 位小数', b.last('ink')?.stroke?.pts?.[0]?.[0] === 0.1);
  ok('记录作者', b.last('ink')?.stroke?.by === '🎤 话筒1｜甲');
  ok('已持久化', store.get('ink_v1')?.s1?.length === 1);

  const c = join(sockets);
  await room.webSocketMessage(c, REG({ name: '🎤 话筒5｜丙', role: 'client' }));
  c.clear();
  await room.webSocketMessage(c, JSON.stringify({ type: 'ink_get', song: 's1' }));
  ok('ink_get 拉回已有笔迹', c.last('ink')?.op === 'all' && c.last('ink')?.strokes?.length === 1);

  const anon = join(sockets); b.clear();
  await room.webSocketMessage(anon, JSON.stringify({
    type: 'ink', op: 'stroke', song: 's1', stroke: stroke('x'),
  }));
  ok('未注册的连接不能画', !b.has('ink'));

  b.clear();
  const huge = Array.from({ length: 5000 }, (_, i) => [i / 5000, 0.5]);
  await room.webSocketMessage(a, JSON.stringify({
    type: 'ink', op: 'stroke', song: 's2', stroke: stroke('big', huge),
  }));
  ok('单笔点数截断到 600', b.last('ink')?.stroke?.pts?.length === 600);
}

/* ── D. 墨迹的三个本地修复 ──────────────────────────────── */
console.log('\n【D. 墨迹三修复】（本地修复，上游都有这些问题）');
{
  const { room, sockets, store } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets); await room.webSocketMessage(a, REG({ name: '🎤 话筒1｜甲', role: 'client' }));
  for (const id of ['old', 'mid', 'new']) {
    await room.webSocketMessage(a, JSON.stringify({ type: 'ink', op: 'stroke', song: 's', stroke: stroke(id) }));
  }
  await room.webSocketMessage(a, JSON.stringify({ type: 'ink', op: 'undo', song: 's', id: 'old' }));
  ok('① undo 按 id 删（不会删错笔）', store.get('ink_v1').s.map((x) => x.id).join(',') === 'mid,new',
     store.get('ink_v1').s.map((x) => x.id));

  await room.webSocketMessage(a, JSON.stringify({ type: 'ink', op: 'undo', song: 's' }));
  ok('① 不带 id 时撤自己最后一笔', store.get('ink_v1').s.map((x) => x.id).join(',') === 'mid');

  const lurker = join(sockets);
  await room.webSocketMessage(lurker, REG({ name: '', role: 'listener' }));
  await room.webSocketMessage(lurker, JSON.stringify({ type: 'ink', op: 'clear', song: 's' }));
  ok('② listener 不能清空全房间标注', (store.get('ink_v1').s || []).length === 1);

  await room.webSocketMessage(a, JSON.stringify({ type: 'ink', op: 'clear', song: 's' }));
  ok('② 正常成员可以清空', (store.get('ink_v1').s || []).length === 0);
}
{
  const { room, sockets, store } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets); await room.webSocketMessage(a, REG({ name: '🎤 话筒1｜甲', role: 'client' }));
  const b = join(sockets); await room.webSocketMessage(b, REG({ name: '🎤 话筒2｜乙', role: 'client' }));
  const fat = Array.from({ length: 600 }, (_, i) => [i / 600, 0.5]);
  for (let s = 0; s < 60; s++) {
    for (let n = 0; n < 60; n++) {
      await room.webSocketMessage(a, JSON.stringify({
        type: 'ink', op: 'stroke', song: 'song' + s, stroke: stroke('s' + s + '_' + n, fat),
      }));
    }
  }
  const bytes = JSON.stringify(store.get('ink_v1')).length;
  ok('③ 总量压在预算内', bytes < 1_600_000, bytes);
  ok('③ 歌曲数裁到上限内', Object.keys(store.get('ink_v1')).length <= 40);

  b.clear();
  await room.webSocketMessage(a, JSON.stringify({
    type: 'ink', op: 'stroke', song: 'song59', stroke: stroke('after'),
  }));
  ok('③ 灌满后仍能画并广播（不静默失效）', b.last('ink')?.stroke?.id === 'after');
}

/* ── E. 激光笔 ──────────────────────────────────────────── */
console.log('\n【E. 激光笔】');
{
  const { room, sockets, store } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets); await room.webSocketMessage(a, REG({ name: '🎤 话筒1｜甲', role: 'client' }));
  const b = join(sockets); await room.webSocketMessage(b, REG({ name: '🎤 话筒2｜乙', role: 'client' }));
  a.clear(); b.clear();
  await room.webSocketMessage(a, JSON.stringify({ type: 'laser', mode: 'dot', pts: [[0.5, 0.5]] }));
  ok('转发给别人', b.last('laser')?.mode === 'dot');
  ok('不回给自己', !a.has('laser'));
  ok('不写盘', !store.has('ink_v1'));
}

/* ── F. 共享歌单 + 每日清理 ─────────────────────────────── */
console.log('\n【F. 共享歌单 / 每日清理】');
{
  const { room, sockets, store } = makeRoom({ OPERATOR_KEY: KEY });
  const a = join(sockets); await room.webSocketMessage(a, REG({ name: '🎤 话筒1｜甲', role: 'client' }));
  const b = join(sockets); await room.webSocketMessage(b, REG({ name: '🎤 话筒2｜乙', role: 'client' }));
  b.clear();
  await room.webSocketMessage(a, JSON.stringify({
    type: 'setlist_set', songs: [{ id: 'x', title: '歌一' }, { id: 'y', title: '歌二' }], title: '本周',
  }));
  ok('歌单广播给全房间', b.last('setlist')?.songs?.length === 2);
  ok('歌单已持久化', store.get('setlist_v1')?.songs?.length === 2);

  // 排序（前端 moveSong 复用同一条消息）
  b.clear();
  await room.webSocketMessage(a, JSON.stringify({
    type: 'setlist_set', songs: [{ id: 'y', title: '歌二' }, { id: 'x', title: '歌一' }], title: '本周',
  }));
  ok('排序后顺序同步', b.last('setlist')?.songs?.map((s) => s.id).join(',') === 'y,x');

  await room.webSocketMessage(a, JSON.stringify({
    type: 'ink', op: 'stroke', song: 's', stroke: stroke('k'),
  }));
  await room._runDailyReset();
  ok('每日清理：墨迹清掉', !store.get('ink_v1'));
  ok('每日清理：歌单保留', !!store.get('setlist_v1'));
}

console.log(`\n${'='.repeat(46)}\n通过 ${PASS} / 失败 ${FAIL}\n`);
process.exit(FAIL ? 1 : 0);
