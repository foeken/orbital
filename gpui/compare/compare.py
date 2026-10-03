#!/usr/bin/env python3
"""compare.sh's numbers: the GPUI capture taken to sRGB (screencapture tags it with the display's profile, which shifts
every grey; Chromium's capture is plain sRGB), an overlay (web page in red, GPUI in cyan: any fringe is a difference),
how much ink the same words take in each (1.000: the same weight), and how many pixels differ under the header."""
import io, sys
from PIL import Image, ImageChops, ImageCms

theme, out = sys.argv[1], sys.argv[2]
a = Image.open(f'{out}/web-{theme}.png').convert('RGB')
b = Image.open(f'{out}/gpui-{theme}.png')
if b.info.get('icc_profile'):
    display = ImageCms.ImageCmsProfile(io.BytesIO(b.info['icc_profile']))
    b = ImageCms.profileToProfile(b.convert('RGB'), display, ImageCms.createProfile('sRGB'), outputMode='RGB')
b = b.convert('RGB').resize(a.size)
b.save(f'{out}/gpui-{theme}-srgb.png')
A, B = a.convert('L'), b.convert('L')
Image.merge('RGB', (A, B, B)).save(f'{out}/overlay-{theme}.png')
side = Image.new('RGB', (a.size[0] * 2 + 8, a.size[1]), (255, 0, 0))
side.paste(a, (0, 0)); side.paste(b, (a.size[0] + 8, 0))
side.save(f'{out}/side-{theme}.png')

def ink(img, box):
    return sum(255 - p for p in img.crop(box).getdata())

words = {'15px row': (192, 250, 625, 272), '16px entry': (140, 168, 250, 190), '14px grey line': (192, 229, 392, 246), 'title': (30, 58, 165, 95)}
print('ink, GPUI / web:', ', '.join(f'{k} {ink(B, box) / ink(A, box):.3f}' for k, box in words.items()))
diff = ImageChops.difference(A, B).crop((0, 40, a.size[0], a.size[1])).point(lambda v: 255 if v > 40 else 0)
print('pixels differing under the header:', diff.histogram()[255], f'(of {a.size[0] * (a.size[1] - 40)})')
