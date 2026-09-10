# kokomi_kernel

物理ボディを持つAI「Kokomi」のための、実験的なEmbodied AIカーネルです。

センサーや人物追跡などのイベントをChatGPTへ渡し、返されたJSONを監査してから、Raspberry Pi上のアクチュエーター、音声合成、外部サービスへ振り分けます。LLMがハードウェアを直接操作せず、**Kernelが実行可否を判断する最終的な境界**になることを設計の中心に置いています。

> [!WARNING]
> このリポジトリは開発中の実験用ソフトウェアです。モーターなどの実機を接続する場合は、非常停止、電流・温度制限、可動範囲の確保などをハードウェア側でも実装し、監視下で使用してください。

## 現在できること

- ChatGPTの応答から完全なJSONオブジェクトを抽出し、許可された形式だけを実行
- 発話、感情、強度を受け取り、任意でElevenLabs TTSへ送信
- BME280（温度・湿度・気圧）とCdS（明るさ）の定期取得
- Raspberry Piへ涙モーターとLEDのコマンドを送信
- カメラ画像をChatGPTへ添付してシーン理解を依頼
- DeepSORT由来の人物出現・認識・消失イベントを中継
- 明示的な依頼に基づく人物名と顔の登録
- タッチセンサー入力を「撫で始め／撫で終わり」の意味イベントへ変換
- 明示的に許可された文章をBlueskyへ投稿
- HTTP API経由でユーザー入力を会話へ追加
- 生の観測を時刻・信頼度・由来付きの共通エンベロープへ正規化
- 観測から継続状態を保持し、鮮度切れを`stale`、未観測を`unknown`として区別
- 在室、温熱、照明、発話、接触を決定論的な世界モデルへ変換
- 優先度・有効期限・クールダウン付きの自発行動候補を生成
- LLMの記憶候補を承認待ちとして永続化し、承認済みだけを会話へ検索注入
- 完全な内部状態から会話に必要な値だけを`CognitiveProjection`として圧縮
- `turn_id`でLLM応答を元の認知状態へ結び付け、古い／無関係な応答を拒否
- 行動意図、期待結果、成功・失敗・拒否をObservationとして閉ループ化
- 関係、境界、約束を承認制Social Stateとして保持し、境界を実行時に強制
- 推論された機能的欲求と外部の身体信号を分離して行動候補へ統合
- Observationイベントログを再生して再起動後に状態を復元

## アーキテクチャ

```text
センサー / カメラ / DeepSORT / タッチ / ユーザー入力
                         |
                         v
                     Observation
                         |
                         v
                 Persistent State
                         |
                         v
       Deterministic World Model
             |
             +----> Behavior Proposals
             |
             v
       Cognitive Context JSON ----> ChatGPT（認知・会話）
                                      |
                                      v
                         turn相関 / JSON監査 / Action Gate
                                      |
                                      v
                                 実行先サービス
                                      |
                                      v
                           Outcome Observation（次の認知へ）
```

ChatGPTとの通信には公式APIではなく、リモートデバッグを有効にしたChromeへPuppeteerで接続する方式を使用しています。ChatGPTの画面構造が変わった場合は、`config.json` のセレクター調整が必要になることがあります。

## 必要なもの

最低限、次の環境を用意してください。

- Node.js 18以降
- npm
- Google ChromeまたはChromium
- ログイン済みのChatGPTアカウント
- ElevenLabs APIキー

機能に応じて、次の外部要素も必要です。

- `ffplay`（TTSを有効にする場合。FFmpegに同梱）
- KokomiのRaspberry Piハードウェアサーバー
- BME280およびCdSセンサーのHTTPエンドポイント
- スナップショット／顔登録API
- DeepSORTイベント送信側
- BlueskyアカウントとApp Password（投稿機能を使う場合）

## セットアップ

### 1. 依存パッケージをインストール

```bash
npm install
```

### 2. 環境変数を設定

リポジトリ直下に `.env` を作成します。

