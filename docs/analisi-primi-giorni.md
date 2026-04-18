# ARIA — Analisi dei primi giorni (23 marzo → 18 aprile 2026)

> Analisi quantitativa dei dati raccolti in D1 (`trading-experience`) per capire **perché si aprono pochi trade** e **perché quelli aperti vanno in perdita**, con piano d'azione per aumentare WR e produttività del bot.

---

## 1. Numeri chiave

### Trade
| Metrica | Valore |
|---|---|
| Trade totali | **17** (tutti chiusi) |
| Win | 4 |
| Loss | 11 |
| Break-even (pnl=0) | 2 |
| **Win rate** | **23.5%** (4/17) — **18.2%** se conti i be come loss |
| **PnL totale** | **-$1.337** |
| Periodo | 23 mar → 16 apr (27 giorni) |
| Trade/giorno medio | **0.63** |
| Giorni operativi | 8 su 27 (~30%) |
| Trade aperti tutti in regime | `EXTREME_FEAR` (100%) |
| Strategia | `event-driven` (100%) — `market-neutral` mai eseguita |
| Leverage usato | 2x (sempre, regime extreme fear → 0.5x su base 3x) |

### News raccolte (sensor pipeline)
| Metrica | Valore |
|---|---|
| News totali processate | **17.759** |
| News con impatto HIGH | 3.965 (22%) |
| News con asset associato | 8.081 (46%) — **9.678 con asset=NULL** |
| News con sentiment salvato | **0** ❌ |
| News con confidence salvata | **0** ❌ |
| News con category salvata | **0** ❌ |
| News con `was_correct` valutato | **0** ❌ |
| Asset più coperti | BTC (4.792), XRP (1.161), ETH (807), SOL (417), BNB (325) |

### PnL per direzione
| Direzione | Trade | Win | Avg PnL | Total |
|---|---|---|---|---|
| LONG | 8 | 2 | -$0.036 | **-$0.285** |
| SHORT | 9 | 2 | -$0.117 | **-$1.052** |

### PnL per simbolo
| Symbol | Trade | Win | Total PnL |
|---|---|---|---|
| BTCUSDT | 7 | 2 | -$0.056 |
| XRPUSDT | 3 | 1 | -$0.207 |
| ETHUSDT | 2 | 0 | -$0.316 |
| XMRUSDT | 1 | 1 | **+$0.466** ✅ |
| DOTUSDT | 1 | 0 | -$0.271 |
| NEARUSDT | 1 | 0 | -$0.353 |
| SOLUSDT | 1 | 0 | -$0.273 |
| TAOUSDT | 1 | 0 | -$0.326 |

---

## 2. Pattern dei trade aperti

Tutti i 17 trade hanno questi tratti comuni:

- **Regime sempre `EXTREME_FEAR`** (F&G da 8 a 23): il bot ha operato esclusivamente in mercato impaurito.
- **Leverage 2x effettivo**: con `leverageMultiplier=0.5` su base 3x → 1.5 arrotondato a 2x. È molto basso, soffoca i guadagni.
- **`maxPositionSizeUsdt=$15`** + size multiplier dal composite score → posizioni minuscole. Questo spiega il PnL in centesimi.
- **`riskPerTrade=2%`** moltiplicato per `sizeMultiplier=0.5` (regime) → rischio reale ~1% per trade.
- **RSI / ADX / ATR / volume_ratio non salvati**: la colonna esiste ma `recordTradeOpen` non riceve i valori da `engine.ts`. Impossibile fare pattern-mining sugli indicatori.
- **Solo strategy `event-driven`**: `enableMarketNeutral=false` su Hyperliquid (manca hedge mode), quindi tutta la pipeline market-neutral è dormiente.
- **Notes mostrano la fonte dell'evento**: `event` (9), `announcement` (5), `sentiment_aggregate` (3). Gli `announcement` sono stati i peggiori (-$0.465 su 5 trade).

