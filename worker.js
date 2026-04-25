/**
 * Cloudflare Worker: kabu-proxy
 * 機能: 日本株価取得プロキシ
 * URL: https://kabu-proxy.mh10moyuk.workers.dev/
 *
 * 使い方:
 *   ?code=3739   → Stooq(.jp/.nj/.oj/.fj) → Yahoo Finance v8 の順で取得
 *   ?url=<URL>   → 任意URLのプロキシ（汎用モード）
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const code   = url.searchParams.get('code');
    const target = url.searchParams.get('url');

    if (code) return await fetchByCode(code);
    if (target) return await proxyUrl(target);

    return new Response(JSON.stringify({ error: 'code or url param required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

// ─── メイン: Stooq → Yahoo Finance v8 の順で試す ───
async function fetchByCode(code) {
  const pure = code.replace(/\.[a-zA-Z]+$/, '').toLowerCase();

  // ① Stooq CSV（東証→名証→大証→福証）
  const stooqResult = await tryStooq(pure);
  if (stooqResult.success) {
    return jsonResponse(stooqResult);
  }

  // ② Yahoo Finance v8 API（東証→名証→大証の順）
  const yahooResult = await tryYahooFinance(pure);
  if (yahooResult.success) {
    return jsonResponse(yahooResult);
  }

  // 全失敗
  return jsonResponse({
    success: false,
    message: `取得失敗: ${code} (Stooq: ${stooqResult.message} / Yahoo: ${yahooResult.message})`,
    code
  });
}

// ─── Stooq CSV取得 ───
async function tryStooq(pure) {
  const suffixes = ['.jp', '.nj', '.oj', '.fj'];
  for (const suffix of suffixes) {
    const stooqUrl = `https://stooq.com/q/d/l/?s=${pure}${suffix}&i=d`;
    try {
      const res = await fetch(stooqUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/csv,text/plain,*/*',
          'Referer': 'https://stooq.com/',
        }
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.includes('<html') || text.includes('<!DOCTYPE') || text.length < 30) continue;
      if (!text.toLowerCase().includes('date')) continue;

      const parsed = parseStooqCSV(text, pure);
      if (parsed.success) return parsed;
    } catch (e) {
      continue;
    }
  }
  return { success: false, message: 'Stooq全サフィックス失敗' };
}

// ─── Yahoo Finance v8 API取得 ───
async function tryYahooFinance(pure) {
  // 東証→名証→大証→札証の順
  const suffixes = ['.T', '.N', '.O', '.S', '.T'];
  for (const suffix of suffixes) {
    const ticker = pure + suffix;
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=3mo&region=JP&lang=ja-JP`;
    try {
      const res = await fetch(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ja-JP,ja;q=0.9',
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com/',
        }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;

      const quote      = result.indicators?.quote?.[0];
      const closes     = quote?.close;
      const opens_arr  = quote?.open;
      const highs_arr  = quote?.high;
      const lows_arr   = quote?.low;
      const timestamps = result.timestamp;
      if (!closes || !timestamps || closes.length < 3) continue;

      const pairs = timestamps
        .map((t, i) => ({
          date:  new Date(t * 1000),
          close: closes[i],
          open:  opens_arr?.[i],
          high:  highs_arr?.[i],
          low:   lows_arr?.[i]
        }))
        .filter(p => p.close != null && !isNaN(p.close) && p.close > 0)
        .slice(-40)
        .reverse();

      if (pairs.length < 3) continue;

      const name = result.meta?.longName || result.meta?.shortName || ticker;
      return {
        success: true,
        prices: pairs.map(p => p.close),
        opens:  pairs.map(p => p.open  ?? p.close),
        highs:  pairs.map(p => p.high  ?? p.close),
        lows:   pairs.map(p => p.low   ?? p.close),
        dates:  pairs.map(p => `${p.date.getMonth()+1}/${p.date.getDate()}`),
        count:  pairs.length,
        source: `Yahoo(${ticker})`,
        name
      };
    } catch (e) {
      continue;
    }
  }
  return { success: false, message: 'Yahoo全サフィックス失敗' };
}

// ─── Stooq CSVパース ───
function parseStooqCSV(text, code) {
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const dataLines = lines.filter(l => !l.toLowerCase().startsWith('date'));
    if (dataLines.length < 3) {
      return { success: false, message: `データ行不足(${dataLines.length}行)` };
    }

    const recent = dataLines.slice(-50).reverse().slice(0, 40);
    const prices = [], dates = [], opens = [], highs = [], lows = [];

    for (const line of recent) {
      const cols = line.split(',');
      if (cols.length < 5) continue;
      const dateStr  = cols[0].trim();
      const openVal  = parseFloat(cols[1].trim());
      const highVal  = parseFloat(cols[2].trim());
      const lowVal   = parseFloat(cols[3].trim());
      const closeVal = parseFloat(cols[4].trim());
      if (!dateStr || isNaN(closeVal) || closeVal <= 0) continue;
      const parts = dateStr.split('-');
      const label = parts.length >= 3 ? `${parseInt(parts[1])}/${parseInt(parts[2])}` : dateStr;
      prices.push(closeVal);
      dates.push(label);
      opens.push(isNaN(openVal)  ? closeVal : openVal);
      highs.push(isNaN(highVal)  ? closeVal : highVal);
      lows.push(isNaN(lowVal)   ? closeVal : lowVal);
    }

    if (prices.length < 3) {
      return { success: false, message: `有効データ不足(${prices.length}件)` };
    }

    // nameをコードから生成（Stooqはメタ情報を返さないのでコードをそのまま使用）
    return { success: true, prices, dates, opens, highs, lows, count: prices.length, source: 'Stooq', name: code.toUpperCase() };
  } catch (e) {
    return { success: false, message: `パースエラー: ${e.message}` };
  }
}

// ─── 汎用URLプロキシ ───
async function proxyUrl(target) {
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      }
    });
    const contentType = res.headers.get('Content-Type') || 'text/plain';
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ─── JSONレスポンスヘルパー ───
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    }
  });
}
