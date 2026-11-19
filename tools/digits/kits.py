# Numeri di maglia veri dalle foto ufficiali dei giocatori (Lega Pallavolo Serie A):
# per ogni foto si trova il riquadro del numero sul petto (sapendo quante cifre ha) e si
# salvano ritaglio del numero e colore della maglia. Le foto restano locali (non nel repo).
# Uso: python3 kits.py cartella_foto elenco.txt out.npz
import sys, re, numpy as np
from PIL import Image
from scipy import ndimage

def find_number(img, ndig):
    a = np.asarray(img.convert('RGB')).astype(np.int16)
    H, W, _ = a.shape
    # zona del petto
    y0, y1, x0, x1 = int(H * 0.3), int(H * 0.85), int(W * 0.25), int(W * 0.75)
    reg = a[y0:y1, x0:x1]
    # colore dominante della maglia (moda dei colori quantizzati)
    q = (reg // 32).reshape(-1, 3)
    keys, counts = np.unique(q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2], return_counts=True)
    k = keys[np.argmax(counts)]
    shirt = np.array([k // 64, (k // 8) % 8, k % 8]) * 32 + 16
    diff = np.abs(reg - shirt).sum(2)
    best = None
    for thr in (110, 80, 140):
        mask = diff > thr
        lab, n = ndimage.label(mask)
        if n == 0: continue
        objs = ndimage.find_objects(lab)
        comps = []
        for i, sl in enumerate(objs):
            h = sl[0].stop - sl[0].start; w = sl[1].stop - sl[1].start
            area = (lab[sl] == i + 1).sum()
            if not (H * 0.04 < h < H * 0.16): continue
            if w > h * 1.2 or w < h * 0.12: continue
            fill = area / (h * w)
            if fill < 0.15 or fill > 0.85: continue
            col = reg[sl][lab[sl] == i + 1].mean(0)
            # colore della pelle (volto, collo, braccia): non è un numero
            if col[0] > 110 and col[0] > col[1] > col[2] and 25 < col[0] - col[2] < 130 and col[1] - col[2] < 70: continue
            # componente multicolore (logo): poca uniformità del colore
            if reg[sl][lab[sl] == i + 1].std(0).mean() > 42: continue
            comps.append({'y0': sl[0].start, 'y1': sl[0].stop, 'x0': sl[1].start, 'x1': sl[1].stop, 'h': h, 'col': col})
        # gruppi di ndig componenti affiancati, stessa altezza e colore, vicino al centro
        for c in comps:
            grp = [c]
            if ndig == 2:
                cand = [d for d in comps if d is not c and d['x0'] > c['x0'] and d['x0'] - c['x1'] < c['h'] * 0.6 and abs(d['h'] - c['h']) < c['h'] * 0.18 and abs(d['y0'] - c['y0']) < c['h'] * 0.18 and np.abs(d['col'] - c['col']).sum() < 90]
                if len(cand) != 1: continue
                grp.append(cand[0])
            bx0 = min(g['x0'] for g in grp); bx1 = max(g['x1'] for g in grp); by0 = min(g['y0'] for g in grp); by1 = max(g['y1'] for g in grp)
            cx = (bx0 + bx1) / 2 / (x1 - x0)
            cy = (y0 + (by0 + by1) / 2) / H
            # il numero sta sul petto: né sul volto/collo né in fondo alla maglia
            if not (0.42 < cy < 0.8) or abs(cx - 0.5) > 0.3: continue
            # niente altri componenti della stessa altezza accanto (sarebbe una scritta)
            neigh = [d for d in comps if d not in grp and abs(d['h'] - c['h']) < c['h'] * 0.2 and abs(d['y0'] - by0) < c['h'] * 0.3 and (abs(d['x0'] - bx1) < c['h'] * 0.6 or abs(bx0 - d['x1']) < c['h'] * 0.6)]
            if neigh: continue
            score = (by1 - by0) - abs(cx - 0.5) * 60
            if not best or score > best[0]:
                best = (score, (x0 + bx0, y0 + by0, x0 + bx1, y0 + by1), shirt, grp[0]['col'])
        if best: break
    return best

if __name__ == '__main__':
    files = [l.strip() for l in open(sys.argv[2]) if l.strip()]
    out = []
    for f in files:
        num = int(re.search(r'_(\d+)_', f).group(1))
        img = Image.open(f).convert('RGB')
        r = find_number(img, 2 if num >= 10 else 1)
        if not r: continue
        _, (bx0, by0, bx1, by1), shirt, ncol = r
        out.append({'f': f, 'num': num, 'box': [int(bx0), int(by0), int(bx1), int(by1)], 'shirt': [int(v) for v in shirt], 'ncol': [int(v) for v in ncol]})
    import json
    json.dump(out, open(sys.argv[3], 'w'))
    print(len(out), 'numeri trovati su', len(files), 'foto')
