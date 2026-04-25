export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const mode = url.searchParams.get('mode') || 'proxy';
    if (!target) return new Response('url param required', { status: 400 });
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja-JP,ja;q=0.9',
          'Accept-Encoding': 'identity',
        }
      });
      const body = await res.text();
      if (mode === 'scrape') {
        const result = scrapeYahooJapanHistory(body);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      return new Response(body, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

function scrapeYahooJapanHistory(html) {
  try {
    const prices = [], dates = [];
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, '').trim();
    let rowMatch;
    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const rowHtml = rowMatch[1];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        cells.push(stripTags(cellMatch[1]));
      }
      if (cells.length >= 5) {
        const dateStr = cells[0];
        const closeStr = cells[4];
        if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(dateStr)) {
          const close = parseFloat(closeStr.replace(/,/g, ''));
          if (!isNaN(close) && close > 0) {
            const parts = dateStr.split('/');
            dates.push(`${parseInt(parts[1])}/${parseInt(parts[2])}`);
            prices.push(close);
          }
        }
      }
      if (prices.length >= 20) break;
    }
    if (prices.length < 3) {
      // デバッグ用: HTMLの一部を返す
      const snippet = html.substring(0, 500);
      return { success: false, message: `データ不足(${prices.length}件)`, snippet };
    }
    return { success: true, prices, dates, count: prices.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
