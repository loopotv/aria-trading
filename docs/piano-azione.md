# ARIA — Piano d'azione: bug fix + nuova strategia per WR > 60%

> Piano in 2 fasi per risolvere i bug critici, ripartire con dati puliti, e implementare una strategia ottimizzata per WR alto.

**Decisioni di prodotto** (date 2026-04-18):
- 🎯 **Target WR**: 60%+
- 💰 **Capitale**: invariato (~$60)
- 📈 **R:R**: TP più stretti (favorire WR alto, sacrificare R:R)
- 🪙 **Asset scope**: tutti gli asset Hyperliquid sono ammessi — il filtro è il **24h volume**
- 🔊 **Volume gate**: ridurre da $5M → **$2M** per allargare l'universo
- 🗑️ **Wipe D1**: cancellare i dati attuali (17 trade, 17.759 news, 11 pattern) e ripartire pulito
- 🔁 **Sequenza**: Fase A (fix + dati puliti) → Fase B (tuning strategia)

---

## 📊 Vincoli matematici (importante)

Con $60 di capitale e fee Hyperliquid 0.045% taker × 2 (entry+exit) + slippage ~0.05% = **~0.2% break-even per trade**.

Per WR 60% con TP/SL simmetrici (R:R 1:1), edge atteso: `0.6×R - 0.4×R - 0.2% = 0.2R - 0.2%`. Per essere profittevole serve **R > 1%**.

**Strategia proposta**: SL = 0.8% prezzo, TP = 0.8% prezzo (R:R 1:1), holding < 2h. Punta a chiusure rapide su micro-momentum, non swing.

---

# FASE A — Fix bug + raccolta dati puliti (1 settimana)

Obiettivo: zero bug noti, D1 pulito, indicatori e sentiment salvati correttamente. **Nessuna ottimizzazione strategia** in questa fase — vogliamo dati onesti per la Fase B.

## A1. Bug fix critici

