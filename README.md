# VolleyScout Pro

Sistema di **scouting video per la pallavolo professionale**, ispirato a
[ovscout2](https://github.com/openvolley/ovscout2) (openvolley) e riscritto come
applicazione web autonoma: nessuna installazione di R, funziona nel browser anche
offline e produce file **DataVolley (.dvw)** compatibili con DataVolley, VolleyStation,
ovscout2, il pacchetto R `datavolley` e gli altri strumenti di analisi.

## Avvio rapido

```bash
npm start            # server statico senza dipendenze su http://localhost:8080
# oppure qualsiasi server statico, ad es.  python3 -m http.server 8080
```

Apri `http://localhost:8080`, premi **Demo** per provare subito con due squadre di
esempio (clic sul campo schematico, senza video) oppure **Apri → Partita di esempio**
per vedere report e statistiche di una partita reale.

L'app è una PWA: dopo il primo caricamento funziona anche senza rete (utile nei
palazzetti) e si può installare come applicazione dal browser.

## Funzioni (come ovscout2)

- **Scouting a clic guidato**: battuta → ricezione → alzata → attacco → muro/difesa,
  con ogni tocco registrato con la sua posizione esatta (coordinate, zona, sottozona).
- **Calibrazione del campo sul video** con omografia: i clic sul video diventano
  coordinate reali del campo.
- **Scouting digitato** con la sintassi dei codici DataVolley (`a5SQ-`, `9X5#`, `*p`, …),
  compresi i codici compound (`7SQ-.12`).
- **Proposta del giocatore più probabile** per ogni tocco, che impara dai dati scoutizzati.
- Punteggio, rotazioni, cambio palla, sostituzioni, time-out, fine set gestiti in automatico.
- Tabelle combinazioni d'attacco e chiamate del palleggiatore standard (complete o semplificate).
- Import ed export **DVW**, report della partita, elenco azioni modificabile.

## Miglioramenti rispetto a ovscout2

