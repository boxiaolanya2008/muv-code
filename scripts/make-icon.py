from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'build'
scale = 4
image = Image.new('RGBA', (512 * scale, 512 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((32, 32, 2016, 2016), radius=448, fill='#fbfbf8')
mask = Image.new('L', image.size)
pen = ImageDraw.Draw(mask)
points = [(128, 352), (128, 182), (256, 300), (384, 182), (384, 352)]
points = [(x * scale, y * scale) for x, y in points]
pen.line(points, fill=255, width=60 * scale, joint='curve')
for x, y in points:
    pen.ellipse((x - 30 * scale, y - 30 * scale, x + 30 * scale, y + 30 * scale), fill=255)
ink = Image.new('RGBA', image.size)
pixels = ink.load()
for y in range(image.height):
    for x in range(image.width):
        blend = max(0, min(1, (x / scale - y / scale + 310) / 620))
        pixels[x, y] = tuple(round(a + (b - a) * blend) for a, b in zip((38, 121, 87), (100, 185, 146))) + (255,)
image.paste(ink, (0, 0), mask)
image = image.resize((512, 512), Image.Resampling.LANCZOS)
for size in (512, 192, 96):
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / f'icon-{size}.png')
image.save(root / 'icon.ico', sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