### A1.1 Salva sentiment LLM in `news_events`
**File**: [src/trading/engine.ts:200-213](../src/trading/engine.ts#L200-L213) + [src/trading/experience.ts](../src/trading/experience.ts)

**Cosa fare**:
- Spostare `recordNewsEvent` **dopo** il processamento LLM (sia high-impact che batch).
- Aggiungere un metodo `experience.updateNewsEventSentiment(id, sentimentScore, confidence, magnitude, category)` per arricchire i record già scritti.
- In alternativa: fare l'insert una sola volta al termine del processing con tutti i campi popolati.

**Risultato atteso**: ogni news con `impact_level`, `sentiment_score`, `confidence`, `magnitude`, `category` non NULL.

---

### A1.2 Passa indicatori tecnici a `recordTradeOpen`
**File**: [src/trading/engine.ts:854-868](../src/trading/engine.ts#L854-L868)

**Cosa fare**:
- In `processEventDriven`, dopo `evaluateEventSignal`, calcolare RSI, ADX, ATR, volume_ratio (sono già disponibili: `setup.atr` esiste, gli altri sono in `composite-score.ts` ma non esposti).
- Refactor: far ritornare `evaluateEventSignal` un oggetto `indicators: {rsi, adx, atr, volumeRatio}` insieme al setup.
- Passarli a `recordTradeOpen`.

**Risultato atteso**: ogni trade con tutti gli indicatori popolati.

---

### A1.3 Implementa `timeoutHours` (chiusura forzata dopo N ore)
**File**: [src/trading/strategies/event-driven.ts:146](../src/trading/strategies/event-driven.ts#L146) + [src/trading/engine.ts](../src/trading/engine.ts) (`checkSoftOrders`)

**Cosa fare**:
- Aggiungere campo `timeoutAt: number` (timestamp ms) al `SoftOrder`.
- In `checkSoftOrders`, se `Date.now() > order.timeoutAt && !shouldClose`, chiudi a market e segna `notes='timeout'`.
- Default: **2h** per event-driven (più stretto del 4h attuale, allineato alla strategia rapida).

**Risultato atteso**: nessun trade event-driven aperto > 2h. Edge dell'evento non si decade.

---

### A1.4 Fix `recordTradeClose(pnl=0)` per chiusure esterne
**File**: [src/trading/engine.ts:946-952](../src/trading/engine.ts#L946-L952)

**Cosa fare**:
- Quando il SoftSL/TP rileva che la posizione è chiusa "esternamente" (algo order Hyperliquid ha triggerato), interrogare `exchange.getUserFills(symbol)` o equivalente per recuperare i fill recenti su quel symbol.
- Calcolare PnL reale = `Σ(fill.size × fill.price × side)` per i fill nella finestra `[opened_at, now]`.
- Se non recuperabile, almeno usare `markPrice - entryPrice` invece di 0.

**Risultato atteso**: zero trade con `pnl=0` per chiusure non-timeout.

---

### A1.5 Allinea composite gate e strategist gate
**File**: [src/trading/composite-score.ts:204](../src/trading/composite-score.ts#L204) + [src/trading/engine.ts:490](../src/trading/engine.ts#L490)

**Cosa fare**:
- Decisione: tenere **gate unico a 60** (più severo, coerente con target WR alto).
- Composite: `approved = score >= 60`, sizeMultiplier rivisti: `>=80 → 1.0x`, `>=60 → 0.7x`, `<60 → reject`.
- Strategist prompt: rimuovere il gate composite hard-coded, lasciare solo "REJECT if historical context shows losing pattern".

**Risultato atteso**: zero discrepanze, decisioni coerenti.

---

### A1.6 Watchlist: usa volume, non lista hardcoded
**File**: [src/index.ts:438-445](../src/index.ts#L438-L445) + [src/trading/engine.ts:381-385](../src/trading/engine.ts#L381-L385)

**Cosa fare**:
- Rimuovere la lista `symbols` come filtro (lascia solo come hint per market-neutral, che è disabilitato).
- L'unico filtro per event-driven diventa: `isSymbolAvailable` su Hyperliquid + `notionalVol24h >= MIN_VOLUME_24H`.
- **Abbassare `MIN_VOLUME_24H` da $5M → $2M**.

**Risultato atteso**: bot opera su qualunque coin Hyperliquid con $2M+ volume 24h.

---

### A1.7 Popolare `daily_snapshots`
**File**: [src/trading/experience.ts](../src/trading/experience.ts) + [src/index.ts](../src/index.ts) (cron)

**Cosa fare**:
- Aggiungere cron entry `"0 23 * * *"` (23:00 UTC) che esegue `experience.recordDailySnapshot()`.
- Il metodo legge: balance corrente, trade aperti/chiusi del giorno, wins/losses, fees stimati, regime medio, F&G medio, BTC change.

**Risultato atteso**: 1 record/giorno in `daily_snapshots`, fondamentale per analisi Fase B.

---

### A1.8 Consistenza cron + commento
**File**: [wrangler.toml:7](../wrangler.toml#L7) + commento in [engine.ts:121](../src/trading/engine.ts#L121)

**Cosa fare**:
- Cron è `*/5` ma il commento dice "ogni 2 minuti". Aggiornare commento a "every 5 min" oppure cambiare cron.
- **Decisione**: tenere 5 min (rate limit Hyperliquid + costi LLM ok).

---

## A2. Wipe D1

**Eseguire dopo aver deployato i fix A1.1-A1.8**, così si parte con dati puliti e codice corretto contemporaneamente.

```bash
npx wrangler d1 execute trading-experience --remote --command="
DELETE FROM trades;
DELETE FROM news_events;
DELETE FROM patterns;
DELETE FROM signals;
DELETE FROM sentiment_signals;
DELETE FROM sentiment_snapshots;
DELETE FROM audit_log;
DELETE FROM daily_stats;
DELETE FROM daily_snapshots;
DELETE FROM sqlite_sequence;
"
```

**Risultato**: tutte le tabelle a zero, autoincrement ripartiti da 1.

---

## A3. Verifica raccolta dati (3-7 giorni di osservazione)

Dopo wipe, far girare il bot per **almeno 5-7 giorni** SENZA modificare la strategia. Obiettivi di QA:

- [ ] `news_events.sentiment_score` non NULL per tutte le news con `impact_level='HIGH'`
- [ ] `trades.rsi`, `trades.adx`, `trades.atr`, `trades.volume_ratio` non NULL per tutti i nuovi trade
- [ ] `daily_snapshots` ha 1 record/giorno
- [ ] Nessun trade aperto > 2h (campo `holding_hours` <= 2)
- [ ] Zero trade con `pnl=0` (chiusure esterne risolte)
- [ ] Bot opera su >5 simboli diversi (vincolo $2M volume rispettato)

**Definition of done Fase A**: 7 giorni di dati puliti, almeno 20 trade chiusi con tutti gli indicatori popolati.

---

# FASE B — Tuning strategia per WR > 60% (2-3 settimane)

Obiettivo: usando i dati puliti raccolti in Fase A, calibrare la strategia per WR sostenibile sopra il 60%.

## B1. Strategia proposta: "scalping event-driven"

### Principi
1. **Holding breve**: <2h (timeout dalla Fase A).
2. **TP stretto, SL stretto**: target 0.8% / SL 0.8% (R:R 1:1).
3. **Filtri qualità più severi**: composite >= 60 (allineato A1.5).
4. **No SHORT in `EXTREME_FEAR` con RSI < 30**: evita il trap del rimbalzo (insight da analisi-primi-giorni #4.3).
5. **No LONG in `EXTREME_GREED` con RSI > 70**: simmetrico.
6. **Solo asset con volume $2M+ in 24h** (A1.6).

### Parametri target
| Parametro | Valore proposto | Razionale |
|---|---|---|
| `slMultiplier` (event-driven) | da 1.5 → **1.0** ATR | SL ancora più stretto |
| `tpMultiplier` (event-driven) | da 2.5 → **1.0** ATR | TP simmetrico, WR alto |
| `timeoutHours` | 2h | Nessun decadimento edge |
| Composite minimum | 60 | Solo setup forti |
| `MIN_VOLUME_24H` | $2M | Universo allargato |
| `magnitude` minima | 0.5 (invariato) | OK |
| `confidence` minima | 0.7 (era 0.6) | Più severo |
| Cooldown post-loss | 2h (era 1h) | Più disciplina |
| `maxPositions` | 3 (invariato) | OK con $60 |
| `maxPositionSizeUsdt` | $20 (era $15) | Compensa fee |

### Rimuovi gate troppo restrittivi
- **Gate "prezzo mosso 3%"**: alza a **6%** (evento totalmente prezzato).
- **Gate volume**: già abbassato a $2M.

---

## B2. Strategie esplorative (A/B test in parallelo)

Da considerare **dopo** che B1 è stato validato. Implementare come `strategy: 'micro-momentum'` accanto a `event-driven`:

### B2.1 Mean reversion su eccessi
- Trigger: news + RSI estremo (LONG se RSI<25, SHORT se RSI>75) + Bollinger oltre 2σ.
- TP: ritorno a EMA20 (~1-1.5% tipico).
- SL: 0.5% oltre l'eccesso.
- Storicamente WR 65-70% su crypto, perfetto per il target.

### B2.2 Breakout confermato
- Trigger: news positiva + prezzo rompe high 24h con volume 2x media.
- TP: 1× ATR.
- SL: sotto il breakout point.
- WR atteso 50-55% ma R:R 1.5:1.

**Nota**: questi vanno aggiunti solo dopo che B1 ha 30+ trade chiusi e WR misurabile.

---

## B3. Pattern mining (cosa learning vuole vedere)

Con indicatori salvati (A1.2), in Fase B query target:

```sql
-- WR per fascia RSI all'apertura
SELECT
  CASE
    WHEN rsi < 30 THEN '0-30'
    WHEN rsi < 50 THEN '30-50'
    WHEN rsi < 70 THEN '50-70'
    ELSE '70+'
  END as rsi_band,
  direction,
  COUNT(*) as n,
  ROUND(AVG(CASE WHEN pnl>0 THEN 1.0 ELSE 0 END)*100, 1) as wr_pct,
  ROUND(SUM(pnl), 3) as total_pnl
FROM trades WHERE status='CLOSED'
GROUP BY rsi_band, direction
ORDER BY direction, rsi_band;
```

E simili per ADX, ATR%, volume_ratio, regime, ora del giorno, asset.

**Output**: tabella di "no-go zones" da hardcodare in `event-driven.ts` come gate aggiuntivi.

---

## B4. Re-valutazione strategist Kimi K2

Dopo Fase A osserveremo se Kimi rifiuta troppo (false negative) o approva troppo (false positive). Possibili azioni:

- Se rifiuta >50% di trade poi vinti → ammorbidire prompt.
- Se approva >50% di trade poi persi → irrigidire o aggiungere fallback Claude Haiku.
- Se Workers AI ha latenza >3s → tenere come opzionale (non fail-closed).

---

## B5. Definition of done Fase B

- [ ] Almeno 50 trade chiusi con strategia B1 attiva.
- [ ] WR > 55% misurato sugli ultimi 30 trade (verso il target 60%).
- [ ] PnL netto positivo dopo fee.
- [ ] Almeno 1 trade/giorno medio.
- [ ] Pattern mining (B3) ha identificato 2+ no-go zones e implementate.

---

# Timeline

| Settimana | Fase | Attività |
|---|---|---|
| **W1** | A — Fix | Implementare A1.1-A1.8, deploy, wipe D1 |
| **W2** | A — QA | Osservazione 5-7 giorni, verifica checklist A3 |
| **W3** | B — Strategy | Implementare B1 (parametri nuovi), deploy |
| **W4-5** | B — Tuning | Pattern mining (B3), refinement, B4 |
| **W6** | B — Validation | Verifica DoD B5, valutare B2 |

---

# Ordine di esecuzione raccomandato

1. **PR 1** (Fase A): tutti i bug fix A1.1-A1.8 in un'unica PR coerente.
2. **Deploy + wipe D1** in finestra controllata (no posizioni aperte).
3. **Monitoring 5-7 giorni** — solo check QA, no modifiche.
4. **PR 2** (Fase B): implementare strategia B1, parametri nuovi.
5. **Iterare** B3 → B4 settimanalmente.

---

*Documento allineato con [analisi-primi-giorni.md](./analisi-primi-giorni.md). Generato 2026-04-18.*