```dotenv
ELEVENLABS_API_KEY=your_api_key

# 以下は任意。未指定時は config.json の既定値を使用します。
ELEVENLABS_VOICE_ID=your_voice_id
ELEVENLABS_MODEL_ID=eleven_v3
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128

# Bluesky投稿を使う場合のみ必要です。通常のパスワードではなく
# App Passwordの利用を推奨します。
BSKY_IDENTIFIER=your-handle.bsky.social
BSKY_PASSWORD=your_app_password
```

`.env` はGitの追跡対象外です。認証情報をコミットしないでください。

`ELEVENLABS_API_KEY`は`tts.enabled`を`true`にする場合だけ必須です。

### 3. 接続先を設定

`config.json` で環境に合わせて次の項目を変更します。

| セクション | 主な設定 |
| --- | --- |
| `browser` | ChromeのデバッグURL、ChatGPT URL、画面要素のセレクター |
| `actions` | 涙モーター、LED、Blueskyの接続先と制約 |
| `sensors` | BME280／CdSのURL、取得間隔、単位 |
| `touch` | センサーIDと身体部位の対応 |
| `tts` | 有効・無効、ElevenLabs、`ffplay` の設定 |
| `vision` | カメラスナップショットURL、画像制限、タイムアウト |
| `faceMemory` | 顔登録APIと名前の制約 |
| `routes` / `server` | 受信用HTTP APIのパスとポート |

リポジトリ同梱の `config.json` にはローカルネットワーク用の接続先が入っています。そのままでは別環境から利用できません。

`remember_person`は顔登録APIから`202 collecting`を受け取ると正常な収集開始として扱います。この時点では登録完了ではありません。バックグラウンド収集が成功すると、ビジョンモジュールから`person_enrolled`イベントが届きます。

### 4. ChatGPTを準備

1. Chromeをリモートデバッグ付きで起動します。
2. そのChromeでChatGPTへログインし、新しい会話を開きます。
3. `kokomi-persona`の人格原典を設定します。
4. [`control_prompt.md`](control_prompt.md) の内容を制御指示として送信します。
5. 会話タブを開いたままにします。

プロトコル1.2では応答の`turn_id`が必須です。以前の制御プロンプトを設定した
既存スレッドを使う場合も、更新後の`control_prompt.md`をもう一度送ってください。

人格はセッション開始時に読み込み、Kernelから送る各`cognitive_context`には
`config.json`で指定したpersona IDとversionを含めます。会話の直近文脈は
ChatGPTに残し、身体・世界状態と承認済み長期記憶はKernelを正本とします。

Windowsでの起動例:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\chrome-debug-profile"
```

Chromeの実行ファイルが別の場所にある場合はパスを読み替えてください。普段使用しているChromeとは別の `--user-data-dir` を指定すると、プロファイルの競合を避けられます。

### 5. Kernelを起動

```bash
node alice.js
```

起動に成功すると、標準出力に概ね次のメッセージが表示されます。

```text
YOLO event server listening on :3000
ChatGPT input detected
ChatGPT output monitor started after turn: ...
```

## 運用WebUI

Kernelの起動後、ブラウザで次を開きます。

```text
http://localhost:3000/dashboard/
```

運用WebUIでは以下を一元的に確認・操作できます。

- Kernel、ChatGPTブラウザ連携、各センサー、ビジョン、顔記憶、TTSの接続状態
- 気温、湿度、気圧、明るさの最新値
- 受信APIの呼び出し回数、エラー数、直近のHTTPステータスとレイテンシ
- ChatGPTとの送受信、監査結果、デバイス操作を含むリアルタイムイベントログ
- 世界モデル、機能的欲求、社会状態、行動結果、復元イベント数を表示する認知状態ビュー
- ChatGPTへのユーザー入力、LEDカラー、涙機構の手動操作

ログは通常、人が読みやすい要約で表示されます。完全なJSONは各ログ行の「JSONペイロードを表示」、または画面右上の「JSONを表示」から必要なときだけ展開できます。状態更新にはServer-Sent Eventsを使用し、接続が一時的に切れた場合も定期取得で補完します。

> WebUIとAPIには認証がありません。既存APIと同様、信頼できるLAN内だけで公開してください。LEDと涙機構の操作は即時に実機へ送信されます。

## 使い方

ユーザー入力をHTTP APIから送る例です。

```bash
curl -X POST http://localhost:3000/user_input \
  -H "Content-Type: application/json" \
  -d '{"text":"今日の部屋の様子を教えて"}'
