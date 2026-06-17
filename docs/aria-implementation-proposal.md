# Documento di Valutazione Architetturale: Progetto ARIA (Multi-Strategy Quant Bot)

## 1. Executive Summary

Il presente documento analizza l'evoluzione architetturale del progetto **ARIA**, un trading bot quantitativo basato su infrastruttura serverless (Cloudflare Workers) e database relazionale distribuito (Cloudflare D1).
L'obiettivo della revisione è la transizione da un approccio puramente _Event-Driven_ e direzionale, altamente vulnerabile alla latenza, verso un modello multi-strategia a bassa volatilità. Il nuovo core si focalizza su **ricavi positivi costanti**, sfruttando inefficienze matematiche (_Statistical Arbitrage_) e tassi di interesse (_Funding Rate Arbitrage_) operando esclusivamente sui contratti Perpetual dell'exchange decentralizzato **Hyperliquid L1**.

## 2. Analisi dell'Infrastruttura e Limiti Tecnici

La scelta di operare su Cloudflare Workers impone specifici vincoli architetturali che sono stati integrati nel design strategico:

- **Assenza di WebSockets:** Il bot opera tramite Cron Triggers (limite minimo: 1 minuto). Questo esclude categoricamente strategie di _High-Frequency Trading_ (HFT) e _Passive Market Making_, che richiederebbero aggiustamenti degli ordini nell'ordine dei millisecondi.
- **Vantaggio Hyperliquid:** Le taker fee minime (0.035% o inferiori) e l'esecuzione on-chain senza gas fee compensano i limiti di latenza, permettendo al bot di operare in profitto anche su spread ridotti.

## 3. Matrice Strategica e Valutazione delle Performance (Sintesi)

Per massimizzare il ROI e minimizzare il drawdown, il sistema implementa 4 strategie concorrenti. Di seguito la tabella valutativa delle singole gambe operative:

| Strategia                            | Compatibilità Workers | Cron Separati | Descrizione Operativa                                                                                | Punti di Forza Reali (Attuali)                                                   | Punti Deboli (Attuali)                                                             | Voto Base  | Miglioramento Suggerito                                                                                                  | Voto Ottimizzato |
| :----------------------------------- | :-------------------- | :------------ | :--------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- | :--------- | :----------------------------------------------------------------------------------------------------------------------- | :--------------- |
| **1. Statistical Arbitrage (Pairs)** | ✅ Sì                 | Ogni 1-4 min  | Individua coppie cointegrate (Z-Score) per andare Long sul sottovalutato e Short sul sopravvalutato. | Matematica pura, nessuna dipendenza da LLM. Alta % di successo (mean reversion). | Tail Risk: se la correlazione si rompe (es. hack su un token), il DD esplode.      | **8.5/10** | **Trailing SL sul PnL Netto Combinato.** Chiusura automatica se lo spread diverge irreversibilmente oltre la soglia.     | **9.5/10**       |
| **2. Funding Rate Arbitrage**        | ✅ Sì                 | Ogni 1 ora    | Va Long dove il funding è fortemente negativo e Short dove è positivo, incassando i pagamenti.       | Genera rendita fissa passiva sfruttando i tassi orari di Hyperliquid.            | Il prezzo dei due perpetual può divergere pesantemente mentre si incassa il tasso. | **7.5/10** | **Trailing SL sul PnL Combinato.** Taglio al mercato se il differenziale di prezzo (delta) erode i profitti del funding. | **8.5/10**       |
| **3. Event-Driven (News)**           | ✅ Sì                 | Ogni 1 min    | Analizza feed/social, usa LLM per sentiment/magnitudo e apre posizioni direzionali.                  | Eccellente difesa: Trailing SL, timeout asimmetrici, controllo divergenze.       | Latenza critica: tempi del cron + inferenza LLM causano slippage sulle news.       | **5/10**   | **Cron a 1 minuto.** Abbassare il trigger da 4 a 1 minuto per quadruplicare la reattività alle news.                     | **6.5/10**       |
| **4. Market-Neutral (Sentiment)**    | ✅ Sì                 | Ogni 4 ore    | Usa score composito LLM per andare Long sui top N e Short sui bottom N.                              | Annulla il rischio direzionale e ripartisce il capitale.                         | Falsa cointegrazione: buone/cattive news non garantiscono convergenza dei prezzi.  | **4/10**   | **Strategia di Fallback.** Opererà per ultima, aprendo posizioni solo su asset ignorati dalle altre tre strategie.       | **5.5/10**       |

