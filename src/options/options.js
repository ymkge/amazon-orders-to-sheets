/**
 * Options page logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const gasUrlInput = document.getElementById('gas-url');
  const apiKeyInput = document.getElementById('api-key');
  const toggleKeyBtn = document.getElementById('toggle-key-visibility');
  const sheetNameInput = document.getElementById('sheet-name');
  const saveBtn = document.getElementById('save-btn');
  const testBtn = document.getElementById('test-btn');
  const statusMsg = document.getElementById('status-message');

  // 設定値のロード
  chrome.storage.sync.get(['gasUrl', 'sheetName', 'apiKey'], (result) => {
    if (result.gasUrl) {
      gasUrlInput.value = result.gasUrl;
    }
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
    if (result.sheetName) {
      sheetNameInput.value = result.sheetName;
    }
  });

  // APIキーの表示/非表示切り替え
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = '🙈';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = '👁️';
    }
  });

  function showStatus(message, type = 'info') {
    statusMsg.textContent = message;
    statusMsg.className = `status-message ${type}`;
    statusMsg.classList.remove('hidden');
  }

  function hideStatus() {
    statusMsg.className = 'status-message hidden';
    statusMsg.textContent = '';
  }

  // 設定保存
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    hideStatus();

    const gasUrl = gasUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const sheetName = sheetNameInput.value.trim() || 'Amazon注文履歴';

    if (!gasUrl) {
      showStatus('GAS Web API URLを入力してください。', 'error');
      return;
    }

    if (!gasUrl.startsWith('https://script.google.com/')) {
      showStatus('有効なGoogle Apps Script URL (https://script.google.com/...) を入力してください。', 'error');
      return;
    }

    saveBtn.disabled = true;
    chrome.storage.sync.set({ gasUrl, apiKey, sheetName }, () => {
      saveBtn.disabled = false;
      showStatus('設定を保存しました！', 'success');
      setTimeout(hideStatus, 3500);
    });
  });

  // 接続テスト（入力中の最新値でテスト）
  testBtn.addEventListener('click', async () => {
    const gasUrl = gasUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!gasUrl) {
      showStatus('接続テストを行う前にGAS Web API URLを入力してください。', 'error');
      return;
    }

    testBtn.disabled = true;
    showStatus('Google Apps Script へ接続テスト中...', 'info');

    try {
      // background service worker を通して安全にリクエスト（入力中のURL・キーでテスト）
      const response = await chrome.runtime.sendMessage({
        action: 'TEST_GAS_CONNECTION',
        url: gasUrl,
        apiKey: apiKey
      });

      if (response && response.success) {
        let msg = `✅ 接続成功: ${response.message || '正常に応答がありました'}`;
        if (response.authEnabled) {
          msg += '（🔒 APIキー認証: 有効）';
        } else {
          msg += '（🔓 APIキー認証: 未設定）';
        }
        showStatus(msg, 'success');
      } else {
        showStatus(`❌ 接続失敗: ${response?.error || '応答がありませんでした。URLとデプロイ設定を確認してください。'}`, 'error');
      }
    } catch (err) {
      showStatus(`❌ エラー: ${err.message || '通信エラーが発生しました'}`, 'error');
    } finally {
      testBtn.disabled = false;
    }
  });
});
