# BEATs 咳検出の起動と連携

`npm start` で Kernel を起動し、コンソールの咳検出スイッチを ON にすると、Kernel が `../embodied-YAMNet` の咳専用モデルを Python 子プロセスとして自動起動します。確定した咳イベントは専用 HTTP API に送ります。追加のブリッジコマンドは不要です。

```text
マイク → BEATs / 咳専用ヘッド → stdout JSONL
                                  ↓ Kernel 内で管理するブリッジ
                 POST /api/perception/beats/cough
                                  ↓
              audio.cough_detected → 状態・イベントログ
                                  ↓（声かけの間隔制御）
                      Responses → Live / コンソール
```

## 起動

前提: 隣の `embodied-YAMNet` で既存の咳検出が実行できること。ブリッジは次のファイルを使います。

- `.venv/Scripts/python.exe`（Windows）
- `artifacts/beats-cough-public/head_calibrated.npz`
- `artifacts/beats-cough-public/config_calibrated.json`（`enabled_labels: ["cough"]`）
- `checkpoints/BEATs_iter3+_AS2M.pt`
- `vendor/unilm/beats/BEATs.py`

1. Kernel 用の PowerShell を開きます。

   ```powershell
   cd C:\GitHub\kokomi_kernel
   npm ci
   npm start
   ```

   `.env` の `OPENAI_API_KEY` は既存の Live / Responses と共通です。依存関係を導入済みなら `npm ci` は省略できます。

2. [コンソール](http://localhost:3000/dashboard/)の「現在の環境」の下にある **咳検出**を **ON** にします。Kernel が約1秒以内に BEATs の起動を開始します。初回のモデル読み込みには追加の時間がかかります。「プロセス稼働中」はモデル読み込み中も含みます。

3. 音声で気遣ってほしい場合は、コンソールの **会話開始** も押します。咳を検出すると、既存の Responses 経由で短い日本語の気遣いを作り、現在の Live 会話に渡します。Live 未接続時は、処理結果をコンソールの通信履歴に表示します。

**OFF** にすると Kernel は新しい咳通知を無視し、次の設定確認で検出プロセスを停止してマイクを解放します。待機中の声かけも無効になります。ON/OFF は `data/runtime/cough-settings.json` に保存され、Kernel の再起動後も復元します。ON を保存していた場合は再起動時に検出も自動で再開します。初回は OFF です。

終了時は Kernel の PowerShell で `Ctrl+C` を押してください。子の検出プロセスも停止します。モデルや Python が見つからない場合は咳検出欄にエラーを表示し、Kernel は継続します。OFF の間はモデルファイルを読み込みません。

以前の手順で別ターミナルのブリッジを動かしている場合は、そのブリッジを `Ctrl+C` で終了してから Kernel を再起動してください。

## マイク・CPU・パスの指定

利用可能なマイクを確認:

```powershell
cd C:\GitHub\embodied-YAMNet
.\.venv\Scripts\python.exe -m daily_sound_detector.cli list-input-devices
```

`config.json` の `coughDetection.detector` で指定してから Kernel を再起動します。

```json
{
  "directory": "../embodied-YAMNet",
  "python": null,
  "inferenceDevice": "cuda",
  "device": null,
  "head": "artifacts/beats-cough-public/head_calibrated.npz",
  "config": "artifacts/beats-cough-public/config_calibrated.json"
}
```

- `device`: マイク番号。`null` は既定の入力、例えば `1` でマイク番号1を選びます。
- `inferenceDevice`: `cuda`（既定）または `cpu`。
- `directory`: 検出リポジトリのパス。相対指定は Kernel リポジトリが基準です。
- `python`: Python 実行ファイル。`null` は検出リポジトリの `.venv` を使用します。明示した相対パスは Kernel リポジトリが基準です。
- `head`, `config`: 検出リポジトリからの相対パス、または絶対パス。

環境変数 `KOKOMI_CONFIG_PATH` による別設定ファイルも使えます。

別PCなどで検出を実行する場合のみ、`coughDetection.managedProcess` を `false` にして外部プロセス方式を選べます。その場合は従来の `node tools/beats-cough-bridge.js` と `--device`、`--inference-device`、`--detector-dir`、`--kernel-url` 等が使えます。既定の自動管理が ON のまま追加のブリッジを起動すると、二重起動を防ぐため案内を表示して終了します。

## API と内部処理

既存の `/audio_classification`、`/yolo_event`、`/touch_sensor_input` と分離した名前空間です。

| Method | Endpoint | 内容 |
| --- | --- | --- |
| POST | `/api/perception/beats/cough` | 検出器の schema 1.0 の咳イベントをそのまま受信 |
| GET | `/api/perception/beats/cough-detection` | ON/OFF、最終検出、起動中の受信件数、ブリッジ状態 |
| POST | `/api/perception/beats/cough-detection` | `{"enabled":true}` または `{"enabled":false}` |
| POST | `/api/perception/beats/heartbeat` | ブリッジのプロセス状態 `running` / `stopped` / `error` と任意の `error` 文字列 |

通知には `schema_version`, `event_id`, `label`, `confidence`, `started_at`, `ended_at`, `duration_ms`, `source`, `model`, `decision` が必要です。検出リポジトリの `schemas/event.schema.json` に対応し、`label == "cough"`、`source == "microphone"` を検証します。`model.architecture` は咳専用ヘッドの `beats_cough_transfer`、または互換の `beats_transfer` を受け付けます（検出 CLI の `--model` はどちらも `beats_transfer` です）。

- `event_id` を名前空間付きの観測 ID に変換して重複を排除します。イベントログに保存済みなら再起動後の再送も無視します。
- 終了から30秒を超えた通知、5秒を超える未来の通知は無視します。
- 受信した咳は独立した `audio.cough_detected` 観測として保存し、`state.perception.last_cough` に30秒間保持します。環境音・話し声の分類とは別の状態です。
- 最初の咳は認知処理に渡し、以降60秒間の咳は記録のみ行います。自発行動全体の `enabled` / `armed` 設定とは独立して動作します。
- 声かけには既存の認知キューを使います。OFF・有効期限切れ・Live セッション交代後に、古い声かけを出しません。
- 咳をした人物は未特定として扱います。短く気遣う用途に限定し、診断、健康情報の長期記憶への保存、物理・外部アクションは行いません。
- ブリッジは送信失敗を最大3回試行し、同じイベント ID を使います。検出プロセスが異常終了した場合はエラーをコンソールに表示して5秒後以降に再起動を試みます。

設定値は `config.json` の `coughDetection`（`reactionCooldownMs`, `maxEventAgeMs`, `storagePath`）と `behavior.freshness.cough_ms` です。声かけ間隔は Kernel の起動ごとに初期化されます。

## ログと確認

- 検出器の確定イベント: `data/runtime/beats/cough-events.jsonl`
- Kernel の観測: `data/runtime/observations.jsonl`
- コンソール: 咳検出の ON/OFF、ブリッジ状態、最終検出時刻、API 呼出履歴、Responses の結果
- 音声録音は行いません。ブリッジ終了時・OFF 時は確定前の咳を破棄する場合があります。

マイクと Live は別々に入力を取得するため、実機で同時利用を確認してください。実際の咳に加え、エージェントのスピーカー音声で誤検出しないことも確認します。

自動テスト:

```powershell
node --test test/cough-detection.test.js test/live-runtime.test.js
npm test
```

テストでは咳イベント、HTTP、検出プロセス、Responses、Live を模擬して統合を検証します。実マイクによる検出精度と実 API での発話は実機確認の対象です。
