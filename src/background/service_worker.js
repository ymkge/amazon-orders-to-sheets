/**
 * Amazon Orders to Google Sheets - Background Service Worker
 */

const LAST_STATUS_KEY = 'amazon_orders_last_progress';

// インストール時の初期処理
chrome.runtime.onInstalled.addListener(() => {
  console.log('Amazon Orders to Google Sheets Extension Installed/Updated.');
});

/**
 * GASへのHTTP POSTリクエスト送信（CORSおよびリダイレクト対応）
 */
async function sendToGas(gasUrl, payload) {
  try {
    const response = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8' // GASのdoPostでCORSプリフライトを回避するためtext/plain
      },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`HTTPエラー: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    return json;
  } catch (err) {
    console.error('GAS送信エラー:', err);
    throw err;
  }
}

// メッセージハンドリング
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. 接続テスト
  if (request.action === 'TEST_GAS_CONNECTION') {
    (async () => {
      try {
        let apiKey = request.apiKey;
        if (apiKey === undefined) {
          const config = await chrome.storage.sync.get(['apiKey']);
          apiKey = config.apiKey || '';
        }

        const result = await sendToGas(request.url, {
          action: 'ping',
          apiKey: apiKey.trim()
        });

        if (result && result.status === 'success') {
          sendResponse({
            success: true,
            message: result.message || '接続成功',
            authEnabled: !!result.authEnabled
          });
        } else {
          let errText = result?.message || '予期せぬレスポンスでした';
          if (result?.code === 'UNAUTHORIZED') {
            errText = '認証エラー: APIキーが無効または一致しません。スプレッドシートのAPIキーを確認してください。';
          }
          sendResponse({ success: false, error: errText });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // 非同期返答
  }

  // 2. 注文データの一括送信
  if (request.action === 'SUBMIT_ORDERS_TO_GAS') {
    (async () => {
      try {
        const config = await chrome.storage.sync.get(['gasUrl', 'sheetName', 'apiKey']);
        if (!config.gasUrl) {
          sendResponse({ success: false, error: 'GAS Web API URLが設定されていません。オプション画面から設定してください。' });
          return;
        }

        const payload = {
          orders: request.orders,
          sheetName: config.sheetName || 'Amazon注文履歴',
          apiKey: (config.apiKey || '').trim()
        };

        const result = await sendToGas(config.gasUrl, payload);
        if (result && result.status === 'success') {
          sendResponse({
            success: true,
            insertedCount: result.insertedCount,
            skippedCount: result.skippedCount,
            message: result.message
          });
        } else {
          let errText = result?.message || '書き込み処理でエラーが発生しました';
          if (result?.code === 'UNAUTHORIZED') {
            errText = '認証エラー: APIキーが無効または未入力です。設定画面（Options）でAPIキーを確認してください。';
          }
          sendResponse({ success: false, error: errText });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // 3. 進捗ステータスのキャッシュ
  if (request.action === 'SCRAPING_PROGRESS') {
    chrome.storage.local.set({ [LAST_STATUS_KEY]: request });
    return false;
  }

  // 4. Amazon注文履歴タブの準備と同期開始
  if (request.action === 'PREPARE_AND_START') {
    (async () => {
      const { targetYearMonth } = request;
      const [year] = targetYearMonth.split('-');
      const targetUrl = `https://www.amazon.co.jp/your-orders/orders?timeFilter=year-${year}`;

      // アクティブタブを検索
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      let orderTab = activeTab;
      const isAlreadyOnYearOrders = activeTab?.url && 
        activeTab.url.includes('amazon.co.jp') && 
        activeTab.url.includes('/your-orders/orders') && 
        activeTab.url.includes(`timeFilter=year-${year}`);

      if (!isAlreadyOnYearOrders) {
        if (activeTab && activeTab.url && activeTab.url.includes('amazon.co.jp')) {
          orderTab = await chrome.tabs.update(activeTab.id, { url: targetUrl });
        } else {
          orderTab = await chrome.tabs.create({ url: targetUrl });
        }

        await waitForTabComplete(orderTab.id);
        await new Promise((r) => setTimeout(r, 1500));
      }

      try {
        const response = await chrome.tabs.sendMessage(orderTab.id, {
          action: 'START_SYNC',
          targetYearMonth
        });
        sendResponse({ success: true, tabId: orderTab.id, ...response });
      } catch (err) {
        sendResponse({
          success: false,
          error: `Amazon注文履歴ページとの通信に失敗しました。ページをリロードして再度お試しください。（${err.message}）`
        });
      }
    })();
    return true;
  }
});

/**
 * タブが 'complete' になるまで待機
 */
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