```

Kernelは次の流れで処理します。

1. 入力を共通Observationへ変換
2. 継続状態と世界モデルを更新
3. 内部メタデータを除いた`CognitiveProjection`へ変換
4. 関連記憶と行動候補を加えた`cognitive_context`をChatGPTへ送信
5. ChatGPTの新しい応答を監視
6. 応答中のJSONを抽出してスキーマを監査
7. 許可された発話、アクション、情報要求だけを実行

## HTTP API

既定の待受ポートは `3000` です。

### `POST /user_input`

テキスト入力をChatGPTへ渡します。

```json
{
  "text": "気分はどう？"
}
```

### `POST /touch_sensor_input`

タッチセンサーイベントを受け取ります。`sensor_id` と身体部位の対応は `config.json` で設定します。

```json
{
  "event": {
    "source": "touch",
    "type": "touch_started",
    "sensor_id": "touch_01",
    "timestamp": "2026-09-05T12:34:56+09:00"
  }
}
```

`type` は `touch_started` または `touch_ended` です。

### `POST /yolo_event`

DeepSORTの人物追跡・顔認識イベントを受け取ります。

```json
{
  "event": {
    "event_id": "84972a7f330844b982d931f06be840ab",
    "source": "deepsort",
    "type": "person_recognized",
    "track_id": "7",
    "timestamp": "2026-09-05T12:34:56+00:00",
    "identity": {
      "status": "recognized",
      "person_id": "26b7e2c15a1e4449974367f7da686b74",
      "name": "KOT",
      "distance": 0.2563,
      "threshold": 0.3
    },
    "message": "The visible registered person is KOT."
  }
}
```

人物を検出しただけではイベントは送られません。受理するイベントは`person_recognized`、`person_unknown`、`person_enrolled`、`person_disappeared`です。`person_disappeared`は認識結果または登録完了を通知済みの人物についてのみ送られます。詳しいJSON形式は [`command_list.md`](command_list.md) を参照してください。同じ `event_id` は重複イベントとして無視されます。

### `GET /api/dashboard/status`

運用WebUI向けに、Kernel稼働時間、サービス状態、センサー値、API統計、直近のイベントを返します。秘密情報や環境変数は含みません。

### `GET /api/dashboard/events`

サービス状態と通信イベントをServer-Sent Eventsで配信します。

### `POST /api/dashboard/actions`

運用WebUIから`led_change`または`tear`だけを実行します。既存のLLM出力監査と同じパラメーター検証を通過した操作だけが実機へ送信されます。

### Behavior / Memory API

- `GET /api/behavior/state`: 現在の状態、世界モデル、自発行動候補を取得
- `POST /api/behavior/tick`: 優先度を満たす自発行動候補をChatGPTへ送信
- `POST /audio_classification`: `label`、`level`、`confidence`を持つ音声分類を状態へ追加
- `POST /internal_state`: 0〜1に正規化した身体信号を`signals`オブジェクトとして追加
- `GET /api/memory/proposals?status=pending`: LLMが提案した記憶候補を取得
- `POST /api/memory/proposals/:id/decision`: `accepted`または`rejected`で候補を審査
- `GET /api/social/proposals?status=pending`: 関係・境界・約束の候補を取得
- `POST /api/social/proposals/:id/decision`: Social State候補を審査

音声分類の例:

```json
{
  "event_id": "yamnet_123",
  "source": "yamnet",
  "label": "speech",
  "level": "medium",
  "confidence": 0.91,
  "timestamp": "2026-09-10T12:00:00.000Z"
}
```

身体信号の例:

```json
{
  "source": "body_controller",
  "signals": {
    "energy_deficit": 0.72,
    "thermal_discomfort": 0.18
  }
}
```

自発行動の自動ティックは既定で無効です。実機なしの検証後、`config.json`の
`behavior.spontaneous.enabled`と`behavior.spontaneous.armed`を両方`true`にすると有効化できます。詳しい設計は
[`docs/behavior-architecture.md`](docs/behavior-architecture.md)を参照してください。

## LLM出力プロトコル

ChatGPTは入力と同じ`turn_id`を含む単一のJSONオブジェクトだけを返します。

- `speech`: 日本語の発話文
- `emotion`: `neutral`、`happy`、`calm`、`sad`、`angry`、`surprised`、`fear`、`thinking`
- `intensity`: `0.0` から `1.0`
- `actions`: 実行するアクションの配列
- `requests`: 取得したい情報の配列
- `memory_proposals`: 将来のセッションにも残す価値がある記憶の候補
- `social_proposals`: 関係、境界、約束の承認待ち候補

例:

```json
{
  "turn_id": "obs_123",
  "speech": "少し暗くなってきたね。明かりをつけるよ。",
  "emotion": "calm",
  "intensity": 0.4,
  "actions": [
    {
      "type": "led_change",
      "params": {
        "color": "#FFF2CC"
      }
    }
  ]
}
```

許可されているアクションは `tear`、`led_change`、`bluesky_post`、`remember_person` です。要求できる情報は `temperature`、`humidity`、`pressure`、`brightness`、および `vision/describe_scene` です。不明なフィールド、範囲外の値、不完全なパラメーターを含むJSONは拒否されます。

完全なルールは [`control_prompt.md`](control_prompt.md)、通信例は [`command_list.md`](command_list.md) にあります。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `alice.js` | Kernel本体。ブラウザ接続、監査、イベント処理、アクション実行 |
| `config.json` | 接続先、制約、センサー、ルートなどの実行時設定 |
| `control_prompt.md` | ChatGPTへ渡す現在の制御プロンプト |
| `command_list.md` | 入出力JSONプロトコルの例と仕様 |
| `src/behavior/` | Observation、状態保持、世界モデル、行動候補、文脈合成 |
| `src/memory/` | 承認制の長期記憶ストアと検索 |
| `src/social/` | 承認制の関係、境界、約束の状態ストア |
| `docs/behavior-architecture.md` | 所有権境界と新しい行動アーキテクチャの仕様 |
| `# Embodied AI Robot Project Roadmap.md` | 設計思想、レイヤー構成、今後の方向性 |
| `elevenlabs_tts.js` ほか | TTS／STTの試作・検証用スクリプト |
| `archives/` | 過去のブラウザ連携方式などの参考実装 |

