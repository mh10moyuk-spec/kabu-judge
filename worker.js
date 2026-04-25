/**
 * Cloudflare Worker: kabu-proxy
 * 機能: Stooq CSV取得プロキシ（日本株専用）
 * URL: https://kabu-proxy.mh10moyuk.workers.dev/
 *
 * 使い方:
 *   ?code=3739        → Stooqから自動サフィックス試行(.jp/.nj/.fj)でCSVを取得
 *   ?url=<任意URL>    → 任意URLのプロキシ（汎用モード）
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

    const code = url.searchParams.get('code');
    const target = url.searchParams.get('url');

    // --- モード1: ?code=3739 → Stooqから株価CSV自動取得 ---
    if (code) {
      return await fetchStooqByCode(code);
    }

    // --- モード2: ?url=<target> → 汎用プロキシ ---
    if (target) {
      return await proxyUrl(target);
    }

    return new Response(JSON.stringify({ error: 'code or url param required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};

// Stooqで株価CSVを取得（東証→名証→大証→福証の順に試行）
async function fetchStooqByCode(code) {
  const pure = code.replace(/\.[a-zA-Z]+$/, '').toLowerCase();

  // 取引所サフィックスを順に試す
  const suffixes = ['.jp', '.nj', '.oj', '.fj'];

  for (const suffix of suffixes) {
    const stooqUrl = `https://stooq.com/q/d/l/?s=${pure}${suffix}&i=d`;
    try {
      const res = await fetch(stooqUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/csv,text/plain,*/*',
          'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.5',
          'Referer': 'https://stooq.com/',
        },
        cf: { cacheTtl: 300 } // 5分キャッシュ
      });

      if (!res.ok) continue;

      const text = await res.text();

      // HTMLが返ってきた場合（データなし）はスキップ
      if (text.includes('<html') || text.includes('<!DOCTYPE') || text.length < 30) continue;

      // ヘッダー行チェック
      if (!text.toLowerCase().includes('date')) continue;

      // CSVをパース
      const parsed = parseStooqCSV(text, code);
      if (parsed.success && parsed.prices.length >= 3) {
        return new Response(JSON.stringify(parsed), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300',
          }
        });
      }

    } catch (e) {
      // このサフィックスは失敗、次へ
      continue;
    }
  }

  // 全サフィックス失敗
  return new Response(JSON.stringify({
    success: false,
    message: `データ取得失敗: ${code} (Stooq全サフィックス試行済み)`,
    code
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

// StooqのCSVをパース
function parseStooqCSV(text, code) {
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());

    // ヘッダー行を除外
    const dataLines = lines.filter(l => !l.toLowerCase().startsWith('date'));

    if (dataLines.length < 3) {
      return { success: false, message: `データ行不足(${dataLines.length}行)` };
    }

    // 最新20日分（末尾から20件、降順に並べる）
    const recent = dataLines.slice(-30).reverse().slice(0, 20);

    const prices = [];
    const dates  = [];

    for (const line of recent) {
      const cols = line.split(',');
      if (cols.length < 5) continue;

      const dateStr = cols[0].trim(); // YYYY-MM-DD
      const closeVal = parseFloat(cols[4].trim()); // Close

      if (!dateStr || isNaN(closeVal) || closeVal <= 0) continue;

      const parts = dateStr.split('-');
      const label = parts.length >= 3
        ? `${parseInt(parts[1])}/${parseInt(parts[2])}`
        : dateStr;

      prices.push(closeVal);
      dates.push(label);
    }

    if (prices.length < 3) {
      return { success: false, message: `有効データ不足(${prices.length}件)` };
    }

    return {
      success: true,
      prices,
      dates,
      count: prices.length,
      source: 'Stooq'
    };

  } catch (e) {
    return { success: false, message: `パースエラー: ${e.message}` };
  }
}

// 汎用URLプロキシ
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
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
