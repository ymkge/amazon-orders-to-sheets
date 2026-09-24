/**
 * Amazon Orders to Google Sheets - GAS Backend
 * 
 * Webアプリケーションとしてデプロイして使用します。
 * デプロイ設定:
 * - 次のユーザーとして実行: 自分
 * - アクセスできるユーザー: 全員 (Anyone)
 */

const DEFAULT_SHEET_NAME = 'Amazon注文履歴';
const HEADERS = [
  '注文日',
  '注文番号',
  '商品名',
  '商品単価',
  '数量',
  '注文合計',
  '商品URL',
  '登録日時'
];

/**
 * スプレッドシート起動時のメニュー追加
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Amazon注文履歴連携')
    .addItem('🔑 APIキーの発行・確認', 'showApiKeyDialog')
    .addItem('🗑️ APIキーの削除（認証無効化）', 'removeApiKeyDialog')
    .addToUi();
}

/**
 * APIキーの発行・確認ダイアログ
 */
function showApiKeyDialog() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  let apiKey = props.getProperty('API_KEY');

  if (!apiKey) {
    // 安全な乱数UUIDを生成して設定
    apiKey = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_KEY', apiKey);
    ui.alert(
      '【新規APIキーを発行しました】',
      `APIキーが生成され、安全に保存されました：\n\n${apiKey}\n\nこのキーをChrome拡張機能の設定画面（Options）の「APIキー」欄に貼り付けて保存してください。`,
      ui.ButtonSet.OK
    );
  } else {
    ui.alert(
      '【現在のAPIキー】',
      `登録済みのAPIキー：\n\n${apiKey}\n\nこのキーをChrome拡張機能の設定画面（Options）の「APIキー」欄に入力してください。`,
      ui.ButtonSet.OK
    );
  }
}

/**
 * APIキーの削除ダイアログ（オプショナルに戻す）
 */
function removeApiKeyDialog() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert(
    'APIキーの削除確認',
    'APIキーを削除すると、APIキー認証が無効になり、URLを知っていれば誰でも連携できるようになります。削除しますか？',
    ui.ButtonSet.YES_NO
  );
  if (res === ui.Button.YES) {
    PropertiesService.getScriptProperties().deleteProperty('API_KEY');
    ui.alert('APIキーを削除しました。認証なしモードに戻りました。');
  }
}

/**
 * GETリクエストハンドラ（ブラウザ直接アクセス確認用）
 */
function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const hasApiKey = !!props.getProperty('API_KEY');

  const output = {
    status: 'success',
    message: 'Amazon Orders to Google Sheets Web API is active.',
    authEnabled: hasApiKey,
    timestamp: new Date().toISOString()
  };
  return ContentService.createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 定数時間比較によるタイミング攻撃対策
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a);
  const hashB = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b);
  if (hashA.length !== hashB.length) return false;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    diff |= (hashA[i] ^ hashB[i]);
  }
  return diff === 0;
}

