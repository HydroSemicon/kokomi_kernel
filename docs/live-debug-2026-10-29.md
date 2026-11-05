# Live 音声・記憶抽出の調査と変更（2026-10-29）

## 音声の一部が聞こえない問題

「のんびり」の一部が欠けた時点の音声と通信統計がなく、原因は未確定。
文字起こしは実際に再生された音声の証明ではないため、症状だけで RTC のパケット欠落とは断定できない。
候補はネットワークの損失・遅着、モデル生成や割り込み、ブラウザ・OS の再生側。

初期の身体状態に基づく話し方を startup instructions に含め、開始後に同じ指示を送る処理をなくした。
[公式仕様](https://developers.openai.com/api/docs/guides/live-conversations)に会話中の指示追加が発話を中断し得るとあるための対策で、
今回の欠落原因だったことを確認できたわけではない。会話中の状態変化に応じた更新は維持する。

次回は管理画面の開発者コンソールで `kokomi.liveDiagnostics()` を確認する。
直近180サンプルを1秒間隔で保持し、終了後も次の接続を始めるまでは参照できる。
`copy(JSON.stringify(kokomi.liveDiagnostics()))` で調査用にコピーできる。

- `lostDelta` / `discardedDelta`: 受信パケットの損失・破棄の増分。
- `concealedDelta` / `concealmentEventsDelta`: 受信音声の補間と補間イベントの増分。
- `jitterMs` / `bufferMs`: 到着間隔の揺れと、区間中の平均ジッタバッファ遅延。
- `playback`: ブラウザの再生・ミュート状態。

[W3C 統計仕様](https://www.w3.org/TR/webrtc-stats/)では、補間は損失や再生に間に合わなかった音声に対して発生する。
欠落時刻にこれらが増えれば伝送側を疑える。統計だけで特定の音節の消失を証明することはできない。
遅着が多ければバッファを増やす案があるが、[遅延と回復のトレードオフ](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)があり、
今回は値を変えていない。音声ファイルの録音も追加していない。

## 無音による切断し忘れ警告

マイクと受信音声の音量を見て、双方が60秒無音なら管理画面の通知と二連ビープを出す。
文字起こしの受信も活動として扱う。無音が続く間は60秒ごとに再警告し、音が戻ればカウンターをリセットする。
警告による自動切断はしない。設定は `live.silenceWarningSeconds`、`live.silenceWarningRepeatSeconds`、
`live.silenceAudioLevel`、`live.audioStatsIntervalMs`。
ブラウザが警告音を許可しない場合は、音声再生許可ボタンを案内する。

## 長期記憶の確認

管理画面の「長期記憶」で採用済みと採用待ちを切り替えられる。内容は文字列として表示する。
ブラウザコンソールは `await kokomi.memory()`、候補も含めるなら `await kokomi.memory({status: "all"})`。

ターミナル:

```powershell
npm run memory:list
npm run memory:list -- --status pending
npm run memory:list -- --status all --json
```

これらは読み取り専用。調査時点では採用済み0件、採用待ち1件だった。
未処理の会話ログは残っており、応答監視の修正後に通常の抽出・採否処理へ戻る。

## エラーの変化と修正

前回の送信ボタン修正後、入力・送信は完了している。
今回の `Browser backend response timed out` は、120秒の応答待ち後に失敗し、30秒後の再試行を繰り返していた。
実画面には完了した記憶抽出 JSON があるが、旧 `.markdown.prose` と `data-message-author-role` がなく、応答を検出できていなかった。

新しい `data-chatgpt-search-unit-key` と `data-chatgpt-search-message-ids` に対応した。
読み取り専用の実画面検証で応答を検出し、直近の JSON が Live 記憶抽出の形式監査に通ることを確認した。
タイムアウト値を引き延ばす修正はしていない。現在の pending turn_id の照合と監査は維持する。
起動前の履歴や後から読み込まれた過去の応答、ユーザー側の JSON は実行しない。

ローカルChrome検証では非アクティブタブへの Puppeteer のクリックで、過去のログと同じ
`Runtime.callFunctionOn timed out` も再現した。スクロールや描画待ちを避けるため、DOM へのフォーカスと
送信ボタンの DOM click に変更した。タブを前面に奪わず、送信後の入力欄クリア確認は維持する。

`missing_scope / api.responses.write` の警告も実セッションに残っていた。
Live の内部履歴圧縮には API キーの Responses Write を追加し、新しいセッションを開始する必要がある。
機体制御の判断モデルを Responses API に切り替えたものではない。

## 検証と残る確認

全98テストとローカルChromeで、入力・送信、新旧の応答検出、過去履歴の除外、バックグラウンドタブ、
警告音の生成、無音判定、記憶の閲覧を検証する。
実際の欠落の再現、物理スピーカーの警告音量、修正後の有料 Live 会話全体は未検証。
反映にはカーネルの再起動と管理画面の更新が必要。
