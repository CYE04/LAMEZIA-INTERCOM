/* ============================================================
   LAMEZIA 敬拜内通 — 全站配置
   ------------------------------------------------------------
   换服务器地址、改房间名、改显示名称，都只改这一个文件。
   这个文件会被 index.html 和 install.html 读取。

   ⚠️ 这里不要放音控密码！密码只存在 Cloudflare 服务器上：
        cd worker && npx wrangler secret put OPERATOR_KEY
   ============================================================ */

window.LAMEZIA_CONFIG = {

  /* ── 1. 必须改：Worker 的 WebSocket 地址 ──────────────────
     部署 worker 之后（cd worker && npx wrangler deploy），
     命令行会打印出类似：
         https://ws-lamezia.你的账号名.workers.dev
     把它的 https:// 换成 wss:// 填在这里，末尾不要带斜杠。
     例：'wss://ws-lamezia.abc123.workers.dev'                     */
  WS_URL: 'wss://ws-lamezia.yuen2901.workers.dev',

  /* ── 2. 房间名 ────────────────────────────────────────────
     要和 worker/wrangler.toml 里的默认房间名一致。
     同一个 worker 可以开多个房间，一般不用改。                    */
  ROOM: 'lamezia',

  /* ── 3. 界面上显示的名称 ──────────────────────────────────
     角色选择页、成员端、音控台的标题都用这个。                     */
  APP_NAME: 'LAMEZIA 敬拜内通',

  /* ── 4. localStorage 命名空间（一般不用改）────────────────
     必须是固定值，不能让它跟着网址路径走：
     装到主屏幕后启动网址是 ./index.html，直接打开可能是目录根，
     两者路径不同；若跟着路径走，会被当成两个不同的浏览器存档 ——
     音控要重输密码、成员要重选设备。固定死就不会。                 */
  STORE_KEY: 'lamezia',

  /* ── 5. 记住身份用的 localStorage 键（一般不用改）─────────  */
  ROLE_KEY: 'lamezia:last-role'
};
