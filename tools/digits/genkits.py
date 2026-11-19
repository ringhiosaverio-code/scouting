# Esempi di addestramento dalle maglie vere (foto ufficiali, tools/digits/kits.py):
# il numero della maglia viene inquadrato come in un ritaglio di partita (scala, spostamento,
# rotazione, corpo girato) e degradato come nel video (risoluzione, sfocatura, mosso,
# compressione). Si aggiungono esempi senza numero (altre zone della stessa maglia).
# Uso: python3 genkits.py kits_ok.json out.npz N [seed]
import sys, json, random, io
import numpy as np
from PIL import Image, ImageFilter

IN_H, IN_W = 40, 32

def degrade(rng, img, hfrac):
    hs = int(rng.choice([rng.uniform(16, 40), rng.uniform(30, 80), rng.uniform(60, 140)]))
    ws = max(6, int(hs * img.width / img.height))
    small = hfrac * hs < 6.5
    img = img.resize((ws, hs), Image.BILINEAR if rng.random() < 0.5 else Image.BOX)
    if rng.random() < 0.6: img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.1)))
    if rng.random() < 0.3:
        k = rng.randint(2, 4); a = np.asarray(img).astype(np.float32)
        a = sum(np.roll(a, i, axis=1 if rng.random() < 0.5 else 0) for i in range(k)) / k
        img = Image.fromarray(a.astype(np.uint8))
    if rng.random() < 0.85:
        buf = io.BytesIO(); img.save(buf, 'JPEG', quality=rng.randint(20, 85)); img = Image.open(buf).convert('RGB')
    a = np.asarray(img).astype(np.float32)
    a = a * rng.uniform(0.6, 1.2) + rng.uniform(-25, 20) + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(0, 7), a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).resize((IN_W, IN_H), Image.BILINEAR), small

def sample(rng, e, photos):
    img = photos[e['f']]
    x0, y0, x1, y1 = e['box']; bh = y1 - y0; cxn, cyn = (x0 + x1) / 2, (y0 + y1) / 2
    neg = rng.random() < 0.25
    hfrac = rng.uniform(0.25, 0.46)
    ch = bh / hfrac; cw = ch * rng.uniform(0.55, 0.95)
    if neg:
        # stessa maglia senza numero: zona sopra o sotto il numero, o numero tagliato dal bordo
        kind = rng.choice(['up', 'down', 'cut'])
        if kind == 'up': cy = y0 - ch * rng.uniform(0.55, 0.8); cx = cxn + rng.uniform(-0.2, 0.2) * cw
        elif kind == 'down': cy = y1 + ch * rng.uniform(0.55, 0.8); cx = cxn + rng.uniform(-0.2, 0.2) * cw
        else: cy = cyn; cx = cxn + rng.choice([-1, 1]) * cw * rng.uniform(0.62, 0.8)
    else:
        cx = cxn + rng.uniform(-0.12, 0.12) * cw; cy = cyn + rng.uniform(-0.1, 0.1) * ch
    ang = rng.uniform(-9, 9)
    big = img.rotate(ang, center=(cxn, cyn), resample=Image.BICUBIC, fillcolor=tuple(e['shirt']))
    crop = big.crop((int(cx - cw / 2), int(cy - ch / 2), int(cx + cw / 2), int(cy + ch / 2)))
    # corpo girato: numero schiacciato in orizzontale
    sx = rng.uniform(0.5, 1.0)
    if sx < 0.95:
        inner = crop.resize((max(4, int(crop.width * sx)), crop.height), Image.BICUBIC)
        bgc = tuple(int(v) for v in np.asarray(crop).reshape(-1, 3)[0])
        canvas = Image.new('RGB', crop.size, bgc)
        canvas.paste(inner, ((crop.width - inner.width) // 2, 0)); crop = canvas
    out, small = degrade(rng, crop, hfrac)
    label = None if neg or small or (sx < 0.6 and rng.random() < 0.5) else e['num']
    return np.asarray(out), label

def encode(label):
    if label is None: return 0, 10
    return (0 if label < 10 else label // 10 + 1), label % 10

if __name__ == '__main__':
    K = json.load(open(sys.argv[1])); out = sys.argv[2]; N = int(sys.argv[3]); seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    rng = random.Random(seed)
    photos = {e['f']: Image.open(e['f']).convert('RGB') for e in K}
    X = np.zeros((N, IN_H, IN_W, 3), np.uint8); T = np.zeros(N, np.int8); U = np.zeros(N, np.int8)
    for i in range(N):
        x, lab = sample(rng, rng.choice(K), photos)
        X[i] = x; T[i], U[i] = encode(lab)
    np.savez_compressed(out, X=X, T=T, U=U)
    print(out, X.shape, 'senza numero', int((U == 10).sum()))
