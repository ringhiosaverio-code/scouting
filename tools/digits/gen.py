# Generatore di ritagli sintetici del busto di un giocatore con il numero di maglia,
# per addestrare il riconoscitore dei numeri (tools/digits/train.py).
# Uso: python3 gen.py out.npz N [seed] [cartella_font]
import sys, os, glob, random, io, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

IN_H, IN_W = 40, 32  # dimensione d'ingresso della rete (deve coincidere con js/vision/digitnet.js)

def rand_color(rng, kind=None):
    k = kind or rng.choice(['white', 'dark', 'sat', 'sat', 'light', 'grey'])
    if k == 'white': v = rng.randint(200, 255); return (v - rng.randint(0, 15), v - rng.randint(0, 15), v - rng.randint(0, 10))
    if k == 'dark': return tuple(rng.randint(0, 60) for _ in range(2)) + (rng.randint(10, 110),)
    if k == 'grey': v = rng.randint(90, 190); return (v, v, v + rng.randint(-10, 20))
    if k == 'light': return tuple(rng.randint(150, 255) for _ in range(3))
    import colorsys
    h, s, v = rng.random(), rng.uniform(0.45, 1), rng.uniform(0.35, 1)
    return tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, s, v))

def lum(c): return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]

def contrast_color(rng, shirt):
    for _ in range(30):
        c = rand_color(rng, rng.choice(['white', 'dark', 'sat', 'light']))
        if abs(lum(c) - lum(shirt)) > 70 or (abs(lum(c) - lum(shirt)) > 45 and sum(abs(a - b) for a, b in zip(c, shirt)) > 200): return c
    return (255, 255, 255) if lum(shirt) < 128 else (10, 10, 30)

