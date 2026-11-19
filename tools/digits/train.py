# Addestramento del riconoscitore dei numeri di maglia (rete convoluzionale piccola, JAX).
# Ingresso: ritaglio del busto 40x32 RGB normalizzato; uscite: decina (nessuna/0-9) e
# unità (0-9 / nessun numero leggibile). Esporta i pesi per js/vision/digitnet.js.
# Uso: python3 train.py data_dir out_dir [real_val.npz] [epoche]
import sys, glob, json, time, math
import numpy as np
import jax, jax.numpy as jnp
import optax

IN_H, IN_W = 40, 32
ARCH = [('conv', 3, 32), ('conv', 32, 32), ('pool',), ('conv', 32, 64), ('conv', 64, 64), ('pool',), ('conv', 64, 128), ('pool',), ('fc', 5 * 4 * 128, 256), ('heads', 256)]

def norm_input(x):
    # normalizzazione per ritaglio (luminosità/contrasto): identica in digitnet.js
    x = x.astype(np.float32) / 255.0
    m = x.mean(axis=(1, 2, 3), keepdims=True); s = x.std(axis=(1, 2, 3), keepdims=True) + 0.05
    return (x - m) / s

def init(key):
    p = {}
    for i, l in enumerate(ARCH):
        key, k1 = jax.random.split(key)
        if l[0] == 'conv':
            p[f'c{i}w'] = jax.random.normal(k1, (3, 3, l[1], l[2])) * math.sqrt(2 / (9 * l[1])); p[f'c{i}b'] = jnp.zeros(l[2])
            p[f'n{i}g'] = jnp.ones(l[2]); p[f'n{i}b'] = jnp.zeros(l[2])
        elif l[0] == 'fc':
            p[f'f{i}w'] = jax.random.normal(k1, (l[1], l[2])) * math.sqrt(2 / l[1]); p[f'f{i}b'] = jnp.zeros(l[2])
        elif l[0] == 'heads':
            k1, k2 = jax.random.split(k1)
            p['tw'] = jax.random.normal(k1, (l[1], 11)) * math.sqrt(1 / l[1]); p['tb'] = jnp.zeros(11)
            p['uw'] = jax.random.normal(k2, (l[1], 11)) * math.sqrt(1 / l[1]); p['ub'] = jnp.zeros(11)
    return p

def init_stats():
    return {f'{i}': (jnp.zeros(l[2]), jnp.ones(l[2])) for i, l in enumerate(ARCH) if l[0] == 'conv'}

