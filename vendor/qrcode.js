/* ============================================================
   qrcode.js — 极简 QR 码生成器（vendor 进仓库，不走 CDN）

   只做本项目需要的事：把一段 URL 编成 QR 矩阵，渲染成 SVG。
     - 字节模式（UTF-8）
     - 纠错等级 L / M（默认 M）
     - 版本 1–10（M 级最多约 213 字节，装 URL 绰绰有余）

   用法：
     QRCode.toSVG('https://example.com', { size: 220, margin: 4 })  → SVG 字符串
     QRCode.encode('...')                                           → 布尔矩阵

   参考 ISO/IEC 18004。无依赖、无网络。
   ============================================================ */
(function (global) {
  'use strict';

  /* ── GF(256) 伽罗瓦域，用于 Reed-Solomon 纠错 ── */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;          // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* 生成多项式 g(x) = (x-α^0)(x-α^1)…(x-α^(n-1)) */
  function rsGenerator(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /* 多项式除法取余 = 纠错码字 */
  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(data.length + ecLen).fill(0);
    for (var i = 0; i < data.length; i++) res[i] = data[i];

    for (var k = 0; k < data.length; k++) {
      var coef = res[k];
      if (coef === 0) continue;
      for (var j = 0; j < gen.length; j++) res[k + j] ^= gfMul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  /* ── 版本 / 纠错等级表（版本 1–10，L 与 M）──────────────
     每项：[每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字] */
  var BLOCKS = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]
    ]
  };

  /* 对齐图形中心坐标（版本 1–10） */
  var ALIGN = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  var EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };   // 格式信息里的等级编码

  function blockSpec(version, level) {
    return BLOCKS[level][version - 1];
  }

  function dataCapacity(version, level) {
    var s = blockSpec(version, level);
    return s[1] * s[2] + s[3] * s[4];
  }

  /* ── UTF-8 ── */
  function toUtf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        // 代理对 → 单个码点
        var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /* ── 比特流 ── */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  /* ── 编码：文本 → 最终码字序列 ── */
  function buildCodewords(text, version, level) {
    var bytes = toUtf8Bytes(text);
    var capacity = dataCapacity(version, level);
    var lenBits = version >= 10 ? 16 : 8;      // 字节模式：版本 1–9 用 8 位

    var buf = new BitBuffer();
    buf.put(4, 4);                              // 模式指示符：字节 = 0100
    buf.put(bytes.length, lenBits);
    for (var i = 0; i < bytes.length; i++) buf.put(bytes[i], 8);

    // 结束符最多 4 个 0
    var total = capacity * 8;
    var term = Math.min(4, total - buf.bits.length);
    for (var t = 0; t < term; t++) buf.bits.push(0);
    // 补齐到字节边界
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    var codewords = [];
    for (var b = 0; b < buf.bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | buf.bits[b + k];
      codewords.push(v);
    }
    // 填充码字交替 0xEC / 0x11
    var pad = [0xec, 0x11], p = 0;
    while (codewords.length < capacity) codewords.push(pad[p++ % 2]);

    return codewords;
  }

  /* 分块 + 纠错 + 交织 */
  function interleave(codewords, version, level) {
    var spec = blockSpec(version, level);
    var ecLen = spec[0];
    var groups = [[spec[1], spec[2]], [spec[3], spec[4]]];

    var dataBlocks = [], ecBlocks = [], offset = 0;
    for (var g = 0; g < 2; g++) {
      for (var n = 0; n < groups[g][0]; n++) {
        var block = codewords.slice(offset, offset + groups[g][1]);
        offset += groups[g][1];
        dataBlocks.push(block);
        ecBlocks.push(rsEncode(block, ecLen));
      }
    }

    var out = [], i, j;
    var maxData = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
    for (i = 0; i < maxData; i++) {
      for (j = 0; j < dataBlocks.length; j++) {
        if (i < dataBlocks[j].length) out.push(dataBlocks[j][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (j = 0; j < ecBlocks.length; j++) out.push(ecBlocks[j][i]);
    }
    return out;
  }

  /* ── 矩阵 ── */
  function makeMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) {
      m.push(new Array(size).fill(null));   // null = 尚未占用（数据区）
    }
    return m;
  }

  function placeFinder(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = (inRing || inCore) ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, version) {
    var centers = ALIGN[version - 1];
    var size = m.length;
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var row = centers[a], col = centers[b];
        // 跳过与定位图形重叠的三处
        if ((row <= 8 && col <= 8) ||
            (row <= 8 && col >= size - 9) ||
            (row >= size - 9 && col <= 8)) continue;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var edge = Math.max(Math.abs(r), Math.abs(c));
            m[row + r][col + c] = (edge === 1) ? 0 : 1;
          }
        }
      }
    }
  }

  function placeTiming(m) {
    var size = m.length;
    for (var i = 8; i < size - 8; i++) {
      var v = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }
  }

  /* 预留格式 / 版本信息区（先填 0，稍后覆盖） */
  function reserveInfo(m, version) {
    var size = m.length, i;
    for (i = 0; i <= 8; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;                       // 固定的暗模块
    if (version >= 7) {
      for (i = 0; i < 6; i++) {
        for (var j = 0; j < 3; j++) {
          m[size - 11 + j][i] = 0;
          m[i][size - 11 + j] = 0;
        }
      }
    }
  }

  /* 数据填充：从右下角起，两列一组之字形上下走 */
  function placeData(m, codewords) {
    var size = m.length;
    var bitIndex = 0;
    var total = codewords.length * 8;

    function nextBit() {
      if (bitIndex >= total) return 0;        // 余下的补 0
      var byte = codewords[bitIndex >> 3];
      var bit = (byte >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    }

    var up = true;
    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;             // 跳过竖直定时图形所在列
      for (var step = 0; step < size; step++) {
        var row = up ? size - 1 - step : step;
        for (var k = 0; k < 2; k++) {
          var col = right - k;
          if (m[row][col] === null) m[row][col] = nextBit();
        }
      }
      up = !up;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  /* 只对数据区应用掩码（功能图形不动），用 reserved 记录哪些是功能图形 */
  function applyMask(matrix, reserved, maskId) {
    var size = matrix.length;
    var out = matrix.map(function (row) { return row.slice(); });
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (!reserved[r][c] && MASKS[maskId](r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  /* 格式信息：5 位数据 + BCH(15,5)，再异或 0x5412 */
  function formatBits(level, maskId) {
    var data = (EC_BITS[level] << 3) | maskId;
    var value = data << 10;
    for (var i = 4; i >= 0; i--) {
      if ((value >>> (i + 10)) & 1) value ^= 0x537 << i;   // 生成多项式 10100110111
    }
    return ((data << 10) | value) ^ 0x5412;
  }

  function placeFormat(m, level, maskId) {
    var bits = formatBits(level, maskId);
    var size = m.length, i;

    function bit(n) { return (bits >>> n) & 1; }

    // 左上角
    for (i = 0; i <= 5; i++) m[8][i] = bit(i);
    m[8][7] = bit(6);
    m[8][8] = bit(7);
    m[7][8] = bit(8);
    for (i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

    // 副本：左下竖列放 7 位（bit 0–6），右上横行放 8 位（bit 7–14）。
    // 注意左下只能到 size-7：size-8 那格是固定暗模块，不属于格式信息。
    for (i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
    for (i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);

    m[size - 8][8] = 1;                       // 暗模块
  }

  /* 版本信息（版本 ≥ 7）：6 位数据 + BCH(18,6) */
  function placeVersion(m, version) {
    if (version < 7) return;
    var value = version << 12;
    for (var i = 5; i >= 0; i--) {
      if ((value >>> (i + 12)) & 1) value ^= 0x1f25 << i;
    }
    var bits = (version << 12) | value;
    var size = m.length;

    for (var k = 0; k < 18; k++) {
      var b = (bits >>> k) & 1;
      var row = Math.floor(k / 3);
      var col = k % 3;
      m[size - 11 + col][row] = b;
      m[row][size - 11 + col] = b;
    }
  }

  /* ── 掩码罚分（ISO 18004 的四条规则）── */
  function penalty(m) {
    var size = m.length, score = 0, r, c, i;

    // 规则 1：同色连续 ≥5
    for (r = 0; r < size; r++) {
      for (var dir = 0; dir < 2; dir++) {
        var run = 1;
        for (c = 1; c < size; c++) {
          var cur = dir ? m[c][r] : m[r][c];
          var prev = dir ? m[c - 1][r] : m[r][c - 1];
          if (cur === prev) { run++; }
          else { if (run >= 5) score += run - 2; run = 1; }
        }
        if (run >= 5) score += run - 2;
      }
    }

    // 规则 2：2×2 同色块
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // 规则 3：类似定位图形的 1:1:3:1:1 序列
    var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, start) {
      for (var k = 0; k < 11; k++) {
        if (get(start + k) !== P1[k]) break;
        if (k === 10) return true;
      }
      for (var k2 = 0; k2 < 11; k2++) {
        if (get(start + k2) !== P2[k2]) return false;
      }
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c + 11 <= size; c++) {
        (function (rr, cc) {
          if (matches(function (i2) { return m[rr][i2]; }, cc)) score += 40;
          if (matches(function (i2) { return m[i2][rr]; }, cc)) score += 40;
        })(r, c);
      }
    }

    // 规则 4：黑白比例偏离 50%
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  /* ── 主入口 ── */
  function encode(text, options) {
    options = options || {};
    var level = (options.level === 'L') ? 'L' : 'M';

    // 选最小够用的版本
    var version = 0;
    for (var v = 1; v <= 10; v++) {
      var lenBits = v >= 10 ? 16 : 8;
      var need = 4 + lenBits + toUtf8Bytes(text).length * 8;
      if (need <= dataCapacity(v, level) * 8) { version = v; break; }
    }
    if (!version) throw new Error('内容太长，超出版本 10 的容量');

    var size = version * 4 + 17;
    var codewords = interleave(buildCodewords(text, version, level), version, level);

    // 先铺功能图形，记下哪些格子是功能区（掩码不作用于它们）
    var m = makeMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveInfo(m, version);

    var reserved = m.map(function (row) {
      return row.map(function (cell) { return cell !== null; });
    });

    placeData(m, codewords);

    // 选罚分最低的掩码
    var best = null, bestScore = Infinity;
    for (var id = 0; id < 8; id++) {
      var candidate = applyMask(m, reserved, id);
      placeFormat(candidate, level, id);
      placeVersion(candidate, version);
      var s = penalty(candidate);
      if (s < bestScore) { bestScore = s; best = candidate; }
    }

    return best.map(function (row) {
      return row.map(function (cell) { return cell === 1; });
    });
  }

  /* 矩阵 → SVG 字符串（用一条 path，体积小、缩放不糊） */
  function toSVG(text, options) {
    options = options || {};
    var margin = options.margin == null ? 4 : options.margin;
    var px = options.size || 200;
    var matrix = encode(text, options);
    var n = matrix.length;
    var total = n + margin * 2;

    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (matrix[r][c]) d += 'M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z';
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges" role="img">' +
      '<rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#000000"/></svg>';
  }

  global.QRCode = { encode: encode, toSVG: toSVG };

})(typeof window !== 'undefined' ? window : this);
