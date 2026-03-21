/**
 * Downloads historical news from CryptoCompare for event-driven backtesting.
 * Uses the data-api.cryptocompare.com endpoint (no auth required).
 *
 * Usage: npx tsx backtest/event-driven-data-fetcher.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const API_BASE = 'https://data-api.cryptocompare.com/news/v1/article/list';
const MONTHS = 6;

interface CryptoCompareArticle {
  ID: number;
  TITLE: string;
  BODY: string;
  PUBLISHED_ON: number;
  URL: string;
  SOURCE_ID: number;
  CATEGORY_DATA?: { NAME: string }[];
}

async function fetchNewsPage(beforeTs?: number, limit: number = 50): Promise<CryptoCompareArticle[]> {
  let url = `${API_BASE}?lang=EN&limit=${limit}`;
  if (beforeTs) {
    url += `&to_ts=${beforeTs}`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`CryptoCompare error: ${res.status}`);
  const data = (await res.json()) as { Data: CryptoCompareArticle[] };
  return data.Data || [];
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('=== Historical News Fetcher (CryptoCompare) ===');
  console.log(`Period: ${MONTHS} months\n`);

  const endTime = Date.now();
  const startTime = endTime - MONTHS * 30 * 24 * 60 * 60 * 1000;
  const startTs = Math.floor(startTime / 1000);

  const allNews: any[] = [];
  let beforeTs: number | undefined = undefined;
  let consecutiveEmpty = 0;

  while (true) {
    try {
      const batch = await fetchNewsPage(beforeTs, 50);
      if (!batch || batch.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty > 3) break;
        continue;
      }
      consecutiveEmpty = 0;

      let addedThisBatch = 0;
      for (const article of batch) {
        if (article.PUBLISHED_ON < startTs) continue;
        allNews.push({
          id: article.ID,
          title: article.TITLE || '',
          body: (article.BODY || '').slice(0, 300),
          publishedOn: article.PUBLISHED_ON,
          categories: (article.CATEGORY_DATA || []).map((c) => c.NAME).join('|'),
          url: article.URL,
        });
        addedThisBatch++;
      }

      // Find oldest article timestamp for pagination
      const oldestTs = Math.min(...batch.map((a) => a.PUBLISHED_ON));
      if (oldestTs < startTs) break;
      beforeTs = oldestTs;

      process.stdout.write(
        `  ${allNews.length} articles (back to ${new Date(oldestTs * 1000).toISOString().split('T')[0]})  \r`
      );

      // Rate limit
      await new Promise((r) => setTimeout(r, 300));

      // Safety: max 5000 articles
      if (allNews.length > 5000) break;
    } catch (err) {
      console.error(`\nFetch error: ${(err as Error).message}`);
      consecutiveEmpty++;
      if (consecutiveEmpty > 5) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Sort chronologically
  allNews.sort((a, b) => a.publishedOn - b.publishedOn);

  // Deduplicate
  const seen = new Set<string>();
  const unique = allNews.filter((a) => {
    const key = a.id.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const filePath = join(DATA_DIR, 'historical_news.json');
  writeFileSync(filePath, JSON.stringify(unique));

  if (unique.length > 0) {
    const firstDate = new Date(unique[0].publishedOn * 1000).toISOString().split('T')[0];
    const lastDate = new Date(unique[unique.length - 1].publishedOn * 1000).toISOString().split('T')[0];
    console.log(`\n\n  ${unique.length} unique articles saved`);
    console.log(`  Period: ${firstDate} to ${lastDate}`);
  } else {
    console.log('\n  No articles found');
  }

  console.log(`  File: ${filePath}`);

  // Stats by keyword
  const keywords = ['hack', 'etf', 'listing', 'partnership', 'crash', 'upgrade', 'sec', 'halving', 'whale', 'airdrop'];
  console.log('\n  High-impact keyword frequency:');
  for (const kw of keywords) {
    const count = unique.filter((a: any) =>
      `${a.title} ${a.body}`.toLowerCase().includes(kw)
    ).length;
    if (count > 0) console.log(`    "${kw}": ${count} articles`);
  }
}

main().catch(console.error);