def forward(p, x, train=False, key=None, stats=None, new_stats=None):
    # normalizzazione per lotti: in addestramento statistiche del lotto (raccolte in new_stats),
    # in uso medie mobili (stats); all'esportazione viene fusa nei pesi della convoluzione
    h = x
    for i, l in enumerate(ARCH):
        if l[0] == 'conv':
            h = jax.lax.conv_general_dilated(h, p[f'c{i}w'], (1, 1), 'SAME', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + p[f'c{i}b']
            if f'n{i}g' in p:
                if train:
                    m = h.mean((0, 1, 2)); v = h.var((0, 1, 2))
                    if new_stats is not None: new_stats[f'{i}'] = (m, v)
                elif stats is not None: m, v = stats[f'{i}']
                else: m, v = jnp.zeros(l[2]), jnp.ones(l[2])
                h = (h - m) / jnp.sqrt(v + 1e-5) * p[f'n{i}g'] + p[f'n{i}b']
            h = jax.nn.relu(h)
        elif l[0] == 'pool':
            h = jax.lax.reduce_window(h, -jnp.inf, jax.lax.max, (1, 2, 2, 1), (1, 2, 2, 1), 'VALID')
        elif l[0] == 'fc':
            h = h.reshape(h.shape[0], -1)
            if train: key, k = jax.random.split(key); h = h * jax.random.bernoulli(k, 0.8, h.shape) / 0.8
            h = jax.nn.relu(h @ p[f'f{i}w'] + p[f'f{i}b'])
            if train: key, k = jax.random.split(key); h = h * jax.random.bernoulli(k, 0.7, h.shape) / 0.7
    return h @ p['tw'] + p['tb'], h @ p['uw'] + p['ub']

def loss_fn(p, x, t, u, key):
    ns = {}
    lt, lu = forward(p, x, True, key, new_stats=ns)
    ce = lambda l, y: -jnp.mean(jnp.take_along_axis(jax.nn.log_softmax(l), y[:, None], 1))
    return ce(lt, t) + ce(lu, u), ns

def fold(p, stats):
    # pesi per il browser: normalizzazione fusa nella convoluzione (nessuno strato in più in JS)
    q = {}
    for i, l in enumerate(ARCH):
        if l[0] == 'conv':
            m, v = stats[f'{i}']; k = p[f'n{i}g'] / jnp.sqrt(v + 1e-5)
            q[f'c{i}w'] = p[f'c{i}w'] * k; q[f'c{i}b'] = (p[f'c{i}b'] - m) * k + p[f'n{i}b']
        elif l[0] == 'fc':
            q[f'f{i}w'] = p[f'f{i}w']; q[f'f{i}b'] = p[f'f{i}b']
    for k in ('tw', 'tb', 'uw', 'ub'): q[k] = p[k]
    return q

def augment(rng, X):
    # piccoli spostamenti e specchiature di colore (le cifre non si specchiano!)
    n = len(X); out = np.empty_like(X)
    for i in range(n):
        dx, dy = rng.integers(-2, 3), rng.integers(-2, 3)
        out[i] = np.roll(np.roll(X[i], dy, 0), dx, 1)
        if rng.random() < 0.3: out[i] = out[i][..., rng.permutation(3)]
        if rng.random() < 0.15: out[i] = 255 - out[i]
    return out

def decode(lt, lu):
    t = np.argmax(lt, 1); u = np.argmax(lu, 1)
    pt = jax.nn.softmax(lt); pu = jax.nn.softmax(lu)
    conf = np.asarray(jnp.max(pt, 1) * jnp.max(pu, 1))
    num = np.where(u == 10, -1, np.where(t == 0, u, (t - 1) * 10 + u))
    return num, conf

def evaluate(p, X, num_true, fwd):
    num, conf = [], []
    for i in range(0, len(X), 512):
        a, b = fwd(p, jnp.asarray(norm_input(X[i:i + 512]))); n, c = decode(np.asarray(a), np.asarray(b)); num.append(n); conf.append(c)
    num = np.concatenate(num); conf = np.concatenate(conf)
    return num, conf

def report(name, num, conf, truth, thr=0.6):
    pos = truth >= 0
    dec = (num >= 0) & (conf >= thr)
    ok = (dec & pos & (num == truth)).sum(); wrong = (dec & pos & (num != truth)).sum(); fp = (dec & ~pos).sum()
    print(f'  {name} (soglia {thr}): leggibili {pos.sum()}: giusti {ok} ({100 * ok / max(1, pos.sum()):.0f}%), sbagliati {wrong}, non decisi {pos.sum() - ok - wrong} | non leggibili {(~pos).sum()}: numero inventato {fp}')

if __name__ == '__main__':
    ddir, odir = sys.argv[1], sys.argv[2]
    real = np.load(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != '-' else None
    epochs = int(sys.argv[4]) if len(sys.argv) > 4 else 6
    files = sorted(glob.glob(ddir + '/part*.npz') + glob.glob(ddir + '/kit*.npz'))
    data = [np.load(f) for f in files]
    X = np.concatenate([d['X'] for d in data]); T = np.concatenate([d['T'] for d in data]).astype(np.int32); U = np.concatenate([d['U'] for d in data]).astype(np.int32)
    nval = 4000
    perm0 = np.random.default_rng(0).permutation(len(X))
    X, T, U = X[perm0], T[perm0], U[perm0]
    Xv, Tv, Uv = X[:nval], T[:nval], U[:nval]; X, T, U = X[nval:], T[nval:], U[nval:]
    truth_v = np.where(Uv == 10, -1, np.where(Tv == 0, Uv, (Tv - 1) * 10 + Uv))
    print('campioni', len(X), 'validazione sintetica', nval)
    key = jax.random.PRNGKey(0)
    p = init(key)
    bs = 256
    steps = epochs * (len(X) // bs)
    import os, pickle
    init_ck = os.environ.get('INIT')  # rifinitura: si parte dai pesi di un addestramento precedente
    peak = 7e-4 if init_ck else 2e-3
    sched = optax.warmup_cosine_decay_schedule(0, peak, min(500, steps // 5), steps, 2e-5)
    opt = optax.chain(optax.clip_by_global_norm(2.0), optax.adamw(sched, weight_decay=1e-4))
    if init_ck:
        d0 = pickle.load(open(init_ck, 'rb')); p = d0['p']
        print('pesi iniziali da', init_ck, flush=True)
    st = opt.init(p)
    fwd = jax.jit(lambda p, x: forward(p, x))
    stats = init_stats() if not init_ck else d0['stats']
    @jax.jit
    def step(p, st, stats, x, t, u, key):
        (l, ns), g = jax.value_and_grad(loss_fn, has_aux=True)(p, x, t, u, key)
        up, st = opt.update(g, st, p)
        stats = {k: (0.95 * stats[k][0] + 0.05 * ns[k][0], 0.95 * stats[k][1] + 0.05 * ns[k][1]) for k in stats}
        return optax.apply_updates(p, up), st, stats, l
    rng = np.random.default_rng(1)
    t0 = time.time(); it = 0
    # ripresa da un salvataggio (l'addestramento può essere interrotto)
    import pickle, os
    ck = odir + '/checkpoint.pkl'
    ep0, b0 = 0, 0
    if os.path.exists(ck):
        d = pickle.load(open(ck, 'rb')); p, st, stats = d['p'], d['st'], d['stats']
        ep0, b0 = (d['ep'], d['b']) if d.get('b') else (d['ep'] + 1, 0)
        print('ripresa dall\'epoca', ep0 + 1, 'passo', b0, flush=True)
    for ep in range(ep0, epochs):
        # ordine dei campioni deterministico per epoca (serve a riprendere a metà)
        rng = np.random.default_rng(1000 + ep)
        perm = rng.permutation(len(X)); tot = 0
        for b in range(b0 if ep == ep0 else 0, len(X) // bs):
            if b and b % 300 == 0:  # salvataggio intermedio
                pickle.dump({'p': p, 'st': st, 'stats': stats, 'ep': ep, 'b': b}, open(ck + '.tmp', 'wb')); os.replace(ck + '.tmp', ck)
            idx = perm[b * bs:(b + 1) * bs]
            xb = norm_input(augment(rng, X[idx]))
            key, k = jax.random.split(key)
            p, st, stats, l = step(p, st, stats, jnp.asarray(xb), jnp.asarray(T[idx]), jnp.asarray(U[idx]), k)
            tot += float(l); it += 1
            if b % 150 == 0: print(f'epoca {ep + 1} passo {b} perdita {tot / (b - (b0 if ep == ep0 else 0) + 1):.3f} ({time.time() - t0:.0f} s)', flush=True)
        pf = fold(p, stats)
        num, conf = evaluate(pf, Xv, truth_v, fwd)
        print(f'== epoca {ep + 1}: perdita {tot / (len(X) // bs):.3f}')
        report('sintetico', num, conf, truth_v)
        if real is not None:
            num, conf = evaluate(pf, real['X'], real['num'], fwd)
            for thr in (0.5, 0.7, 0.85): report('REALE Fano', num, conf, real['num'], thr)
        # esportazione dei pesi (float32, ordine fisso) per il browser
        names = sorted(pf.keys())
        flat = np.concatenate([np.asarray(pf[k], np.float32).ravel() for k in names])
        meta = {'in': [IN_H, IN_W], 'arch': [list(l) for l in ARCH], 'tensors': [[k, list(np.asarray(pf[k]).shape)] for k in names]}
        flat.astype(np.float16).tofile(odir + '/digitnet.f16')
        json.dump(meta, open(odir + '/digitnet.json', 'w'))
        pickle.dump({'p': p, 'st': st, 'stats': stats, 'ep': ep, 'b': 0}, open(ck + '.tmp', 'wb')); os.replace(ck + '.tmp', ck)
        print('  pesi salvati', flat.size, 'parametri', flush=True)
