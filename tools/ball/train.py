# Addestramento del riconoscitore della palla (rete piccola sui ritagli 12x12, colori + movimento).
# Uso: python3 train.py out_dir dati1.npz [dati2.npz ...] [--val dati_val.npz]
import sys, json, math, numpy as np, jax, jax.numpy as jnp, optax

def load(fs):
    xs, ys, ms = [], [], []
    for f in fs:
        z = np.load(f); xs.append(z['x'].astype(np.float32)); ys.append(z['y'].astype(np.float32)); ms.append(z['m'].astype(np.float32))
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(ms)

def norm_m(m):  # area (log), sulla sagoma, colore del pallone
    return np.stack([np.log1p(m[:, 0]) / 4, m[:, 1], m[:, 2]], 1).astype(np.float32)

C1, C2, F = 12, 24, 32
def init(key):
    k = jax.random.split(key, 4)
    return {'c1w': jax.random.normal(k[0], (3, 3, 5, C1)) * math.sqrt(2 / 45), 'c1b': jnp.zeros(C1),
            'c2w': jax.random.normal(k[1], (3, 3, C1, C2)) * math.sqrt(2 / (9 * C1)), 'c2b': jnp.zeros(C2),
            'fw': jax.random.normal(k[2], (3 * 3 * C2 + 3, F)) * math.sqrt(2 / (9 * C2 + 3)), 'fb': jnp.zeros(F),
            'ow': jax.random.normal(k[3], (F,)) * math.sqrt(1 / F), 'ob': jnp.zeros(1)}

def fwd(p, x, m):
    conv = lambda h, w, b: jax.nn.relu(jax.lax.conv_general_dilated(h, w, (1, 1), 'SAME', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + b)
    pool = lambda h: jax.lax.reduce_window(h, -jnp.inf, jax.lax.max, (1, 2, 2, 1), (1, 2, 2, 1), 'VALID')
    h = pool(conv(x, p['c1w'], p['c1b'])); h = pool(conv(h, p['c2w'], p['c2b']))
    h = jnp.concatenate([h.reshape(h.shape[0], -1), m], 1)
    h = jax.nn.relu(h @ p['fw'] + p['fb'])
    return h @ p['ow'] + p['ob'][0]

def augment(rng, x):
    x = x.copy()
    flip = rng.random(len(x)) < 0.5; x[flip] = x[flip][:, :, ::-1]
    flipv = rng.random(len(x)) < 0.2; x[flipv] = x[flipv][:, ::-1]
    sh = rng.integers(-1, 2, (len(x), 2))
    for i in range(len(x)): x[i] = np.roll(np.roll(x[i], sh[i, 0], 0), sh[i, 1], 1)
    x[..., :3] = np.clip(x[..., :3] * rng.uniform(0.75, 1.25, (len(x), 1, 1, 1)) + rng.uniform(-0.08, 0.08, (len(x), 1, 1, 3)), 0, 1)
    x[..., 3:] = np.clip(x[..., 3:] * rng.uniform(0.7, 1.4, (len(x), 1, 1, 1)), 0, 1)
    return x

if __name__ == '__main__':
    args = sys.argv[1:]; out = args[0]
    val = None
    if '--val' in args: i = args.index('--val'); val = args[i + 1]; args = args[:i] + args[i + 2:]
    X, Y, M = load(args[1:]); M = norm_m(M)
    print('esempi', len(X), 'positivi', int(Y.sum()))
    wpos = (len(Y) - Y.sum()) / max(1, Y.sum())
    p = init(jax.random.PRNGKey(0))
    steps = 3000; opt = optax.adamw(optax.warmup_cosine_decay_schedule(0, 3e-3, 200, steps, 1e-5), weight_decay=1e-4); st = opt.init(p)
    def loss(p, x, m, y):
        z = fwd(p, x, m)
        w = jnp.where(y > 0.5, jnp.sqrt(wpos), 1.0)
        return jnp.mean(w * optax.sigmoid_binary_cross_entropy(z, y))
    @jax.jit
    def step(p, st, x, m, y):
        l, g = jax.value_and_grad(loss)(p, x, m, y); u, st = opt.update(g, st, p); return optax.apply_updates(p, u), st, l
    rng = np.random.default_rng(1)
    for it in range(steps):
        idx = rng.integers(0, len(X), 256)
        p, st, l = step(p, st, jnp.asarray(augment(rng, X[idx])), jnp.asarray(M[idx]), jnp.asarray(Y[idx]))
        if it % 500 == 0: print('passo', it, 'perdita %.3f' % float(l), flush=True)
    def evaluate(name, Xv, Yv, Mv):
        s = np.asarray(jax.nn.sigmoid(fwd(p, jnp.asarray(Xv), jnp.asarray(Mv))))
        for thr in (0.3, 0.5, 0.7):
            tp = ((s >= thr) & (Yv == 1)).sum(); fp = ((s >= thr) & (Yv == 0)).sum()
            print(f'  {name} soglia {thr}: palle tenute {tp}/{int(Yv.sum())} ({100 * tp / max(1, Yv.sum()):.0f}%), falsi tenuti {fp}/{int((Yv == 0).sum())} ({100 * fp / max(1, (Yv == 0).sum()):.1f}%)')
    if val:
        Xv, Yv, Mv = load([val]); evaluate('VALIDAZIONE ' + val.split('/')[-1], Xv, Yv, norm_m(Mv))
    names = sorted(p.keys())
    flat = np.concatenate([np.asarray(p[k], np.float32).ravel() for k in names])
    json.dump({'patch': 12, 'tensors': [[k, list(np.asarray(p[k]).shape)] for k in names]}, open(out + '/ballnet.json', 'w'))
    flat.tofile(out + '/ballnet.f32')
    print('salvati', flat.size, 'parametri')
