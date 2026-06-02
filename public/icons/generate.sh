#!/bin/bash
# Gera ícones PNG a partir de SVG usando ImageMagick ou Python
python3 - <<'EOF'
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs('.', exist_ok=True)

for size in [192, 512]:
    img = Image.new('RGB', (size, size), color='#0a0a0a')
    draw = ImageDraw.Draw(img)
    # Purple circle
    margin = size // 8
    draw.ellipse([margin, margin, size-margin, size-margin], fill='#7c6af7')
    # Letter P
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size // 2)
    except:
        font = ImageFont.load_default()
    text = "P"
    bbox = draw.textbbox((0,0), text, font=font)
    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
    draw.text(((size-tw)//2, (size-th)//2 - size//16), text, fill='white', font=font)
    img.save(f'icon-{size}.png')
    print(f"Created icon-{size}.png")

EOF
