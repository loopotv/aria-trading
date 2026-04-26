# Audit dei Gate — Quanti ne abbiamo davvero e quanti servono

**Data**: 2026-04-26
**Domanda**: ho aggiunto troppi gate hard? Ridurli a 3-4 darebbe più trade senza perdere qualità?

---

## 1. Inventario completo

### Gate hard nell'event-driven (file: [src/trading/strategies/event-driven.ts](src/trading/strategies/event-driven.ts))

| # | Gate | Soglia | Sprint | Cosa misura | Razionale storico |
|---|---|---|---|---|---|
| G1 | Magnitude LLM | ≥ 0.5 | base | Quanto la news dovrebbe muovere | Filtro base per "non spazzatura" |
| G2 | Confidence LLM | ≥ 0.7 | base | Quanto il classificatore è sicuro | Evita estrazioni ambigue |
| G3 | \|Sentiment\| | ≥ 0.3 | base | Direzione netta | Niente trade neutrali |
| G4 | RSI estremo | LONG<75, SHORT>25 | base | Estremi assoluti | Anti-spike obvious |
| G5 | Move recente 3h | < 6% | base | News non già scontata | Anti chasing |
| G6a | RSI momentum SHORT | ≥ 45 | 2A | Anti-bounce trap | Dati: 33% WR su 35-45 |
| G6b | RSI momentum LONG | ≥ 45 | 2A | Anti falling-knife | Dati: 0% WR su 35-45 |
| G6c | Vol SHORT | ≥ 0.5 | base | Conferma panic-sell | Anti-bounce |
| **G7** | **Vol LONG** | **≥ 0.7** | **2B** | **Buying pressure** | **Dati: 2 trade BTC del 25/04** |
| **G8** | **ADX** | **≥ 18** | **2B** | **Trend confermato** | **Dati: BTC LONG con ADX 9.6** |
| **G9** | **ATR%** | **≥ 0.4%** | **2B** | **Volatility per TP raggiungibile** | **Dati: BTC LONG con ATR 0.22%** |

### Gate hard in altri file

| # | Gate | File | Cosa fa |
|---|---|---|---|
| G10 | F&G asimmetria SHORT | [engine.ts](src/trading/engine.ts) | Reject SHORT se F&G<35 |
| G11 | Volume 24h notional | engine.ts | Reject se < $2M |
| G12 | Cooldown loss | engine.ts | Reject se ultimo trade su asset = loss in <1h |
| G13 | Max positions | engine.ts | Reject se openPositions ≥ maxPositions (regime-based) |
| G14 | Composite score | [composite-score.ts](src/trading/composite-score.ts) | Reject se score < 60 |
| G15 | MTF alignment | engine.ts | Strategist reject COUNTER-TREND, MIXED+score<75 |
| G16 | Strategist LLM | engine.ts | LLM finale può rejectare per qualunque motivo |

### Totale gate hard: **17** (alcuni doppi LONG/SHORT, in realtà ~14 unici)

---

## 2. Funnel — quanti trade vengono effettivamente filtrati

Senza un endpoint per la telemetria gate-by-gate (che ancora non abbiamo), questa è la stima qualitativa:

```
News HIGH-impact arrivate (ultimi 2 giorni)     1183
                                                  │
                                                  ▼
G1+G2+G3 (LLM gates)                           ~50% pass
                                                  │  ~590
                                                  ▼
G4 (RSI estremo)                               ~95% pass
                                                  │  ~560
                                                  ▼
G5 (move recente)                              ~80% pass
                                                  │  ~450
                                                  ▼
G6 (RSI momentum 45+)                          ~50% pass    ← KILLER
                                                  │  ~225
                                                  ▼
G7 (vol LONG≥0.7) — solo LONG                  ~40% pass    ← KILLER nuovo
                                                  │  ~90 (di cui 30 LONG)
                                                  ▼
G8 (ADX≥18)                                    ~50% pass    ← KILLER nuovo
                                                  │  ~45
                                                  ▼
G9 (ATR%≥0.4%)                                 ~60% pass    ← KILLER nuovo
                                                  │  ~27
                                                  ▼
G10 (F&G SHORT)                                ~80% pass
G11 (vol 24h)                                  ~90% pass
G12 (cooldown)                                 ~95% pass
                                                  │  ~18
                                                  ▼
G14 (composite ≥60)                            ~30% pass    ← KILLER
                                                  │  ~5
                                                  ▼
G15 (MTF strategist)                           ~70% pass
                                                  │  ~3-4
                                                  ▼
G16 (LLM strategist)                           ~80% pass
                                                  │
                                                  ▼
TRADE EFFETTIVAMENTE APERTI                    ~3 trade in 2 gg
```

**Ipotesi**: 1183 → 3 trade. Funnel di 0.25%. Forse ok per qualità, ma sospettosamente stretto.

---

## 3. Diagnosi problema "death by a thousand cuts"

### 3.1 Sovrapposizioni concettuali (gate ridondanti)

Molti gate misurano **la stessa cosa da angolazioni diverse**:

| Concetto | Gate che lo misurano |
|---|---|
| **"Trend confermato"** | G6 (RSI≥45) + G8 (ADX≥18) + G15 (MTF alignment) + G14 (composite trend 15%) |
| **"Volatility/movimento"** | G5 (no recent spike) + G9 (ATR%≥0.4%) + G14 (composite vol 20%) |
| **"Volume/interest"** | G6c (SHORT vol) + G7 (LONG vol) + G11 (24h notional) + G14 (composite vol component) |
| **"Sentiment quality"** | G1 (magnitude) + G2 (confidence) + G3 (\|score\|≥0.3) + G14 (composite sentiment 25%) |

