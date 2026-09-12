"""把生成的图标外围白边抠成透明，并输出 electron-builder 需要的尺寸。
作者：陕耀云栈WorkMate
"""

import sys
from collections import deque

from PIL import Image

src = sys.argv[1]
dst = sys.argv[2]

image = Image.open(src).convert("RGBA")
width, height = image.size
pixels = image.load()

# 从四角泛洪，把连通的近白色区域清成透明；圆角内部的深色背景不受影响
visited = set()
queue = deque()
for corner in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
    queue.append(corner)

THRESHOLD = 225

while queue:
    x, y = queue.popleft()
    if (x, y) in visited:
        continue
    if not (0 <= x < width and 0 <= y < height):
        continue
    r, g, b, a = pixels[x, y]
    if r < THRESHOLD or g < THRESHOLD or b < THRESHOLD:
        continue
    visited.add((x, y))
    pixels[x, y] = (r, g, b, 0)
    queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

# 裁掉透明边距后缩放为正方形
bbox = image.getbbox()
if bbox:
    image = image.crop(bbox)

size = max(image.size)
canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
canvas.paste(image, ((size - image.width) // 2, (size - image.height) // 2))
canvas.resize((512, 512), Image.LANCZOS).save(dst)

print(f"OK {dst} 512x512，抠除 {len(visited)} 个白边像素")