`alice.js` 内のLLaVA経路はフォールバック資料として残されていますが、現在の画像認識フローでは使用されません。現在はスナップショットをChatGPTへ直接添付します。

## セキュリティと運用上の注意

- 受信用HTTP APIには認証がありません。信頼できるLAN内に限定し、必要に応じてOSのファイアウォールやリバースプロキシでアクセス元を制限してください。
- `bluesky_post` は公開操作です。`control_prompt.md` では明示的な投稿許可がある場合だけ使うよう制約しています。
- 顔情報の登録は、本人が名前を名乗るか、記憶を明示的に依頼した場合だけ行う設計です。運用地域のプライバシー法令と同意要件を確認してください。
- LLM出力の監査はソフトウェア上の防御層です。実機側にも速度、温度、電流、連続動作時間などの制限を実装してください。
- `config.json` のネットワーク接続先とChatGPT DOMセレクターは環境依存です。

## 開発状況

現在はリアクティブ層と会話・認知層の間に、継続状態、決定論的世界モデル、
行動候補、承認制長期記憶、Social State、機能的欲求、永続イベントログ、
行動結果の帰還を導入した段階です。自発行動は実機試験まで既定でarmされません。背景とロードマップは
[`# Embodied AI Robot Project Roadmap.md`](%23%20Embodied%20AI%20Robot%20Project%20Roadmap.md) を参照してください。

## License

[MIT License](LICENSE)
