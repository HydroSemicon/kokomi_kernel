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

## アーキテクチャ

```text
センサー / カメラ / DeepSORT / ユーザー入力
                       |
                       v
                alice.js (Kernel)
                - イベントの正規化
                - JSONの監査
                - 実行順序の制御
                       |
             +---------+---------+
             |                   |
             v                   v
     ChatGPT（認知・会話）    実行先サービス
                             - Raspberry Pi
                             - ElevenLabs
                             - 顔登録API
                             - Bluesky
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

> [!NOTE]
> 現在の実装では `config.json` の `tts.enabled` が `false` でも、`ELEVENLABS_API_KEY` が未設定だと起動を停止します。

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

### 4. ChatGPTを準備

1. Chromeをリモートデバッグ付きで起動します。
2. そのChromeでChatGPTへログインし、新しい会話を開きます。
3. [`control_prompt.md`](control_prompt.md) の内容を最初の指示として送信します。
4. 会話タブを開いたままにします。

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

## 使い方

ユーザー入力をHTTP APIから送る例です。

```bash
curl -X POST http://localhost:3000/user_input \
  -H "Content-Type: application/json" \
  -d '{"text":"今日の部屋の様子を教えて"}'
```

Kernelは次の流れで処理します。

1. 入力を `{"user_input":"..."}` としてChatGPTへ送信
2. ChatGPTの新しい応答を監視
3. 応答中のJSONを抽出してスキーマを監査
4. 許可された発話、アクション、情報要求だけを実行

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
    "type": "person_appeared",
    "track_id": "7",
    "timestamp": "2026-09-05T12:34:56+00:00",
    "position": "center",
    "identity": {
      "status": "pending",
      "person_id": null,
      "name": null,
      "distance": null,
      "threshold": 0.55
    },
    "message": "A person has appeared. Identity recognition is in progress."
  }
}
```

詳しいイベント種別とJSON形式は [`command_list.md`](command_list.md) を参照してください。同じ `event_id` は重複イベントとして無視されます。

## LLM出力プロトコル

ChatGPTは単一のJSONオブジェクトだけを返します。許可されるトップレベルのフィールドは次の5つです。

- `speech`: 日本語の発話文
- `emotion`: `neutral`、`happy`、`calm`、`sad`、`angry`、`surprised`、`fear`、`thinking`
- `intensity`: `0.0` から `1.0`
- `actions`: 実行するアクションの配列
- `requests`: 取得したい情報の配列

例:

```json
{
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

現在は主にリアクティブ層と会話・認知層を接続する段階です。状態管理、イベント優先度、長期記憶、安全制御、より自律的な行動は今後の拡張対象です。背景とロードマップは [`# Embodied AI Robot Project Roadmap.md`](%23%20Embodied%20AI%20Robot%20Project%20Roadmap.md) を参照してください。

## License

[MIT License](LICENSE)
