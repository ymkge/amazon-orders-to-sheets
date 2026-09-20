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
   */
  function parseAmount(rawStr) {
    if (!rawStr) return null;
    const match = rawStr.replace(/,/g, '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
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
    // Amazonの注文日ヘッダー
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
    // 合計ラベルに続く値を探す
    const labels = cardEl.querySelectorAll('.a-column, .a-span2, .a-span3, .order-header-item, div');
    for (const col of labels) {
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
      // 全体から "￥1,234" パターンを探す
      const priceMatch = cardEl.textContent.match(/￥\s*([\d,]+)/);
      if (priceMatch) {
        totalAmount = parseAmount(priceMatch[1]);
      }
    }

    // 4. 商品一覧のパース
    const items = [];
    // 商品ブロックセレクタの候補
    let itemElements = cardEl.querySelectorAll('.yohtmlc-item, .shipment .a-fixed-left-grid, [data-component-type="itemCard"]');
    
    // 見つからない場合は商品リンクを持つ親ブロックを探す
    if (!itemElements || itemElements.length === 0) {
      const links = cardEl.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
      const itemBlocks = new Set();
      for (const link of links) {
        // 画像リンクではなくテキストリンクを優先
        if (link.textContent.trim()) {
          const block = link.closest('.a-fixed-left-grid') || link.closest('.a-row') || link.parentElement;
          if (block) itemBlocks.add(block);
        }
      }
      itemElements = Array.from(itemBlocks);
    }

    if (itemElements.length > 0) {
      for (const itemEl of itemElements) {
        const link = itemEl.querySelector('a[href*="/dp/"], a[href*="/gp/product/"], a.a-link-normal');
        const title = link ? link.textContent.trim() : '';
        const href = link ? link.getAttribute('href') : '';

        // 数量
        let quantity = 1;
        const qtyMatch = itemEl.textContent.match(/数量[：:]\s*(\d+)/) || itemEl.textContent.match(/Qty[：:]\s*(\d+)/i);
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1], 10);
        }

        // 商品単価
        let price = null;
        const priceEl = itemEl.querySelector('.a-color-price, .a-size-small.a-color-price, .item-price, .a-price .a-offscreen');
        if (priceEl) {
          price = parseAmount(priceEl.textContent);
        } else {
          // 要素が見つからない場合、単価または￥のテキストマッチを試みる
          const itemPriceMatch = itemEl.textContent.match(/(?:単価|価格)?\s*￥\s*([\d,]+)/);
          if (itemPriceMatch) {
            price = parseAmount(itemPriceMatch[1]);
          }
        }

        if (title) {
          items.push({
            orderId: orderId || '',
            orderDate: orderDate || '',
            title: title.replace(/\s+/g, ' '),
            price: price,
            quantity: quantity,
            totalAmount: totalAmount,
            productUrl: cleanProductUrl(href)
          });
        }
      }
    }

    // 商品が見つからなかったが注文カードが存在する場合のフォールバック
    if (items.length === 0 && orderId) {
      const anyLink = cardEl.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const title = anyLink ? anyLink.textContent.trim().replace(/\s+/g, ' ') : '(商品名取得不能)';
      const href = anyLink ? anyLink.getAttribute('href') : '';
      items.push({
        orderId: orderId,
        orderDate: orderDate || '',
        title: title,
        price: null,
        quantity: 1,
        totalAmount: totalAmount,
        productUrl: cleanProductUrl(href)
      });
    }

    return {
      orderId,
      orderDate,
      totalAmount,
      items
    };
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
        // yohtmlc-order-id の場合は親カード要素まで遡る
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
    // Amazonのページネーション構造
    // ul.a-pagination li.a-last:not(.a-disabled) a
    const nextBtn = doc.querySelector('ul.a-pagination li.a-last:not(.a-disabled) a, .a-pagination .a-last:not(.a-disabled) a');
    if (nextBtn) return nextBtn;

    // 「次へ」テキストを含むリンク
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
    parseOrderCard,
    getOrderCards,
    getNextPageElement
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AmazonScraper;
}