/**
 * POSTリクエストハンドラ（Chrome拡張機能からのデータ受信）
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'リクエストボディが空です。'
      });
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return createJsonResponse({
        status: 'error',
        code: 'BAD_REQUEST',
        message: 'JSONの解析に失敗しました: ' + parseError.message
      });
    }

    // --- 1. APIキー認証（DoS対策のためLock取得前に実施） ---
    const props = PropertiesService.getScriptProperties();
    const expectedKey = props.getProperty('API_KEY');

    // GAS側にAPI_KEYが設定されている場合のみ照合を実行（未設定ならオプショナルとしてスキップ）
    if (expectedKey && expectedKey.trim() !== '') {
      const incomingKey = String(payload.apiKey || '').trim();
      if (!safeCompare(expectedKey.trim(), incomingKey)) {
        return createJsonResponse({
          status: 'error',
          code: 'UNAUTHORIZED',
          message: 'APIキーが無効または設定されていません。Chrome拡張機能の設定画面（Options）を確認してください。'
        });
      }
    }

    // --- 2. 疎通テスト用pingハンドリング（Lock取得不要） ---
    if (payload.action === 'ping') {
      return createJsonResponse({
        status: 'success',
        message: 'Google Apps Script との疎通に成功しました。',
        authEnabled: !!(expectedKey && expectedKey.trim() !== '')
      });
    }

    // --- 3. 注文データ登録処理（Lock取得） ---
    const items = payload.orders || payload.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return createJsonResponse({
        status: 'success',
        insertedCount: 0,
        skippedCount: 0,
        totalReceived: 0,
        message: '登録対象の注文データがありませんでした。'
      });
    }

    const lock = LockService.getScriptLock();
    // 同時実行時の整合性を保つため最大30秒ロックを取得
    const lockAcquired = lock.tryLock(30000);
    if (!lockAcquired) {
      return createJsonResponse({
        status: 'error',
        code: 'LOCK_TIMEOUT',
        message: '他のリクエストを処理中です。しばらく待ってから再試行してください。'
      });
    }

    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sheetName = payload.sheetName || DEFAULT_SHEET_NAME;
      let sheet = ss.getSheetByName(sheetName);

      // シートが存在しない場合は作成してヘッダーを付与
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        setupHeader(sheet);
      }

      // 既存データの読み込みと重複キー（注文番号 + 商品名）のセット作成
      const lastRow = sheet.getLastRow();
      const existingKeys = new Set();

      if (lastRow > 1) {
        // 注文番号は2列目(B列)、商品名は3列目(C列)
        const dataValues = sheet.getRange(2, 2, lastRow - 1, 2).getValues();
        for (let i = 0; i < dataValues.length; i++) {
          const orderId = String(dataValues[i][0]).trim();
          const productName = String(dataValues[i][1]).trim();
          if (orderId) {
            existingKeys.add(`${orderId}___${productName}`);
          }
        }
      } else if (lastRow === 0) {
        setupHeader(sheet);
      }

      const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      const newRows = [];
      let skippedCount = 0;

      for (const item of items) {
        const orderId = String(item.orderId || '').trim();
        const productName = String(item.title || item.productName || '').trim();
        const key = `${orderId}___${productName}`;

        if (existingKeys.has(key)) {
          skippedCount++;
          continue;
        }

        existingKeys.add(key); // 同一リクエスト内での重複も防止

        newRows.push([
          item.orderDate || '',
          orderId,
          productName,
          item.price !== undefined && item.price !== null ? item.price : '',
          item.quantity || 1,
          item.totalAmount !== undefined && item.totalAmount !== null ? item.totalAmount : '',
          item.productUrl || '',
          nowStr
        ]);
      }

      if (newRows.length > 0) {
        const currentLastRow = sheet.getLastRow();
        const targetRange = sheet.getRange(currentLastRow + 1, 1, newRows.length, HEADERS.length);
        targetRange.setValues(newRows);
      }

      return createJsonResponse({
        status: 'success',
        insertedCount: newRows.length,
        skippedCount: skippedCount,
        totalReceived: items.length,
        message: `${newRows.length} 件の注文データをスプレッドシートに追記しました（重複スキップ: ${skippedCount} 件）。`
      });

    } finally {
      lock.releaseLock();
    }

  } catch (err) {
    return createJsonResponse({
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'サーバー側でエラーが発生しました: ' + err.toString()
    });
  }
}

/**
 * シートのヘッダー行をセットアップしてスタイルを適用
 */
function setupHeader(sheet) {
  sheet.appendRow(HEADERS);
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setBackground('#0F9D58'); // スプレッドシートグリーン
  headerRange.setFontColor('#FFFFFF');
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  // カラム幅の自動調整
  sheet.setColumnWidth(1, 110); // 注文日
  sheet.setColumnWidth(2, 190); // 注文番号
  sheet.setColumnWidth(3, 320); // 商品名
  sheet.setColumnWidth(4, 90);  // 単価
  sheet.setColumnWidth(5, 60);  // 数量
  sheet.setColumnWidth(6, 100); // 注文合計
  sheet.setColumnWidth(7, 280); // 商品URL
  sheet.setColumnWidth(8, 160); // 登録日時
}

/**
 * JSONレスポンス生成ユーティリティ
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
