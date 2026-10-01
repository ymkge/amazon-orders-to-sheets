/**
 * Amazon注文履歴 DOM スクレイパー
 */

const AmazonScraper = (() => {
  /**
   * 日付文字列を YYYY-MM-DD に正規化
   * 例: "2026年5月12日", "2026/05/12", "12 May 2026"
   */
  function parseDate(rawDateStr) {
    if (!rawDateStr) return null;
    const str = rawDateStr.trim();

    // 日本語形式: 2026年5月12日
    const jpMatch = str.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    if (jpMatch) {
      const year = jpMatch[1];
      const month = String(jpMatch[2]).padStart(2, '0');
      const day = String(jpMatch[3]).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // スラッシュ形式: 2026/05/12
    const slashMatch = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (slashMatch) {
      const year = slashMatch[1];
      const month = String(slashMatch[2]).padStart(2, '0');
      const day = String(slashMatch[3]).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // Dateパースのフォールバック
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    return null;
  }

  /**
   * 金額文字列から数値を抽出（例: "￥3,500" -> 3500）
   * 日付の年号（例: 2026年）などの単独数字を誤認しないよう、通貨記号付きを優先
   */
  function parseAmount(rawStr) {
    if (!rawStr) return null;
    // 1. ￥ または ¥ または JPY に続く数値を最優先
    const yenMatch = rawStr.match(/[￥¥\\]\s*([\d,]+)/);
    if (yenMatch) {
      return parseInt(yenMatch[1].replace(/,/g, ''), 10);
    }
    // 2. ○○円 パターン
    const enMatch = rawStr.match(/([\d,]+)\s*円/);
    if (enMatch) {
      return parseInt(enMatch[1].replace(/,/g, ''), 10);
    }
    // 3. 通貨記号無しの単独数値（￥記号が無い要素専用）
    const pureNumMatch = rawStr.replace(/,/g, '').match(/(\d+)/);
    if (pureNumMatch) {
      const val = parseInt(pureNumMatch[1], 10);
      if (val >= 2020 && val <= 2035 && rawStr.includes('年')) {
        return null;
      }
      return val;
    }
    return null;
  }

  /**
   * 商品URLのクリーンアップ（クエリパラメータやリファラーの除去）
   */
  function cleanProductUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(url, 'https://www.amazon.co.jp');
      // /dp/ASIN パターン
      const dpMatch = parsed.pathname.match(/\/dp\/([A-Z0-9]{10})/i);
      if (dpMatch) {
        return `https://www.amazon.co.jp/dp/${dpMatch[1]}`;
      }
      // /gp/product/ASIN パターン
      const gpMatch = parsed.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/i);
      if (gpMatch) {
        return `https://www.amazon.co.jp/dp/${gpMatch[1]}`;
      }
      return parsed.origin + parsed.pathname;
    } catch {
      return url;
    }
  }

  /**
   * リンク要素から商品タイトルを確実に抽出
   */
  function extractTitleFromLink(linkEl) {
    if (!linkEl) return '';
    const text = linkEl.textContent ? linkEl.textContent.trim().replace(/\s+/g, ' ') : '';
    if (text && text.length > 1) {
      return text;
    }
    const img = linkEl.querySelector ? linkEl.querySelector('img') : null;
    if (img && img.getAttribute('alt')) {
      const alt = img.getAttribute('alt').trim().replace(/\s+/g, ' ');
      if (alt) return alt;
    }
    if (linkEl.getAttribute && linkEl.getAttribute('title')) {
      const titleAttr = linkEl.getAttribute('title').trim().replace(/\s+/g, ' ');
      if (titleAttr) return titleAttr;
    }
    return text || '';
  }

  /**
   * 注文番号の正規表現抽出（例: "503-1234567-1234567"）
   */
  function extractOrderId(text) {
    if (!text) return null;
    const match = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
    return match ? match[1] : null;
  }

  /**
   * 1つの注文カード要素から注文詳細をパース
   */
  function parseOrderCard(cardEl) {
    // 1. 注文日
    let orderDate = null;
    const dateHeaders = cardEl.querySelectorAll('.a-color-secondary.value, .order-header span, .a-row span');
    for (const el of dateHeaders) {
      const parsed = parseDate(el.textContent);
      if (parsed) {
        orderDate = parsed;
        break;
      }
    }
    if (!orderDate) {
      orderDate = parseDate(cardEl.textContent);
    }

    // 2. 注文番号
    let orderId = null;
    const orderIdEl = cardEl.querySelector('.yohtmlc-order-id, [data-component-type="orderId"], bdi[dir="ltr"]');
    if (orderIdEl) {
      orderId = extractOrderId(orderIdEl.textContent);
    }
    if (!orderId) {
      orderId = extractOrderId(cardEl.textContent);
    }

    // 3. 注文合計金額
    let totalAmount = null;
    const headerCols = cardEl.querySelectorAll('.a-column, .a-span2, .a-span3, .order-header-item, .order-header div');
    for (const col of headerCols) {
      const text = col.textContent;
      if (text.includes('合計') || text.includes('TOTAL') || text.includes('注文合計')) {
        const valEl = col.querySelector('.a-color-secondary.value, .value, span:last-child');
        if (valEl) {
          totalAmount = parseAmount(valEl.textContent);
          if (totalAmount !== null) break;
        }
        totalAmount = parseAmount(text);
        if (totalAmount !== null) break;
      }
    }
    if (totalAmount === null) {
      const yenMatch = cardEl.textContent.match(/[￥¥\\]\s*([\d,]+)/);
      if (yenMatch) {
        totalAmount = parseInt(yenMatch[1].replace(/,/g, ''), 10);
      }
    }

    // 4. 注文詳細URLの抽出
    let detailUrl = null;
    const detailLink = cardEl.querySelector('a[href*="order-details"], a[href*="order-summary"]');
    if (detailLink) {
      const href = detailLink.getAttribute('href');
      if (href) {
        detailUrl = href.startsWith('http') ? href : `https://www.amazon.co.jp${href}`;
      }
    }
    if (!detailUrl && orderId) {
      detailUrl = `https://www.amazon.co.jp/your-account/order-details?orderID=${orderId}`;
    }

    // 5. 商品一覧のパース
    const items = [];
    let productLinks = cardEl.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
    
    // 見つからない場合は商品ブロック内のリンクを探す
    if (!productLinks || productLinks.length === 0) {
      const blocks = cardEl.querySelectorAll('.yohtmlc-item, .shipment, [data-component-type="itemCard"]');
      const blockLinks = [];
      for (const b of blocks) {
        if (b.querySelectorAll) {
          const found = b.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"], a.a-link-normal');
          for (const fl of found) {
            fl.__parentBlock = b;
            blockLinks.push(fl);
          }
        } else if (b.querySelector) {
          const fl = b.querySelector('a[href*="/dp/"], a[href*="/gp/product/"], a.a-link-normal');
          if (fl) {
            fl.__parentBlock = b;
            blockLinks.push(fl);
          }
        }
      }
      productLinks = blockLinks;
    }

    const productMap = new Map();

    for (const link of productLinks) {
      const href = link.getAttribute('href');
      const cleanUrl = cleanProductUrl(href);
      if (!cleanUrl) continue;

      const title = extractTitleFromLink(link);

      // 親コンテナ（商品ブロック）の特定
      const itemBlock = link.__parentBlock ||
        (link.closest ? (
          link.closest('.yohtmlc-item') ||
          link.closest('.a-fixed-left-grid') ||
          link.closest('.a-row')
        ) : null) || link.parentElement;

      // 数量の抽出
      let quantity = 1;
      if (itemBlock) {
        const qtyMatch = itemBlock.textContent.match(/数量[：:]\s*(\d+)/) || itemBlock.textContent.match(/Qty[：:]\s*(\d+)/i);
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1], 10);
        }
      }

      // 単価の抽出（オフスクリーン価格を優先）
      let price = null;
      if (itemBlock) {
        const offscreenPrice = itemBlock.querySelector ? itemBlock.querySelector('.a-price .a-offscreen') : null;
        if (offscreenPrice) {
          price = parseAmount(offscreenPrice.textContent);
        }
        if (price === null) {
          const priceEl = itemBlock.querySelector ? itemBlock.querySelector('.a-color-price, .a-size-small.a-color-price, .item-price') : null;
          if (priceEl) {
            price = parseAmount(priceEl.textContent);
          } else if (itemBlock.textContent) {
            const itemPriceMatch = itemBlock.textContent.match(/(?:単価|価格)?\s*[￥¥\\]\s*([\d,]+)/);
            if (itemPriceMatch) {
              price = parseInt(itemPriceMatch[1].replace(/,/g, ''), 10);
            }
          }
        }
      }

      if (productMap.has(cleanUrl)) {
        const existing = productMap.get(cleanUrl);
        if (!existing.title && title) {
          existing.title = title;
        }
        if (!existing.price && price) {
          existing.price = price;
        }
      } else {
        productMap.set(cleanUrl, {
          orderId: orderId || '',
          orderDate: orderDate || '',
          title: title,
          price: price,
          quantity: quantity,
          totalAmount: totalAmount,
          productUrl: cleanUrl
        });
      }
    }

    for (const item of productMap.values()) {
      // 1点買いで単価が明記されていない場合、注文合計を単価として補完
      if (item.price === null && productMap.size === 1 && item.quantity === 1 && totalAmount !== null) {
        item.price = totalAmount;
      }
      items.push(item);
    }

    // 商品が見つからなかった場合のフォールバック
    if (items.length === 0 && orderId) {
      items.push({
        orderId: orderId,
        orderDate: orderDate || '',
        title: '(商品名取得不能)',
        price: totalAmount,
        quantity: 1,
        totalAmount: totalAmount,
        productUrl: ''
      });
    }

    return {
      orderId,
      orderDate,
      totalAmount,
      detailUrl,
      items
    };
  }

  /**
   * 注文詳細HTML（Order Details）から各商品の個別単価をマッピング抽出
   * @param {string|Document} docOrHtml 
   * @returns {Map<string, number>} cleanUrl -> price の Map
   */
  function parseOrderDetailPrices(docOrHtml) {
    let doc = docOrHtml;
    if (typeof docOrHtml === 'string') {
      if (typeof DOMParser !== 'undefined') {
        doc = new DOMParser().parseFromString(docOrHtml, 'text/html');
      } else {
        return new Map();
      }
    }

    const priceMap = new Map();
    if (!doc || !doc.querySelectorAll) return priceMap;

    // 注文詳細画面内の商品行・ブロック候補
    const itemRows = doc.querySelectorAll(
      '.od-item-view-row, tr.item-row, .a-fixed-left-grid, [data-component-type="orderItem"], .yohtmlc-item, .shipment-item'
    );

    for (const row of itemRows) {
      const link = row.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      if (!link) continue;

      const cleanUrl = cleanProductUrl(link.getAttribute('href'));
      if (!cleanUrl) continue;

      // 価格要素の検索
      let price = null;
      const offscreenEl = row.querySelector('.a-price .a-offscreen');
      if (offscreenEl) {
        price = parseAmount(offscreenEl.textContent);
      }
      if (price === null) {
        const priceEl = row.querySelector('.a-color-price, .item-price, .yohtmlc-item-price, span.a-size-small.a-color-price');
        if (priceEl) {
          price = parseAmount(priceEl.textContent);
        }
      }
      if (price === null && row.textContent) {
        const textMatch = row.textContent.match(/[￥¥\\]\s*([\d,]+)/);
        if (textMatch) {
          price = parseInt(textMatch[1].replace(/,/g, ''), 10);
        }
      }

      if (price !== null && !priceMap.has(cleanUrl)) {
        priceMap.set(cleanUrl, price);
      }
    }

    // デジタル注文（Kindle等のテーブルレイアウト）へのフォールバック
    if (priceMap.size === 0) {
      const allLinks = doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
      for (const link of allLinks) {
        const cleanUrl = cleanProductUrl(link.getAttribute('href'));
        if (!cleanUrl || priceMap.has(cleanUrl)) continue;

        // リンクの親要素または兄弟要素から最も近い価格を探す
        const parent = link.closest('tr') || link.closest('.a-row') || link.parentElement;
        if (parent) {
          const priceEl = parent.querySelector('.a-color-price, .a-price .a-offscreen');
          if (priceEl) {
            const p = parseAmount(priceEl.textContent);
            if (p !== null) priceMap.set(cleanUrl, p);
          }
        }
      }
    }

    return priceMap;
  }

  /**
   * 均等案分フォールバック（詳細取得に失敗した場合に単価空欄を防止）
   */
  function enrichMissingPricesWithProRata(items, totalAmount) {
    if (!Array.isArray(items) || items.length === 0) return;
    const missingItems = items.filter(it => it.price === null || it.price === undefined);
    if (missingItems.length === 0) return;

    if (totalAmount !== null && totalAmount > 0) {
      // 既知の単価合計を差し引く
      let knownSum = 0;
      for (const it of items) {
        if (it.price !== null && it.price !== undefined) {
          knownSum += it.price * (it.quantity || 1);
        }
      }
      const remainingTotal = Math.max(0, totalAmount - knownSum);
      const remainingCount = missingItems.reduce((acc, it) => acc + (it.quantity || 1), 0);
      const proRataPrice = remainingCount > 0 ? Math.round(remainingTotal / remainingCount) : 0;

      for (const it of missingItems) {
        it.price = proRataPrice;
      }
    }
  }

  /**
   * 現在のページ内にある全注文カードを取得
   */
  function getOrderCards(doc = document) {
    const selectors = [
      '.order-card',
      '[data-component-type="orderCard"]',
      '.yohtmlc-order-id',
      '.order',
      '#ordersContainer > .a-box-group',
      '#ordersContainer .order'
    ];

    for (const sel of selectors) {
      const cards = doc.querySelectorAll(sel);
      if (cards && cards.length > 0) {
        if (sel === '.yohtmlc-order-id') {
          const parentCards = [];
          for (const el of cards) {
            const card = el.closest('.order-card') || el.closest('.a-box-group') || el.closest('.order') || el.parentElement;
            if (card && !parentCards.includes(card)) {
              parentCards.push(card);
            }
          }
          if (parentCards.length > 0) return parentCards;
        }
        return Array.from(cards);
      }
    }
    return [];
  }

  /**
   * 次ページリンク/ボタンを取得
   */
  function getNextPageElement(doc = document) {
    const nextBtn = doc.querySelector('ul.a-pagination li.a-last:not(.a-disabled) a, .a-pagination .a-last:not(.a-disabled) a');
    if (nextBtn) return nextBtn;

    const allLinks = doc.querySelectorAll('ul.a-pagination a');
    for (const a of allLinks) {
      const text = a.textContent.trim();
      if (text.includes('次へ') || text.toLowerCase().includes('next')) {
        const li = a.closest('li');
        if (!li || !li.classList.contains('a-disabled')) {
          return a;
        }
      }
    }

    return null;
  }

  return {
    parseDate,
    parseAmount,
    cleanProductUrl,
    extractOrderId,
    extractTitleFromLink,
    parseOrderCard,
    parseOrderDetailPrices,
    enrichMissingPricesWithProRata,
    getOrderCards,
    getNextPageElement
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmazonScraper;
}
