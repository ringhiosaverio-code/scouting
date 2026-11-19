# Modelli

| File | Origine | Licenza | Uso |
|---|---|---|---|
| `yolox_tiny.onnx` | [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) release 0.1.1rc0, Megvii | Apache-2.0 (`LICENSE-YOLOX.txt`) | rilevamento delle persone (giocatori) |
| `yolox_nano.onnx` | come sopra | Apache-2.0 | versione leggera, per computer lenti |
| `digitnet.json`, `digitnet.f16` | addestrata qui (`tools/digits`): maglie sintetiche + numeri delle foto ufficiali dei giocatori di SuperLega, A2, A3 (legavolley.it, usate solo per l'addestramento) | MIT, come il progetto | lettura dei numeri di maglia |

I modelli girano nel browser con [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT),
caricato da CDN al primo uso; con WebGPU dove disponibile, altrimenti WebAssembly.
