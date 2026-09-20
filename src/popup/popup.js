/**
 * Amazon Orders to Sheets - Popup Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const monthSelect = document.getElementById('month-select');
  const syncBtn = document.getElementById('sync-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const openOptionsLink = document.getElementById('open-options-link');
  const configWarning = document.getElementById('config-warning');

  const progressSection = document.getElementById('progress-section');
  const progressTitle = document.getElementById('progress-title');
  const progressCounter = document.getElementById('progress-counter');
  const progressBar = document.getElementById('progress-bar');
  const progressStatusText = document.getElementById('progress-status-text');
  const resultMessage = document.getElementById('result-message');

  let isSyncing = false;

  // 年月セレクターの生成（直近24ヶ月分）
  function populateMonthOptions() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-12

    monthSelect.innerHTML = '';

    for (let i = 0; i < 24; i++) {
      let targetYear = currentYear;
      let targetMonth = currentMonth - i;

      while (targetMonth <= 0) {
        targetMonth += 12;
        targetYear -= 1;
      }

      const val = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
      const label = `${targetYear}年 ${targetMonth}月`;

      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      monthSelect.appendChild(opt);
    }
  }

  // 設定状況のチェック
  async function checkConfiguration() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['gasUrl'], (res) => {
        const hasUrl = !!(res.gasUrl && res.gasUrl.trim());
        if (!hasUrl) {
          configWarning.classList.remove('hidden');
          syncBtn.disabled = true;
        } else {
          configWarning.classList.add('hidden');
          if (!isSyncing) syncBtn.disabled = false;
        }
        resolve(hasUrl);
      });
    });
  }

  function showResult(message, type = 'info') {
    resultMessage.textContent = message;
    resultMessage.className = `result-message ${type}`;
    resultMessage.classList.remove('hidden');
  }

  function hideResult() {
    resultMessage.className = 'result-message hidden';
    resultMessage.textContent = '';
  }

  function setSyncingUI(running) {
    isSyncing = running;
    if (running) {
      syncBtn.classList.add('hidden');
      cancelBtn.classList.remove('hidden');
      monthSelect.disabled = true;
      progressSection.classList.remove('hidden');
      hideResult();
    } else {
      syncBtn.classList.remove('hidden');
      cancelBtn.classList.add('hidden');
      monthSelect.disabled = false;
      checkConfiguration();
    }
  }

  // 進捗更新ハンドラ
  function handleProgressUpdate(data) {
    if (!data) return;

    if (data.status === 'parsing' || data.status === 'page_finished' || data.status === 'waiting' || data.status === 'syncing') {
      setSyncingUI(true);
      progressTitle.textContent = data.page ? `ページ ${data.page} を処理中` : '取得中...';
      progressCounter.textContent = `${data.itemCount || 0} 件 抽出`;
      progressStatusText.textContent = data.message || '';

      // プログレスバーのアニメーション
      if (data.status === 'syncing') {
        progressBar.style.width = '90%';
      } else {
        const page = data.page || 1;
        const width = Math.min(80, 20 + page * 15);
        progressBar.style.width = `${width}%`;
      }
    } else if (data.status === 'completed') {
      setSyncingUI(false);
      progressSection.classList.add('hidden');
      showResult(`🎉 ${data.message}`, 'success');
    } else if (data.status === 'error') {
      setSyncingUI(false);
      progressSection.classList.add('hidden');
      showResult(`❌ ${data.message || data.error}`, 'error');
    } else if (data.status === 'cancelled') {
      setSyncingUI(false);
      progressSection.classList.add('hidden');
      showResult('⚠️ 処理が中断されました。', 'info');
    }
  }

  // 現在の実行状況を確認してUIを復元
  async function restoreActiveState() {
    chrome.storage.local.get(['amazon_orders_sync_session', 'amazon_orders_last_progress'], (res) => {
      const session = res.amazon_orders_sync_session;
      const lastProgress = res.amazon_orders_last_progress;

      if (session && session.isRunning) {
        if (session.targetYearMonth) {
          monthSelect.value = session.targetYearMonth;
        }
        setSyncingUI(true);
        if (lastProgress) {
          handleProgressUpdate(lastProgress);
        }
      }
    });
  }

  // イベントリスナー
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  openOptionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // 連携開始ボタン
  syncBtn.addEventListener('click', async () => {
    const targetYearMonth = monthSelect.value;
    if (!targetYearMonth) return;

    hideResult();
    setSyncingUI(true);
    progressTitle.textContent = 'Amazon注文履歴へ接続中...';
    progressCounter.textContent = '0 件';
    progressStatusText.textContent = '対象年の注文履歴ページを開いています...';
    progressBar.style.width = '15%';

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'PREPARE_AND_START',
        targetYearMonth
      });

      if (!response || !response.success) {
        setSyncingUI(false);
        progressSection.classList.add('hidden');
        showResult(`エラー: ${response?.error || '開始できませんでした'}`, 'error');
      }
    } catch (err) {
      setSyncingUI(false);
      progressSection.classList.add('hidden');
      showResult(`起動エラー: ${err.message}`, 'error');
    }
  });

  // 中止ボタン
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    try {
      // Content Scriptおよびストレージへキャンセル指示
      chrome.storage.local.remove(['amazon_orders_sync_session']);
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        chrome.tabs.sendMessage(activeTab.id, { action: 'CANCEL_SYNC' }).catch(() => {});
      }
    } finally {
      cancelBtn.disabled = false;
      setSyncingUI(false);
      progressSection.classList.add('hidden');
      showResult('処理を中断しました。', 'info');
    }
  });

  // バックグラウンドからの進捗メッセージを受信
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'SCRAPING_PROGRESS') {
      handleProgressUpdate(request);
    }
  });

  // 初期化実行
  populateMonthOptions();
  await checkConfiguration();
  await restoreActiveState();
});