Queste sovrapposizioni significano che **lo stesso problema viene punito 3-4 volte**. Esempio: se un trade ha "trend debole":
- G6 lo blocca per RSI<45
- G8 lo blocca per ADX<18
- G15 (MTF) lo blocca per "MIXED"
- G14 lo penalizza nel componente trend

### 3.2 Gate "sicuri" vs gate "discriminanti"

I gate si dividono in 2 categorie:

**Sicuri (regole tecniche oggettive)** — sempre giusti, raramente bloccano trade buoni:
- G1, G2, G3 (LLM quality)
- G4 (RSI estremo, blocca solo casi obvious)
- G11 (volume 24h)
- G12 (cooldown)
- G13 (max positions)

**Discriminanti (dove il trade-off è duro)** — bloccano molto, qualità incerta:
- G5 (move recente — può perdere news fresche)
- G6 (RSI momentum 45) — nuovo, dati limitati
- G7 (vol LONG 0.7) — nuovissimo, dati limitati
- G8 (ADX 18) — nuovissimo, dati limitati
- G9 (ATR% 0.4) — nuovissimo, dati limitati
- G14 (composite 60)
- G15 (MTF)
- G16 (LLM strategist)

**6 dei 7 "discriminanti" sono nuovi (Sprint 1-2B)** e non hanno ancora dati statistici per validarli.

### 3.3 Il vero problema: doppia consolazione del "trend"

Hai 3 modi diversi di rifiutare per "no trend":
- G6 (RSI<45 = momentum non confermato)
- G8 (ADX<18 = trend non confermato)
- G15 (MTF MIXED = timeframes disagree)

**Probabilmente un trade che fallisce uno fallisce anche gli altri 2.** È sovra-determinato.

---

## 4. Proposta di razionalizzazione

### Opzione A — Rimanere com'è, ma aspettare 1 settimana
Pro: zero rischio, raccogliamo dati
Contro: se il sistema fa 1-2 trade/giorno per 5 giorni abbiamo solo 5-10 dati, statisticamente debole

### Opzione B — Consolidare a 4 gate hard "core" + composite score
Manteniamo come **gate hard** solo le regole **oggettive e fail-closed**:

**Core gates (5)**:
- G1+G2+G3 unificati come "LLM quality" (mag≥0.5 AND conf≥0.7 AND |score|≥0.3)
- G4 (RSI estremo: LONG<75, SHORT>25)
- G5 (move recente <6%)
- G11+G12+G13 (volume 24h + cooldown + max positions)

**Tutto il resto diventa COMPOSITE SCORE** (non gate hard):
- G6, G7, G8, G9 → diventano componenti del score, peso ricalibrato
- G10 (F&G) → componente regime
- G14 → la nuova soglia diventa quella che decide
- G15 (MTF) → componente alignment
- G16 (LLM strategist) → mantenere come gate finale ma più permissivo

**Vantaggio**: il composite score può ben pesare i 9-10 segnali e dire "anche se ADX è 16 ma tutto il resto è ottimo, vai". Adesso invece basta UNO sotto soglia per perdere il trade.

**Soglia composite suggerita**: 65 (era 60). Più alta ma meno gate hard = bilanciamento.

### Opzione C — Rimuovere SOLO i 3 nuovi Sprint 2B (G7, G8, G9)
Pro: torna alla configurazione che ha generato 73% WR il primo round
Contro: i trade BTC del 25/04 ripeterebbero (quelli che hanno motivato 2B)

### Opzione D — Telemetry gate-by-gate prima di decidere (mia preferenza)
Aggiungere logging persistente che conta **quante volte ogni gate ha rejected** in un intervallo. Esempio: `/debug/gate-stats` che mostra:
```
G1 magnitude: 250 reject (40% delle news)
G6 RSI momentum: 180 reject (di cui 90 LONG, 90 SHORT)
G8 ADX: 95 reject
G9 ATR%: 60 reject
...
```
Così si vede **chi sta facendo davvero il filtraggio** vs chi è ridondante. **Senza dati, qualunque consolidamento è un'opinione.**

---

## 5. La mia raccomandazione

**Sequenza in 2 step**:

### Step 1 — Telemetry (1 ora di lavoro)
Aggiungere un counter persistente per ogni gate, esposto via `/debug/gate-stats`. **Lasciamo girare 48-72h** e poi vediamo numeri reali. Senza dati stiamo solo speculando.

### Step 2 — Consolidamento data-driven
Una volta visti i numeri:
- Se G8 (ADX) e G15 (MTF) bloccano gli stessi trade → rimuovere uno dei due
- Se G7 (vol LONG) e G14 composite-volatility bloccano insieme → spostare G7 nello score
- Se G9 (ATR%) blocca SOLO trade che poi avrebbero perso → tenere
- Se G9 blocca anche trade che storicamente avrebbero vinto → soglia da abbassare a 0.3%

**Obiettivo realistico**: passare da 17 gate hard a **5-6 gate hard + composite score più severo (70+)**. Stesso risultato in qualità, più trade aperti.

---

## 6. Decisione richiesta

Procedi con:
- **A** — Aspetta 1 settimana e poi rivediamo
- **B** — Consolidamento aggressivo subito (rischio: cambi cieci)
- **C** — Rollback Sprint 2B (ADX, ATR, vol LONG)
- **D** — Aggiungi telemetry e decidi tra 48h (mio preferito)

Io andrei con **D**. È l'unico modo per fare una scelta basata su dati, non su sensazioni. La telemetry è una mezz'ora di lavoro e dopo 48h sappiamo *esattamente* quanti trade ogni gate sta tagliando.