def render(rng, fonts, words):
    asp = rng.uniform(0.55, 0.95)
    H0 = 200; W0 = int(H0 * asp)
    # sfondo (campo, pubblico, rete)
    bgc = rand_color(rng, rng.choice(['sat', 'grey', 'dark', 'light']))
    img = Image.new('RGB', (W0, H0), bgc)
    d = ImageDraw.Draw(img)
    for _ in range(rng.randint(0, 6)):
        x0, y0 = rng.randint(-50, W0), rng.randint(-50, H0)
        d.rectangle([x0, y0, x0 + rng.randint(5, 120), y0 + rng.randint(3, 80)], fill=rand_color(rng))
    if rng.random() < 0.3:  # rete davanti
        for x in range(rng.randint(0, 8), W0, rng.randint(6, 12)): d.line([x, 0, x, H0], fill=(30, 30, 30), width=1)
        for y in range(rng.randint(0, 8), H0, rng.randint(6, 12)): d.line([0, y, W0, y], fill=(30, 30, 30), width=1)
    # corpo: busto con spalle, testa/collo in alto, braccia ai lati
    shirt = rand_color(rng)
    cx = W0 / 2 + rng.uniform(-0.12, 0.12) * W0
    bw = rng.uniform(0.62, 0.98) * W0
    top = rng.uniform(-0.05, 0.12) * H0
    skin = rng.choice([(224, 172, 140), (190, 140, 105), (140, 95, 65), (95, 65, 45), (235, 200, 175)])
    hair = rng.choice([(20, 15, 10), (60, 40, 25), (120, 90, 50), (200, 170, 110)])
    # testa
    if top > 0 and rng.random() < 0.8:
        hr = rng.uniform(0.18, 0.3) * W0
        d.ellipse([cx - hr, top - 1.6 * hr, cx + hr, top + 0.3 * hr], fill=hair if rng.random() < 0.6 else skin)
    d.polygon([(cx - bw / 2, top + 0.08 * H0), (cx - bw * 0.3, top), (cx + bw * 0.3, top), (cx + bw / 2, top + 0.08 * H0), (cx + bw * 0.46, H0), (cx - bw * 0.46, H0)], fill=shirt)
    # pannelli laterali / maniche di altro colore
    if rng.random() < 0.5:
        pc = rand_color(rng)
        pw = bw * rng.uniform(0.06, 0.18)
        d.rectangle([cx - bw / 2, top + 0.1 * H0, cx - bw / 2 + pw, H0], fill=pc)
        d.rectangle([cx + bw / 2 - pw, top + 0.1 * H0, cx + bw / 2, H0], fill=pc)
    # motivi sublimati (macchie, strisce) come le maglie moderne
    for _ in range(rng.choice([0, 0, 3, 8, 20])):
        c = rand_color(rng)
        x, y, r = rng.uniform(cx - bw / 2, cx + bw / 2), rng.uniform(top, H0), rng.uniform(1, 9)
        if rng.random() < 0.5: d.ellipse([x - r, y - r, x + r, y + r], fill=c)
        else: d.line([x, y, x + rng.uniform(-25, 25), y + rng.uniform(-25, 25)], fill=c, width=int(rng.uniform(1, 4)))
    # sponsor (scritte piccole)
    for _ in range(rng.randint(0, 4)):
        f = ImageFont.truetype(rng.choice(fonts), rng.randint(8, 18))
        d.text((rng.uniform(cx - bw / 2, cx + bw / 4), rng.uniform(top + 0.55 * H0, H0 - 10)), rng.choice(words), fill=contrast_color(rng, shirt) if rng.random() < 0.6 else rand_color(rng), font=f)
    # numero
    r = rng.random()
    if r < 0.42: num = rng.randint(1, 9)
    elif r < 0.92: num = rng.randint(10, 25)
    else: num = rng.randint(26, 99)
    label = num
    neg = rng.random() < 0.28
    front = rng.random() < 0.12
    ncol = contrast_color(rng, shirt)
    hfrac = 1
    if not neg:
        fnt = ImageFont.truetype(rng.choice(fonts), 160)
        s = str(num)
        tb = fnt.getbbox(s)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        layer = Image.new('RGBA', (tw + 40, th + 40), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        stroke = rng.choice([0, 0, 0, 3, 6]) if not front else 0
        ld.text((20 - tb[0], 20 - tb[1]), s, font=fnt, fill=ncol + (255,), stroke_width=stroke, stroke_fill=(contrast_color(rng, ncol) if stroke else None))
        # altezza del numero rispetto al ritaglio
        hfrac = rng.uniform(0.12, 0.2) if front else rng.uniform(0.2, 0.46)
        k = hfrac * H0 / th
        sx = rng.uniform(0.45, 1.05)  # corpo girato: numero schiacciato
        if sx < 0.6 and rng.random() < 0.5: label = None  # troppo di lato: non leggibile
        nw, nh = max(2, int(layer.width * k * sx)), max(2, int(layer.height * k))
        layer = layer.resize((nw, nh), Image.BICUBIC)
        layer = layer.rotate(rng.uniform(-11, 11), resample=Image.BICUBIC, expand=True)
        if rng.random() < 0.5:  # taglio obliquo
            sh = rng.uniform(-0.18, 0.18)
            layer = layer.transform(layer.size, Image.AFFINE, (1, sh, -sh * layer.height / 2, 0, 1, 0), resample=Image.BICUBIC)
        nx = cx + rng.uniform(-0.12, 0.12) * W0 + (rng.uniform(-0.2, 0.2) * bw if front else 0)
        ny = top + (rng.uniform(0.22, 0.32) if front else rng.uniform(0.3, 0.52)) * H0
        # nome sopra il numero
        if not front and rng.random() < 0.5:
            f = ImageFont.truetype(rng.choice(fonts), rng.randint(9, 16))
            name = rng.choice(words).upper()
            d.text((nx - len(name) * 3.5, ny - nh / 2 - 22), name, fill=ncol, font=f)
        img.paste(layer, (int(nx - layer.width / 2), int(ny - layer.height / 2)), layer)
        # numero tagliato dal bordo del ritaglio: non leggibile
        if nx - layer.width * 0.25 < 0 or nx + layer.width * 0.25 > W0 or ny - nh * 0.3 < 0: label = None
    else:
        label = None
    # braccio davanti (occlusione)
    if rng.random() < 0.18:
        side = rng.choice([-1, 1])
        x = cx + side * rng.uniform(0.1, 0.45) * bw
        d.line([x, rng.uniform(0, 0.3) * H0, x + rng.uniform(-30, 30), H0], fill=skin if rng.random() < 0.7 else shirt, width=int(rng.uniform(0.1, 0.22) * W0))
    # luce e pieghe
    a = np.asarray(img).astype(np.float32)
    yy, xx = np.mgrid[0:H0, 0:W0]
    g = 1 + rng.uniform(-0.25, 0.25) * (xx / W0 - 0.5) + rng.uniform(-0.25, 0.25) * (yy / H0 - 0.5)
    for _ in range(rng.randint(0, 3)):
        g += rng.uniform(0.03, 0.12) * np.sin(xx * rng.uniform(0.02, 0.12) + yy * rng.uniform(-0.05, 0.05) + rng.uniform(0, 6))
    a = np.clip(a * g[..., None] * rng.uniform(0.6, 1.25) + rng.uniform(-20, 20), 0, 255)
    img = Image.fromarray(a.astype(np.uint8))
    # degradazione: risoluzione reale del giocatore nel video, sfocatura, compressione
    hs = int(rng.choice([rng.uniform(16, 40), rng.uniform(30, 80), rng.uniform(60, 140)]))
    ws = max(6, int(hs * W0 / H0))
    # cifre troppo piccole nell'immagine reale: illeggibili anche per una persona
    if label is not None and not neg and hfrac * hs < 6.5: label = None
    img = img.resize((ws, hs), Image.BILINEAR if rng.random() < 0.5 else Image.BOX)
    if rng.random() < 0.6: img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.1)))
    if rng.random() < 0.3:  # mosso
        k = rng.randint(2, 4)
        a = np.asarray(img).astype(np.float32)
        if rng.random() < 0.5: a = sum(np.roll(a, i, axis=1) for i in range(k)) / k
        else: a = sum(np.roll(a, i, axis=0) for i in range(k)) / k
        img = Image.fromarray(a.astype(np.uint8))
    if rng.random() < 0.85:
        buf = io.BytesIO(); img.save(buf, 'JPEG', quality=rng.randint(20, 85)); img = Image.open(buf).convert('RGB')
    a = np.asarray(img).astype(np.float32) + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(0, 7), (hs, ws, 3))
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    img = img.resize((IN_W, IN_H), Image.BILINEAR)
    return np.asarray(img), label

