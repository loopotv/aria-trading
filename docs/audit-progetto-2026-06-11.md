# Audit Progetto ARIA — Stato reale e strada verso WR 65%

**Data**: 2026-06-11
**Campione**: 102 trade chiusi (intera vita del bot, ~7 settimane)
**Balance**: $61.54 → $56.69 (**-7.9%**)

---

## 1. I numeri veri

| Metrica | Valore |
|---|---|
| Trade chiusi | 102 |
| Win Rate | **41.2%** |
| PnL registrato (trades) | -$2.31 |
| PnL reale (balance) | **-$4.85** |
| **Differenza = fees** | **~-$2.54** |

### Per strategia

| Strategia | n | WR | PnL |
|---|---|---|---|
| event-driven LONG | 70 | 42.9% | -$1.18 |
| event-driven SHORT | 28 | 42.9% | -$0.53 |
| short-breakdown | 2 | 0% | -$0.48 |
| orphan-adopted | 2 | 0% | -$0.13 |

### Il dato più importante dell'audit: WR per conviction del sentiment

| LLM conviction | n | WR | PnL |
|---|---|---|---|
| Alta (\|sent\| ≥ 0.8) | 36 | 44.4% | -$0.65 |
| Media (0.6–0.8) | 58 | 39.7% | -$1.49 |
| Bassa (< 0.6) | 6 | 50.0% | -$0.04 |

**Se il sentiment LLM avesse potere predittivo, il WR dovrebbe crescere con la conviction. È piatto.** I trade in cui l'LLM era "sicurissimo" vincono quanto quelli in cui era incerto. Questo è il segnale statistico che la premessa del sistema — news sentiment → movimento prezzo — **non sta funzionando**.

---

## 2. Il finding strutturale: non abbiamo MAI misurato il segnale

Lo schema `news_events` ha da sempre le colonne progettate per la validazione:
`price_1h_change`, `price_4h_change`, `price_24h_change`, `was_correct`.

Stato attuale su **18.257 news classificate dall'LLM**:

| Colonna | Righe popolate |
|---|---|
| price_1h_change | **0** |
| price_4h_change | **0** |
| was_correct | **0** |

**Nessun codice le ha mai riempite.** Abbiamo passato 6 settimane a tunare gate, soglie, exit, trailing — tutto A VALLE di un segnale che non abbiamo mai verificato A MONTE. È come ottimizzare l'aerodinamica di un'auto senza aver mai controllato se il motore gira.

---

## 3. Le altre cause strutturali del WR basso

### 3.1 Le fees mangiano metà del PnL
~$2.54 di fees su 102 trade = **$0.025/trade**, contro un avg win di ~$0.10. Con posizioni da $3-5 di margine, ogni trade parte con un handicap del 25% dell'avg win. Il breakeven WR reale con R:R 1:1 e queste fees è **~55%, non 50%**.

### 3.2 Churn di configurazione
~15 modifiche significative ai parametri/architettura in 6 settimane. **Nessuna configurazione ha mai avuto più di ~25 trade di valutazione pulita.** Ogni "miglioramento" è stato giudicato su 5-10 trade — statisticamente rumore. Anche il 64.7% del fork era su **17 trade**: l'intervallo di confidenza al 95% è circa [41%, 83%]. Il nostro campione di 102 trade a 41% è statisticamente PIÙ informativo del loro a 65%.

### 3.3 Mercato ostile + size troppo piccola
7 settimane prevalentemente bearish/laterali con F&G 22-48. L'event-driven LONG-biased ha remato controcorrente per quasi tutto il periodo. E con $56 di equity, il vincolo minNotional $10 forza size dove le fees pesano in modo sproporzionato.

### 3.4 Cosa invece FUNZIONA (da preservare)
- Infrastruttura: telemetria gate su D1, orphan recovery, doppio cron, daily-loss halt, funding gates — **solida e testata** (127 unit test)
- SlowTrail + Phase 1 trail: exit razionali (ma deployati da <48h, non ancora valutabili)
- Short-breakdown: 2 trade non fanno un giudizio — è l'unica strategia con provenienza da backtest validato

---

## 4. La risposta onesta alla domanda "come arrivare a 65%?"

**Nessun tuning di soglie ci porterà da 41% a 65%.** Il gap è strutturale, non parametrico. La strada realistica ha 3 fasi:

### Fase 1 — Misura il segnale (1-2 settimane, PRIORITÀ ASSOLUTA)
Implementare il **news-outcome backfill**: un job orario che per ogni news con \|sentiment\| ≥ 0.5 e asset noto, dopo 1h/4h/24h registra la variazione prezzo e calcola `was_correct` (direzione prezzo concorde col sentiment).

Costo: ~1-2 ore di sviluppo, zero rischio (solo scritture D1).
Dopo 1-2 settimane avremo migliaia di data point e una risposta definitiva:
- **Accuracy ≥ 55%** → il sensor ha edge: si tuna il timing/sizing e si scala
- **Accuracy ~50%** → il sensor è rumore: si SPEGNE l'event-driven e si tengono solo strategie tecniche

### Fase 2 — Riduci il fee drag mentre misuri
- Dimezzare la frequenza: solo trade con composite ≥ 75 (oggi 65)
- Size minima più alta dove possibile: meno trade, più grandi → fee% per trade scende
- Risultato atteso: meno PnL bruciato mentre raccogliamo i dati di Fase 1

### Fase 3 — Decisione data-driven (tra 2 settimane)
Tre scenari in base ai dati di Fase 1:
1. **Sensor ha edge** → ottimizza l'event-driven sul timing (es. solo categorie/fonti con accuracy alta)
2. **Sensor è rumore ma short-breakdown funziona** (target: 15+ trade entro allora) → ARIA diventa un bot tecnico puro (short-breakdown + eventuale long-breakout speculare)
3. **Niente funziona** → si spegne il trading reale, si tiene il paper-trading finché il regime di mercato cambia

### Cosa NON fare (vincolo di disciplina)
- **Nessun'altra modifica a gate/soglie/exit per 2 settimane.** Ogni cambiamento azzera la valutabilità del campione.
- Non inseguire il fork: il suo 64.7% su 17 trade non è un benchmark statisticamente valido.

---

## 5. Sintesi per decidere

| Azione | Effort | Impatto su "sapere se possiamo arrivare a 65%" |
|---|---|---|
| News-outcome backfill | 1-2h | **CRITICO** — è l'unico modo per sapere se il motore funziona |
| Composite 65→75 (meno trade, meno fees) | 5 min | Medio — riduce l'emorragia durante la misura |
| Congelare la config per 2 settimane | 0 | Alto — rende i dati interpretabili |
| Altri tuning di soglie | qualunque | **Zero o negativo** |

Il 65% di WR è raggiungibile solo se esiste un edge da qualche parte nel sistema. Oggi non sappiamo se c'è. La Fase 1 ce lo dice con certezza, spendendo 2 ore di sviluppo e zero capitale aggiuntivo.
