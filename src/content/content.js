/**
 * Amazon Orders to Google Sheets - Content Script
 * 注文履歴ページの走査制御およびページネーション
 */

(function () {
  // すでに初期化されている場合は多重実行を防ぐ
  if (window.__AMAZON_ORDERS_SCRAPER_INITIALIZED__) return;
  window.__AMAZON_ORDERS_SCRAPER_INITIALIZED__ = true;

  const STORAGE_KEY = 'amazon_orders_sync_session';

  /**
   * ランダム待機 (ms)
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRandomWait(minMs = 1500, maxMs = 2500) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * 現在のセッション状態を取得
   */
  async function getSession() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        resolve(res[STORAGE_KEY] || null);
      });
    });
  }

  /**
   * セッション状態を更新
   */
  async function saveSession(session) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: session }, () => {
        resolve();
      });
    });
  }

  /**
   * セッション状態を破棄
   */
  async function clearSession() {
    return new Promise((resolve) => {
      chrome.storage.local.remove([STORAGE_KEY], () => {
        resolve();
      });
    });
  }

  /**
   * 進捗ステータスを通知
   */
  function broadcastProgress(progressData) {
    try {
      chrome.runtime.sendMessage({
        action: 'SCRAPING_PROGRESS',
        ...progressData
      });
    } catch {
      // 受信側（Popup）が閉じている場合は無視
    }
  }

  /**
   * 現ページの注文をパースして処理
   */
  async function processCurrentPage() {
    const session = await getSession();
    if (!session || !session.isRunning) return;

    const { targetYearMonth, pageIndex = 1, accumulatedItems = [] } = session;

    broadcastProgress({
      status: 'parsing',
      page: pageIndex,
      itemCount: accumulatedItems.length,
      message: `ページ ${pageIndex} を解析中...`
    });

    // 注文カードを取得
    const orderCards = AmazonScraper.getOrderCards(document);
    let reachedOlderMonth = false;
    let pageItems = [];

    for (const card of orderCards) {
      const parsed = AmazonScraper.parseOrderCard(card);
      if (!parsed.orderDate) {
        // 日付が取れなかった場合は念のため対象に含めるか判定
        continue;
      }

      // 日付の年月判定 (YYYY-MM)
      const orderYearMonth = parsed.orderDate.substring(0, 7);

      if (orderYearMonth === targetYearMonth) {
        // 対象月の注文
        for (const item of parsed.items) {
          pageItems.push(item);
        }
      } else if (orderYearMonth < targetYearMonth) {
        // 対象月より古い注文に到達（注文一覧は降順に並んでいるため、これ以降は全て古い）
        reachedOlderMonth = true;
        break;
      } else {
        // 対象月より新しい注文（未来）はスキップして継続
      }
    }

    const newAccumulated = accumulatedItems.concat(pageItems);

    broadcastProgress({
      status: 'page_finished',
      page: pageIndex,
      itemCount: newAccumulated.length,
      message: `ページ ${pageIndex}: 今回 ${pageItems.length} 件抽出（合計 ${newAccumulated.length} 件）`
    });

    // 終了判定: 古い月に到達した、または次ページが存在しない
    const nextPageEl = AmazonScraper.getNextPageElement(document);

    if (reachedOlderMonth || !nextPageEl) {
      // 走査完了！スプレッドシートへの送信を開始
      broadcastProgress({
        status: 'syncing',
        page: pageIndex,
        itemCount: newAccumulated.length,
        message: `データ抽出完了（全 ${newAccumulated.length} 件）。スプレッドシートへ送信中...`
      });

      // Backgroundに送信を依頼
      try {
        const sendResponse = await chrome.runtime.sendMessage({
          action: 'SUBMIT_ORDERS_TO_GAS',
          orders: newAccumulated
        });

        if (sendResponse && sendResponse.success) {
          broadcastProgress({
            status: 'completed',
            itemCount: newAccumulated.length,
            insertedCount: sendResponse.insertedCount,
            skippedCount: sendResponse.skippedCount,
            message: `連携完了！追加: ${sendResponse.insertedCount}件, 重複スキップ: ${sendResponse.skippedCount}件`
          });
        } else {
          broadcastProgress({
            status: 'error',
            error: sendResponse?.error || 'スプレッドシートへの書き込みに失敗しました。',
            message: `連携失敗: ${sendResponse?.error || '通信エラー'}`
          });
        }
      } catch (err) {
        broadcastProgress({
          status: 'error',
          error: err.message,
          message: `エラー: ${err.message}`
        });
      } finally {
        await clearSession();
      }

      return;
    }

    // 次のページへ進む
    const waitTime = getRandomWait(1500, 2500);
    broadcastProgress({
      status: 'waiting',
      page: pageIndex,
      itemCount: newAccumulated.length,
      waitMs: waitTime,
      message: `次ページへ移動します（${(waitTime / 1000).toFixed(1)}秒 待機中...）`
    });

    // 次のページ情報をセッションに保存
    await saveSession({
      ...session,
      pageIndex: pageIndex + 1,
      accumulatedItems: newAccumulated
    });

    await sleep(waitTime);

    // 最新のセッション状態を確認（ユーザーからの中止がないか）
    const checkSession = await getSession();
    if (!checkSession || !checkSession.isRunning) {
      broadcastProgress({
        status: 'cancelled',
        message: '処理がユーザーによって中断されました。'
      });
      return;
    }

    // 次ページをクリック、または遷移
    const nextHref = nextPageEl.getAttribute('href');
    if (nextHref) {
      window.location.href = nextHref;
    } else {
      nextPageEl.click();
    }
  }

  // メッセージリスナー
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_SYNC') {
      const { targetYearMonth } = request;
      const initialSession = {
        isRunning: true,
        targetYearMonth,
        pageIndex: 1,
        accumulatedItems: [],
        startedAt: Date.now()
      };

      saveSession(initialSession).then(() => {
        sendResponse({ success: true });
        processCurrentPage();
      });
      return true; // 非同期応答
    }

    if (request.action === 'CANCEL_SYNC') {
      clearSession().then(() => {
        sendResponse({ success: true });
        broadcastProgress({
          status: 'cancelled',
          message: '処理が中断されました。'
        });
      });
      return true;
    }

    if (request.action === 'GET_CONTENT_STATUS') {
      getSession().then((session) => {
        sendResponse({
          session,
          isAmazonOrdersPage: window.location.href.includes('/your-orders/') || window.location.href.includes('/order-history')
        });
      });
      return true;
    }
  });

  // ページ読み込み完了時に、実行中のセッションがあれば自動継続
  getSession().then((session) => {
    if (session && session.isRunning) {
      // 読み込み直後のわずかなレンダリング待ち
      setTimeout(processCurrentPage, 800);
    }
  });
})();
