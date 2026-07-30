#!/usr/bin/env python3
"""
生成 PWA 图标（构建期工具，不参与运行时）。

    python3 tools/make-icons.py

产出 icons/ 下的 PNG。只用 Python 3 标准库（zlib + struct 手写 PNG），
不需要 pip install，也不需要 rsvg / inkscape / sharp —— 换台电脑照样能跑。

想改配色或形状，改下面 CONFIG 里的数值即可；
tools/icon.svg 是同一套参数的矢量版，给设计师改图时用。
"""

import math
import os
import struct
import zlib

# ── 可调参数 ────────────────────────────────────────────────
CONFIG = {
    # 背景色（品牌蓝，与 cecp.js 的浅色主题强调色一致）
    "bg": (0x0A, 0x6C, 0xF5, 0xFF),
    # 前景（话筒）颜色
    "fg": (0xFF, 0xFF, 0xFF, 0xFF),
    # 圆角半径（相对边长，0.5 = 正圆）
    "radius": 0.22,
    # 超采样倍数，越大边缘越平滑、越慢
    "ss": 4,
}

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# 要生成的图：(文件名, 边长, 是否 maskable)
# maskable 版本会被安卓裁成圆形等形状，图形要缩进「安全区」，所以整体缩小。
TARGETS = [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-512.png", 512, True),
    ("apple-touch-icon.png", 180, False),
]


# ── 形状：全部用「点到形状的距离」判断，配合超采样得到抗锯齿 ──

def rounded_rect(x, y, x0, y0, x1, y1, r):
    """点 (x,y) 是否在圆角矩形内。"""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 + r <= x <= x1 - r or y0 + r <= y <= y1 - r:
        return x0 <= x <= x1 and y0 <= y <= y1
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def capsule(x, y, cx, y0, y1, half_w):
    """竖直胶囊（话筒头）。"""
    if y0 <= y <= y1:
        return abs(x - cx) <= half_w
    ny = y0 if y < y0 else y1
    return (x - cx) ** 2 + (y - ny) ** 2 <= half_w * half_w


def lower_arc(x, y, cx, cy, r_out, r_in):
    """下半圆环（话筒的托架）。"""
    if y < cy:
        return False
    d2 = (x - cx) ** 2 + (y - cy) ** 2
    return r_in * r_in <= d2 <= r_out * r_out


def glyph(x, y):
    """话筒图形：胶囊 + 下半环托架 + 立杆 + 底座。坐标是 0..1 单位空间。"""
    return (
        capsule(x, y, 0.5, 0.20, 0.52, 0.105)
        or lower_arc(x, y, 0.5, 0.47, 0.225, 0.185)
        or rounded_rect(x, y, 0.485, 0.690, 0.515, 0.780, 0.015)
        or rounded_rect(x, y, 0.375, 0.775, 0.625, 0.818, 0.021)
    )


def render(size, maskable):
    bg, fg = CONFIG["bg"], CONFIG["fg"]
    ss = CONFIG["ss"]
    radius = CONFIG["radius"]

    # maskable：安卓可能裁成圆形，图形缩进到中心 ~72%，背景铺满
    scale = 0.72 if maskable else 1.0

    rows = []
    inv = 1.0 / (size * ss)
    samples = ss * ss

    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg_hits = 0
            fg_hits = 0
            for sy in range(ss):
                for sx in range(ss):
                    ux = (px * ss + sx + 0.5) * inv
                    uy = (py * ss + sy + 0.5) * inv

                    # 背景（圆角方块）；maskable 时铺满整张，不做圆角
                    if maskable or rounded_rect(ux, uy, 0.0, 0.0, 1.0, 1.0, radius):
                        bg_hits += 1

                    # 前景：把坐标按 scale 映射回 0..1 再判断
                    gx = (ux - 0.5) / scale + 0.5
                    gy = (uy - 0.5) / scale + 0.5
                    if 0.0 <= gx <= 1.0 and 0.0 <= gy <= 1.0 and glyph(gx, gy):
                        fg_hits += 1

            bg_a = bg_hits / samples
            fg_a = fg_hits / samples

            # 前景压在背景上，再整体乘背景的覆盖率（圆角边缘透明）
            r = bg[0] * (1 - fg_a) + fg[0] * fg_a
            g = bg[1] * (1 - fg_a) + fg[1] * fg_a
            b = bg[2] * (1 - fg_a) + fg[2] * fg_a
            a = 255 * bg_a

            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a + 0.5)))
        rows.append(row)

    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, size, maskable in TARGETS:
        path = os.path.join(OUT_DIR, name)
        write_png(path, size, render(size, maskable))
        print("生成 %-26s %4dx%-4d %6.1f KB" % (name, size, size, os.path.getsize(path) / 1024))
    print("\n输出目录：%s" % OUT_DIR)


if __name__ == "__main__":
    main()
