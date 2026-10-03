/**
 * Amazon Orders to Google Sheets - GAS Backend
 * 
 * Webアプリケーションとしてデプロイして使用します。
 * デプロイ設定:
 * - 次のユーザーとして実行: 自分
 * - アクセスできるユーザー: 全員 (Anyone)
 */

const DEFAULT_SHEET_NAME = 'Amazon注文履歴';

// デフォルトのヘッダー定義（注文番号を除外した7列構成）
const DEFAULT_HEADERS = [
  '注文日',
  '商品名',
  '商品単価',
  '数量',
  '注文合計',
  '商品URL',
  '登録日時'
];

// 各カラム名に対応する値の抽出ロジック（動的マッピング定義）
const COLUMN_RESOLVERS = {
  '注文日': (item) => item.orderDate || '',
  '注文番号': (item) => item.orderId || '',
  '商品名': (item) => item.title || item.productName || '',
  '商品単価': (item) => (item.price !== undefined && item.price !== null ? item.price : ''),
  '数量': (item) => item.quantity || 1,
  '注文合計': (item) => (item.totalAmount !== undefined && item.totalAmount !== null ? item.totalAmount : ''),
  '商品URL': (item) => item.productUrl || '',
  '登録日時': (item, nowStr) => nowStr
};

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
 * APIキーの削除ダイアログ
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
 * シートの1行目を解析し、カラム名と列インデックスのマッピングを返す
 */
function parseHeaderMapping(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return null;
  const rawHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headers = [];
  const map = {};

  for (let i = 0; i < rawHeaders.length; i++) {
    const name = String(rawHeaders[i] || '').trim();
    if (name) {
      headers.push(name);
      map[name] = i;
    }
  }

  if (headers.length === 0) return null;
  return { headers, map };
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

    // --- 2. 疎通テスト用pingハンドリング ---
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

      // シートが存在しない場合は作成
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        setupHeader(sheet);
      }

      // ヘッダー行の解析（動的カラムマッピング）
      let headerInfo = parseHeaderMapping(sheet);
      if (!headerInfo || sheet.getLastRow() === 0) {
        setupHeader(sheet);
        headerInfo = parseHeaderMapping(sheet);
      }

      const hasOrderIdColumn = headerInfo.map['注文番号'] !== undefined;
      const lastRow = sheet.getLastRow();

      // 既存データの重複判定コレクションを構築
      const existingKeySet = new Set();
      const existingMultisetCounts = new Map();

      if (lastRow > 1) {
        const dataValues = sheet.getRange(2, 1, lastRow - 1, headerInfo.headers.length).getValues();

        for (let i = 0; i < dataValues.length; i++) {
          const row = dataValues[i];

          if (hasOrderIdColumn) {
            // 既存8列シート（注文番号あり）: 注文番号 + 商品名で判定（後方互換性）
            const orderIdCol = headerInfo.map['注文番号'];
            const nameCol = headerInfo.map['商品名'];
            const orderId = orderIdCol !== undefined ? String(row[orderIdCol] || '').trim() : '';
            const productName = nameCol !== undefined ? String(row[nameCol] || '').trim() : '';
            if (orderId) {
              existingKeySet.add(`${orderId}___${productName}`);
            }
          } else {
            // 新7列シート（注文番号なし）: Multiset（出現頻度カウント）で判定
            const dateCol = headerInfo.map['注文日'];
            const nameCol = headerInfo.map['商品名'];
            const urlCol = headerInfo.map['商品URL'];
            const priceCol = headerInfo.map['商品単価'];
            const qtyCol = headerInfo.map['数量'];

            const orderDate = dateCol !== undefined ? String(row[dateCol] || '').trim() : '';
            const itemIdentifier = (urlCol !== undefined && row[urlCol]) ? String(row[urlCol]).trim() : (nameCol !== undefined ? String(row[nameCol] || '').trim() : '');
            const price = priceCol !== undefined ? String(row[priceCol] || '').trim() : '';
            const qty = qtyCol !== undefined ? String(row[qtyCol] || '1').trim() : '1';

            const sig = `${orderDate}___${itemIdentifier}___${price}___${qty}`;
            existingMultisetCounts.set(sig, (existingMultisetCounts.get(sig) || 0) + 1);
          }
        }
      }

      const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      const newRows = [];
      let skippedCount = 0;

      for (const item of items) {
        if (hasOrderIdColumn) {
          // 注文番号列が存在する場合
          const orderId = String(item.orderId || '').trim();
          const productName = String(item.title || item.productName || '').trim();
          const key = `${orderId}___${productName}`;

          if (existingKeySet.has(key)) {
            skippedCount++;
            continue;
          }
          existingKeySet.add(key); // 同一バッチ内重複防止
        } else {
          // 注文番号列が存在しない場合（Multiset消費）
          const itemIdentifier = String(item.productUrl || item.title || item.productName || '').trim();
          const price = item.price !== undefined && item.price !== null ? String(item.price) : '';
          const qty = String(item.quantity || 1);
          const sig = `${item.orderDate || ''}___${itemIdentifier}___${price}___${qty}`;

          const count = existingMultisetCounts.get(sig) || 0;
          if (count > 0) {
            existingMultisetCounts.set(sig, count - 1);
            skippedCount++;
            continue;
          }
        }

        // ヘッダー名に基づいて動的に行データを生成（列ズレを完全防止）
        const rowData = new Array(headerInfo.headers.length).fill('');
        for (let c = 0; c < headerInfo.headers.length; c++) {
          const colName = headerInfo.headers[c];
          if (COLUMN_RESOLVERS[colName]) {
            rowData[c] = COLUMN_RESOLVERS[colName](item, nowStr);
          }
        }
        newRows.push(rowData);
      }

      if (newRows.length > 0) {
        const currentLastRow = sheet.getLastRow();
        const targetRange = sheet.getRange(currentLastRow + 1, 1, newRows.length, headerInfo.headers.length);
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
 * シートのヘッダー行をセットアップしてスタイルを適用（7列構成）
 */
function setupHeader(sheet) {
  sheet.appendRow(DEFAULT_HEADERS);
  const headerRange = sheet.getRange(1, 1, 1, DEFAULT_HEADERS.length);
  headerRange.setBackground('#0F9D58'); // スプレッドシートグリーン
  headerRange.setFontColor('#FFFFFF');
  headerRange.setFontWeight('bold');
  headerRange.setHorizontalAlignment('center');
  sheet.setFrozenRows(1);

  // カラム幅の自動調整（7列構成に最適化）
  sheet.setColumnWidth(1, 110); // 注文日
  sheet.setColumnWidth(2, 320); // 商品名
  sheet.setColumnWidth(3, 90);  // 単価
  sheet.setColumnWidth(4, 60);  // 数量
  sheet.setColumnWidth(5, 100); // 注文合計
  sheet.setColumnWidth(6, 280); // 商品URL
  sheet.setColumnWidth(7, 160); // 登録日時
}

/**
 * JSONレスポンス生成ユーティリティ
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