## 4. Regole di Allocazione Dinamica (Resource Budgeting)

Per evitare conflitti tra le strategie e ottimizzare l'uso del capitale, il sistema utilizza un gestore di slot dinamico governato da D1:

- **Gerarchia di Esecuzione (Anti-Collisione):** Le strategie non possono avere posizioni aperte (o opposte) sullo stesso simbolo in contemporanea. L'ordine di priorità di assegnazione è: _StatArb -> Funding Arb -> Event-Driven -> Sentiment_.
- **Capacità del Sistema:** Esposizione massima bloccata a **13 slot simultanei**.
- **Slot Base vs Bonus:** Ogni strategia riceve 2 slot garantiti (totale 8). Un pool di 5 slot "bonus" fluttuanti viene riassegnato ogni 24h: la strategia con il miglior Profit Factor nelle ultime 48h riceve +3 slot; la seconda +2. Una strategia con 3 perdite di fila perde immediatamente i suoi slot bonus.

## 5. Risk Management e Halt System (Sistema di Salvaguardia)

Operando su conto _Cross Margin_, la protezione dell'equity è compartimentata a livello software tramite tre livelli di kill-switch:

1. **Livello 1: Trailing SL di Coppia (Specifico):** Per lo _StatArb_ e il _Funding Arb_, il sistema calcola la somma algebrica del PnL delle due gambe. Se il PnL combinato scende sotto il -1.5% del budget virtuale assegnato, la coppia viene liquidata al mercato.
2. **Livello 2: Auto-Pause (Circuito Isolato):** Se una strategia registra 3 Stop Loss consecutivi nella stessa giornata, il database D1 imposta il flag della singola strategia in pausa per 6 ore, liberando il capitale per le strategie performanti senza fermare il bot.
3. **Livello 3: Daily Halt (Blocco Globale):** Controllo costante dell'equity (Wallet Balance + Unrealized PnL). Se il PnL totale giornaliero tocca il **-2.0%** (Drawdown massimo tollerato), si innesca l'Halt Globale. Vengono rifiutate nuove aperture per tutte le strategie fino a mezzanotte (UTC), mantenendo attiva solo la logica di uscita per le posizioni in corso.

## 6. Conclusione e Valutazione Finale per l'Auditor

**Verdetto: Altamente Sostenibile.**
Il progetto ARIA, con le modifiche suggerite, trasforma una vulnerabilità infrastrutturale (la latenza di Cloudflare Workers) in un non-problema, spostando il focus dal _timing_ (battere il mercato sul tempo) alla _matematica_ (arbitraggio statistico e cattura del rendimento).

L'approccio a "Matrice Dinamica" crea un mini-hedge fund resiliente:

- Il rischio direzionale è quasi azzerato (grazie alle gambe Long/Short in accoppiata).
- L'esposizione al rischio è rigidamente controllata matematicamente (massimo 300% di leva globale sul conto).
- Il sistema multi-livello di Halt protegge contro cigni neri e rotture strutturali delle correlazioni.

**IMPORTANTE:** Quanto sopra è da valutare attentamente e richiede una fase di validazione live su exchange. Lo scopo non è complicare il progetto o aggiungere per forza ulteriori strategie ma è quello di massimizzare il MRR, rendere costante il profitto mitigando o annichilendo le potenziali perdite che se presenti devono essere contenute e predicibili.