### Trade paralleli sospetti
Il 23/24 marzo ci sono stati 11 trade in 24 ore (uno ogni ~2h), poi un buco di 9 giorni con 1 trade, poi cadenza ~1/giorno. Questo conferma che il bot **trade molto poco una volta passata la fase iniziale di forte F&G drop**.

---

## 3. Perché si aprono pochi trade — i 7 colli di bottiglia

Il pipeline è un imbuto a 7 livelli. Da 17.759 news totali → 17 trade significa **un'efficienza dello 0.096%**. Vediamo dove si perdono i candidati.

### Gate 1 — Sentiment LLM mai persistito
**Problema critico:** `experience.recordNewsEvent` viene chiamato in [`engine.ts:200-213`](../src/trading/engine.ts#L200-L213) **prima** del processamento LLM, salvando solo `source/title/asset/impactLevel`. I campi `sentimentScore`, `confidence`, `magnitude`, `category` restano NULL per tutte e 17.759 le news. Conseguenze:

- Impossibile valutare l'**accuratezza storica del sensore** (`was_correct` mai popolato).
- La `buildLLMContext` per il strategist ha contesto storico povero.
- Non puoi backtestare quante news avrebbero dovuto generare un setup ma sono state filtrate.

### Gate 2 — Asset extraction debole
**46% delle news non ha asset estratto** (9.678 su 17.759). Senza asset, l'evento non genera mai un trade `event-driven` (vedi [engine.ts:374-377](../src/trading/engine.ts#L374-L377): se `signal.asset === 'MARKET'` → return). Significa che metà del flusso è scartata a monte.

### Gate 3 — Filtri quantitativi `event-driven.ts`
[`event-driven.ts:50-86`](../src/trading/strategies/event-driven.ts#L50-L86) ha 5 gate hard:
1. `magnitude >= 0.5`
2. `confidence >= 0.6`
3. `|sentimentScore| >= 0.3`
4. RSI non estremo (>75 per LONG, <25 per SHORT)
5. **Prezzo mosso ≤ 3% nelle ultime 3 candele 1h** ← molto restrittivo su crypto volatile

Il gate #5 in particolare scarta moltissimi eventi proprio dopo che sono già usciti — ma su un cron a 5 min sei già in ritardo per le news più reattive.

### Gate 4 — Composite score ≥ 40
Threshold piuttosto alto data la composizione. In `EXTREME_FEAR`:
- `regime` = 25/100 per LONG, 85/100 per SHORT
- Quindi un LONG parte con un handicap strutturale.
- Pesi: il regime vale solo 15% ma combinato con momentum (RSI di solito basso in fear → bene per LONG ma male per SHORT) genera molti score 30-50.

### Gate 5 — Strategist Kimi K2 fail-closed
[`engine.ts:593-604`](../src/trading/engine.ts#L593-L604): se Kimi fallisce o JSON non si parsa, **trade saltato**. Workers AI ha latenza/disponibilità variabile e la prompt è dura: `"REJECT if composite < 50"` mentre il composite gate è 40. **Inconsistenza interna**: il composite approva 40-49 ma il strategist viene istruito a rifiutarli.

Inoltre il system prompt:
> "In EXTREME_FEAR regime: only approve LONG if confidence >= 0.70 AND magnitude >= 0.7. Prefer SHORT."

Combinato con il fatto che hai operato 100% in EXTREME_FEAR → quasi tutti i LONG vengono rifiutati upstream dal strategist, forzando SHORT su un mercato che spesso fa rimbalzi. Risultato: i SHORT pesano -$1.05 totali.

### Gate 6 — Cooldown 1h dopo loss
[`engine.ts:402-417`](../src/trading/engine.ts#L402-L417): dopo una perdita su un asset, blocca per 1h. Sensato ma combinato con tutti gli altri filtri, riduce ancora il volume.

### Gate 7 — `maxPositions=3` e min notional
- Solo 3 posizioni simultanee possibili su Hyperliquid.
- `maxPositionSizeUsdt=$15` + size multiplier 0.4-1.0 → spesso sotto il **minNotional di Hyperliquid ($10)**, e il trade viene saltato silenziosamente.

---

## 4. Perché i trade aperti vanno in perdita

### 4.1 Costo strutturale fee/slippage > edge
Con posizioni da $10-15, fees Hyperliquid (0.045% taker entrata + 0.045% uscita ≈ 0.09%) + slippage market order ≈ 0.05-0.15%. Un trade tipico deve fare **+0.2% solo per andare break-even**. Su trade con SL a 1.5×ATR e TP a 2.5×ATR, il R:R nominale è 1:1.67 ma il break-even effettivo abbassa molto la profittabilità.

### 4.2 Holding time troppo lungo per setup "event-driven"
| Trade | Holding | Esito |
|---|---|---|
| BTC #22 | 2.9h | +$0.57 ✅ |
| XRP #23 | **10.7h** | -$0.29 |
| BTC #24 | **23.4h** | $0 (chiuso esterno) |
| XMR #25 | 8.7h | +$0.47 ✅ |
| SOL #33 | **53.2h** | -$0.27 |
| TAO #37 | **46.7h** | -$0.33 |

`timeoutHours: 4` è dichiarato in [event-driven.ts:146](../src/trading/strategies/event-driven.ts#L146) ma **non viene mai applicato** — non c'è codice che chiuda dopo 4h. I trade restano aperti fino a SL/TP, perdendo l'edge dell'evento (che si esaurisce in 1-3h).

### 4.3 SHORT in EXTREME_FEAR = rimbalzo trap
9 SHORT, 2 win, -$1.05 totale. Quando F&G è 8-23 il mercato è già scarico. Il bot va short su news negative arrivando a evento già prezzato → stop loss sul rimbalzo. Il composite score privilegia structure SHORT in EXTREME_FEAR, ma storicamente i bottom locali producono short squeeze.

### 4.4 Mancanza di indicatori salvati impedisce attribuzione
Senza RSI/ADX/ATR/volume_ratio in DB **non puoi capire** quale combinazione di indicatori produce vincenti. Il pattern-learning su `patterns` è degradato a `{symbol, regime, direction}` → solo 11 pattern unici. Tutti gli SHORT EXTREME_FEAR su asset diversi da BTC sono 0 win / 6 loss = il bot non sta imparando perché non ha la dimensione "qual è stato il setup tecnico".

### 4.5 ATR-based SL su candele 1h è troppo stretto
ATR 14 su 1h può essere ~0.3-0.8% del prezzo. SL a 1.5×ATR = 0.5-1.2% → un wick normale lo prende. Su event-driven dove la news genera volatilità, lo SL viene preso sul rumore prima che la direzione si stabilizzi.

### 4.6 `recordTradeClose` con `pnl=0` per chiusure esterne
[engine.ts:946-952](../src/trading/engine.ts#L946-L952): quando il SoftSL/TP rileva una posizione chiusa "esternamente" (algo order Hyperliquid che ha fatto trigger), registra `pnl=0`. Hai 2 trade con pnl=0 (BTC #24 e BTC #30) — sono **win/loss reali persi** nei dati, mascherati come break-even. Le metriche di WR e PnL sono **sottostimate**.

---

## 5. Insight sulle news (sensor)

- **Throughput news/giorno**: media 660, picchi 900+. Pipeline regge bene.
- **Calo nei weekend**: 28-29 marzo e 4-5 aprile mostrano <300 news (probabile fonte CryptoPanic limit).
- **Ratio HIGH/total**: ~22% costante. Il `classifyImpact` è coerente.
- **Asset coverage**:
  - BTC domina (27% delle news con asset)
  - HYPE, ARB, OP, AAVE — assets in watchlist Hyperliquid — **0 news** raccolte. La keyword extraction nelle source RSS non li riconosce.
- **NEAR e TAO** hanno generato trade pur essendo **fuori dalla watchlist Hyperliquid** ([index.ts:438-445](../src/index.ts#L438-L445)). NEAR sì in lista, TAO **no** — vuol dire che la verifica `isSymbolAvailable` passa ma la watchlist `config.symbols` **non viene applicata** in `event-driven`. Il bot scambia su qualunque asset Hyperliquid abbia, non solo quelli scelti.

---

## 6. Bug e problemi tecnici da sistemare

| # | Bug | File | Impatto |
|---|---|---|---|
| 1 | `recordNewsEvent` salva solo metadata, mai sentiment/confidence/category | [engine.ts:200-213](../src/trading/engine.ts#L200-L213) | Nessun learning da news |
| 2 | RSI/ADX/ATR/volume_ratio non passati a `recordTradeOpen` | [engine.ts:854-868](../src/trading/engine.ts#L854-L868) | Pattern mining cieco |
| 3 | `timeoutHours=4` mai applicato | [event-driven.ts:146](../src/trading/strategies/event-driven.ts#L146) | Trade restano aperti 24h+ |
| 4 | `recordTradeClose(pnl=0)` per chiusure esterne | [engine.ts:946-952](../src/trading/engine.ts#L946-L952) | Metriche WR sbagliate |
| 5 | Composite gate 40 vs Strategist gate 50 | composite-score.ts:204 / engine.ts:490 | Decisioni incoerenti |
| 6 | Strategist `system prompt` impone vincoli > composite (mag>=0.7) | [engine.ts:512-513](../src/trading/engine.ts#L512-L513) | Doppio filtro implicito |
| 7 | Watchlist `config.symbols` ignorata in event-driven | engine.ts:381-385 | Trade su asset non voluti (es. TAO) |
| 8 | `daily_snapshots` mai popolato (0 record) | experience.ts | Nessun report giornaliero |
| 9 | Cron `*/5 * * * *` ma comment dice "ogni 2 minuti" | [wrangler.toml:7](../wrangler.toml#L7) / engine.ts:121 | Discrepanza doc/codice |
| 10 | `seenIds` in-memory perso ad ogni invocation Worker | engine.ts:69 | Dedupe affidato solo a D1 |

---

## 7. Piano d'azione per aumentare WR e volume trade

### 🔴 Priorità 1 — Sblocca il learning (1-2 giorni di lavoro)
1. **Salvare sentiment LLM in news_events** dopo il batch processing — aggiungere update query in `engine.ts` dopo `processBatch`/`processHighImpactItem`.
2. **Passare RSI/ADX/ATR/volume_ratio a `recordTradeOpen`** — calcolarli in `processEventDriven` (sono già disponibili in `setup.atr` e calcolabili da `closes`).
3. **Job di backfill `was_correct`** — cron che legge news con `published_at < now-24h` e calcola `price_24h_change` rispetto al prezzo all'ingresso, valuta se la previsione era corretta.
4. **Fix `recordTradeClose` chiusure esterne** — interroga Hyperliquid per i fill recenti e calcola PnL reale invece di mettere 0.

### 🟠 Priorità 2 — Aumentare volume trade (3-5 giorni)
5. **Allarga estrazione asset nelle news** — mappa keyword → asset più completa, fuzzy match su simboli.
6. **Riduci o rimuovi gate "prezzo mosso 3%"** — su evento news *vuoi* che il prezzo si muova. Cambialo a "prezzo mosso > 8%" (=evento totalmente prezzato).
7. **Allinea composite gate e strategist gate** — entrambi a 50, oppure entrambi a 40. Stop incoerenze.
8. **Rilassa il prompt strategist in EXTREME_FEAR** — invece di `mag>=0.7 AND conf>=0.7` per LONG, usa `composite >= 60`.
9. **Riattiva market-neutral** quando Hyperliquid hedge mode è disponibile (o usa ETH+BTC long+short su account separati). Nel frattempo, abilita strategia momentum su candele 4h come secondo flusso.
10. **Aumenta `maxPositionSizeUsdt`** da $15 → $30 (con $60 account, 50% notional × 2x lev = $60 esposizione, rischio gestibile). Posizioni più grandi assorbono fee meglio.

### 🟡 Priorità 3 — Migliorare WR (5-10 giorni)
11. **Implementa il `timeoutHours=4`** — chiudi trade event-driven dopo 4h se non hanno toccato SL/TP. L'edge dell'evento è esaurito.
12. **SL dinamico su volatilità realizzata, non ATR 14×1h** — usa ATR su 5m moltiplicato per `sqrt(holding_hours_target)`. SL meno tight.
13. **Filtro anti-rimbalzo per SHORT in EXTREME_FEAR** — se F&G < 15 e RSI < 30, **non** aprire short (oversold + sentiment estremo = setup di rimbalzo).
14. **Whitelist watchlist** — verifica che `signal.asset+'USDT'` sia in `config.symbols` prima di passare al composite. Stop trade su TAO et al. che non vuoi.
15. **Sizing adattivo per WR storico** — se l'asset ha WR < 30% sugli ultimi 10 trade, dimezza la size. Se WR > 60%, aumentala.
16. **A/B test composite weights** — il regime pesa 15% ma in EXTREME_FEAR è dominante. Prova `regime: 0.10, momentum: 0.30`.

### 🟢 Priorità 4 — Operatività e visibilità (continuo)
17. **Popolare `daily_snapshots`** — cron giornaliero a fine giornata UTC.
18. **Dashboard `/perf` dettagliato per regime** — oggi tutto è EXTREME_FEAR, ma quando il regime cambierà devi confrontare WR per regime.
19. **Telegram alert quando 24h passano senza trade aperto** — segnale che la pipeline ha problemi o filtri troppo stretti.
20. **Backtest walk-forward su event-driven con i dati attuali** — usa i 17.759 news + prezzi storici per simulare cosa sarebbe successo con threshold diversi.

---

## 8. Stima impatto degli interventi

| Intervento | Effort | Aumento trade/gg atteso | Δ WR atteso |
|---|---|---|---|
| Fix asset extraction (#5) | M | +50-80% | neutrale |
| Allarga gate 3% → 8% (#6) | S | +30% | -3% |
| Allinea composite/strategist (#7+#8) | S | +20-40% | +2% |
| Whitelist watchlist (#14) | S | -10% (filtra rumore) | +5% |
| Filtro anti-rimbalzo SHORT (#13) | M | -15% | **+10-15%** |
| Implementa timeout 4h (#11) | S | neutrale | +5% (no decadimento edge) |
| Salva indicatori (#1+#2) | M | neutrale | abilitazione learning |

**Target realistico a 30 giorni**: 2-3 trade/giorno, WR 35-40%, PnL positivo dopo costi.

---

## 9. Domande aperte (richiedono decisioni di prodotto)

1. **Trade su asset non in watchlist (TAO, NEAR)**: vuoi che il bot operi su qualunque coin Hyperliquid quando ha alta confidenza, o solo sulle 14 selezionate?
2. **Account size**: con $60 di base e fee + min notional $10, sei matematicamente al limite. Ha senso aumentare a $200-500 per dare respiro al sistema?
3. **Strategia in NEUTRAL/RISK_ON**: il bot finora ha visto solo EXTREME_FEAR. Quando F&G salirà, sei comodo con leverage 10x e 15x come da regime config attuale?
4. **Kimi K2 strategist**: tenerlo come gate fail-closed è prudente ma blocca trade quando WorkersAI è lento. Valuta fallback su Claude Haiku.

---

*Generato dall'analisi dei dati al 2026-04-18 — D1 `trading-experience` snapshot.*