def encode(label):
    # decine: 0 = nessuna, 1..10 = cifra 0..9; unità: 0..9, 10 = nessun numero leggibile
    if label is None: return 0, 10
    return (0 if label < 10 else label // 10 + 1), label % 10

def work(args):
    n, seed, fonts, words = args
    rng = random.Random(seed)
    X = np.zeros((n, IN_H, IN_W, 3), np.uint8); T = np.zeros(n, np.int8); U = np.zeros(n, np.int8)
    for i in range(n):
        x, lab = render(rng, fonts, words)
        X[i] = x; T[i], U[i] = encode(lab)
    return X, T, U

if __name__ == '__main__':
    out, N = sys.argv[1], int(sys.argv[2])
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    fdir = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(__file__), 'fonts')
    fonts = sorted(glob.glob(os.path.join(fdir, '*.woff')) + glob.glob(os.path.join(fdir, '*.ttf')))
    fonts += [f for f in glob.glob('/usr/share/fonts/**/*Bold*.ttf', recursive=True) if 'Mono' not in f]
    words = ['MARTINI', 'ROSSI', 'BIANCHI', 'ENERGY', 'VOLLEY', 'SPORT', 'BANCA', 'GROUP', 'srl', 'TECH', 'ITALIA', 'MILANO', 'FANO', 'CATTANEO', 'PALEY', 'MECCAL', 'essence', 'Credem', 'AUTO', 'HOTEL']
    from multiprocessing import Pool
    P = os.cpu_count() or 2
    parts = Pool(P).map(work, [(N // P + (1 if k < N % P else 0), seed * 1000 + k, fonts, words) for k in range(P)])
    X = np.concatenate([p[0] for p in parts]); T = np.concatenate([p[1] for p in parts]); U = np.concatenate([p[2] for p in parts])
    np.savez_compressed(out, X=X, T=T, U=U)
    print(out, X.shape, 'senza numero', int((U == 10).sum()), 'font', len(fonts))
