"""生成扩展图标：渐变圆角方块 + 白色「译」字"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

FONT_PATH = "C:/Windows/Fonts/msyhbd.ttc"
C1 = (77, 107, 254)   # #4D6BFE
C2 = (139, 92, 246)   # #8B5CF6
SS = 4                # 超采样倍数


def make(size: int) -> Image.Image:
    S = size * SS
    grad = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / max(1, S - 1)
        # 斜向渐变：横向也混一点
        c = tuple(int(C1[i] + (C2[i] - C1[i]) * t) for i in range(3))
        d.line([(0, y), (S, y)], fill=c)

    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.235), fill=255)

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    # 白色「译」字
    font_size = int(S * 0.53)
    font = ImageFont.truetype(FONT_PATH, font_size)
    d2 = ImageDraw.Draw(img)
    ch = "译"
    bbox = d2.textbbox((0, 0), ch, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (S - w) / 2 - bbox[0]
    y = (S - h) / 2 - bbox[1] - S * 0.005
    d2.text((x, y), ch, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


for sz in (16, 32, 48, 128, 256):
    im = make(sz)
    path = os.path.join(OUT, f"icon{sz}.png")
    im.save(path, "PNG")
    print("wrote", path, im.size)