| | ovscout2 | VolleyScout Pro |
|---|---|---|
| Installazione | R + pacchetti + Shiny (o installer) | Nessuna: un browser. PWA offline, installabile |
| Dispositivi | PC | PC, tablet e touch (layout responsive) |
| Scouting senza video | solo digitando | anche a clic sul **campo schematico** (scouting live in palestra), con orario reale |
| Calibrazione | 4 angoli | 4–10 punti (angoli, linee dei 3 m, centrale) ai **minimi quadrati**, errore in metri, punti trascinabili, linee proiettate sul video per verifica |
| Squadra nei codici digitati | va sempre scritta (`a`) | **dedotta dal contesto** (chi batte, chi riceve, chi ha la palla); battitore e palleggiatore dedotti dalla rotazione |
| Anteprima codici | — | descrizione in italiano **mentre si digita** |
| Tempo dei codici digitati | all'invio | dall'**inizio della digitazione** (più vicino all'azione) |
| Predizione giocatore | tabelle fisse per sistema 5-1 | prior basato sui **ruoli dichiarati** (qualsiasi sistema) + apprendimento bayesiano; probabilità visibile su ogni pulsante |
| Coerenza dei dati | modifica righe = rischio di stati incoerenti | lo stato (punteggio, rotazioni, fasi) è **ricalcolato rigiocando gli eventi**: modifiche, inserimenti e cancellazioni sono sempre coerenti |
| Annulla | ultima azione | **annulla/ripeti illimitati** (200 passi) |
| Salvataggio | manuale | **automatico** nel browser + file progetto `.vsj`; il video viene riaperto con un clic (File System Access API) |
| Controllo dati | app esterna (dvalidate) | **validazione integrata** in tempo reale: giocatori fuori rotazione, libero che batte/mura, valutazioni battuta/ricezione incoerenti, punti mancanti, tempo video che torna indietro… |
| Alzata ↔ attacco | — | tempo e target dell'alzata ricavati **automaticamente** dalla combinazione d'attacco |
| Set decisivo | — | proposta automatica del **cambio campo a 8** |
| Report | report partita | report + **side-out/break-point per rotazione**, attacco per qualità di ricezione, **distribuzione del palleggiatore** per rotazione, **mappe direzionali** filtrabili; stampa/PDF |
| Video analisi | playlist | filtri (squadra, giocatore, fondamentale, valutazione, fase, combinazione, zone), riproduzione automatica delle clip, export elenco |
| Export | DVW | DVW + **CSV** (Excel) + progetto JSON |

## Come si usa

1. **Partita**: dati gara e rose (anche incollando un elenco o importando da un file DVW).
   Le squadre si possono salvare in libreria e riusare.
2. **Scouting**: carica il video (📂) e calibra il campo (📐): clicca i 4 angoli
   (vicino sinistro, vicino destro, lontano destro, lontano sinistro) e, se visibili,
   le linee dei 3 m e la linea centrale. Inserisci le formazioni.
3. Scoutizza a clic seguendo il pannello a destra, oppure digita i codici nella barra
   sotto il video. Puoi mescolare i due metodi in qualunque momento.
4. **Report** e **Video analisi** per l'analisi; **DVW** / **CSV** per esportare.

### Tasti principali

| Tasto | Azione |
|---|---|
| Spazio | play/pausa |
| ← / → (Shift) | −/+ 2 s (10 s) |
| , / . | fotogramma indietro/avanti |
| [ / ] | velocità |
| q w e r t y u i o | scelta del giocatore |
| a s d f g h j k | scelta della combinazione d'attacco |
| 1–6 oppure `# + ! - / =` | valutazione |
| Invio / Esc | conferma / annulla |
| c | barra dei codici |
| Ctrl+Z / Ctrl+Y | annulla / ripeti |

### Esempi di codici

```
7SQ-.12     battuta salto spin del 7 negativa + ricezione perfetta del 12 avversario
E           alzata del palleggiatore in campo (squadra dedotta)
9X5#        attacco tesa in 4 del 9, punto (zona di partenza dalla combinazione)
10V6/.5     attacco murato + muro punto del 5 avversario
4D+         difesa positiva del 4
*p  ap      punto casa / ospiti
*T  *c5:12  time-out casa / cambio (esce 5, entra 12)
```

## Struttura del codice

```
index.html, css/app.css      interfaccia
js/lib/                      logica pura (testata con node, senza DOM)
  constants.js               tabelle DataVolley (combinazioni, chiamate, valutazioni)
  court.js                   coordinate DV, zone/sottozone, omografia
  codes.js                   costruzione/interpretazione dei codici
  engine.js                  motore partita (replay degli eventi)
  predict.js                 predizione giocatore e combinazioni
  stats.js, validate.js      statistiche e controllo dati
  dvw.js                     import/export DataVolley
  store.js                   salvataggio locale
js/ui/                       schermate (scouting, partita, report, video analisi, impostazioni)
tests/                       test unitari (node --test) e test end-to-end (Playwright)
```

## Test

```bash
npm test                                   # test unitari
npm start & node tests/e2e/smoke.mjs http://localhost:8080/ video.mp4 /tmp   # end-to-end (richiede Playwright)
```

I test verificano tra l'altro che importando un file DVW reale vengano ricostruiti
esattamente i punteggi dei set e le posizioni in campo di ogni tocco, e che
l'export DVW → import restituisca gli stessi codici.

## Crediti e licenza

Licenza MIT. Le tabelle delle combinazioni d'attacco, delle chiamate del palleggiatore
e le convenzioni dei codici derivano da [ovscout2](https://github.com/openvolley/ovscout2)
e [datavolley](https://github.com/openvolley/datavolley) (MIT, © gli autori dei pacchetti,
openvolley.org); il file `samples/esempio.dvw` proviene da `datavolley`.
DataVolley è un marchio dei rispettivi proprietari; questo progetto non è affiliato.
