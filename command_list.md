LLMが出すコマンド
LLMはJSON構造のみで入出力するものとする．
全てのコマンドとJSON構造は1対1対応しており，他の構造で代替できるものではない．

## KernelからLLMへの共通入力

Kernelからの入力は，以下の`cognitive_context`に統一する．従来この文書に記載していた
`sensor`，`vision`，`event`，`user_input`相当の値は`trigger.payload`に入る．

```json
{
  "type": "cognitive_context",
  "protocol_version": "1.1",
  "trigger": {
    "id": "obs_123",
    "type": "interaction.user_input",
    "payload": { "text": "気分はどう？" }
  },
  "persona": {
    "id": "kokomi-origin",
    "version": "604b425e381c"
  },
  "state": {
    "environment": {
      "temperature_c": 24.5,
      "humidity_percent": 67.3,
      "pressure_hpa": 1017,
      "brightness_raw": 439
    },
    "perception": {
      "person_present": "unknown"
    },
    "interaction": {
      "being_petted": "unknown"
    }
  },
  "world": {
    "room_occupied": "unknown",
    "thermal_condition": "comfortable",
    "lighting_condition": "bright"
  }
}
```

`state`は継続状態のLLM向け圧縮表現，`world`はKernelが決定論的に導出した
世界モデルの圧縮表現である．文字列`unknown`と`stale`を現在の事実として
扱ってはならない．`memory`と`behavior_proposals`は中身がある場合だけ追加される．
`behavior_proposals`は候補であって命令ではない．

## LLMからKernelへの出力

@MTFF0000;@
{
  "actions": [
    {
      "type": "tear",
      "params": {
        "speed": 10,
        "duration": 5
      }
    }
  ]
}
speed，durationは0~255．
これ以外の変数が入っている場合，変数が1つでも足りない場合，定義域外の場合は不正扱い．

@LT00FF00;@
{
  "actions": [
    {
      "type": "led_change",
      "params": {
        "color": "#00FF00"
      }
    }
  ]
}
colorはHEXカラーコード．
これ以外の変数が入っている場合，変数が1つでも足りない場合，カラーコードでない場合は不正扱い．

（参考：2つのアクションを組み合わせる場合は以下のように書く）
{
  "actions": [
    {
      "type": "tear",
      "params": {
        "speed": 10,
        "duration": 5
      }
    },
    {
      "type": "led_change",
      "params": {
        "color": "#00FF00"
      }
    }
  ]
}

登録人物照合用の顔記憶
{
  "actions": [
    {
      "type": "remember_person",
      "params": {
        "track_id": "7",
        "name": "たかん"
      }
    }
  ]
}
track_idは直近のDeepSORTイベントから取得する．本人が名前を名乗るか，明示的に記憶を依頼した場合だけ実行する．このアクションは非同期の顔収集を開始するものであり，登録完了はperson_enrolledイベントで確認する．


@THP@
{
    "requests": [
        "temperature",
        "humidity",
        "pressure"
    ]
}
これ以外の変数が入っている場合，変数が1つでも足りない場合は不正扱い．

@vision:describe the scene@
{
  "requests": [
    {
      "type": "vision",
      "params": {
        "task": "describe_scene"
      }
    }
  ]
}
Taskはとりあえずdescribe_sceneのみ．これ以外の変数が入っている場合，変数が1つでも足りない場合，定義域外の場合は不正扱い．

会話文
{
  "speech": "string",
  "emotion": "enum",
  "intensity": 0.0
}
emotionはneutral，happy，calm，sad，angry，surprised，fear，thinking．
intensityは0.0~1.0の実数値．
これ以外の変数が入っている場合，変数が1つでも足りない場合，定義域外の場合は不正扱い．
以下は`trigger.payload`に入る入力ペイロードの例．

センサー取得結果
{
  "sensor": {
    "temperature": 24.31,
    "humidity": 51.22,
    "pressure": 1008.14
  },
  "units": {
    "temperature": "celsius",
    "humidity": "percent",
    "pressure": "hpa"
  }
}


Vision input with the camera image attached to the same message:
{
  "task": "describe_scene",
  "query": "describe the scene",
  "input": "attached_image"
}



DeepSORT: 人物追跡イベント
{
  "track_id": "7",
  "identity": {
    "status": "recognized",
    "person_id": "26b7e2c15a1e4449974367f7da686b74",
    "name": "KOT",
    "distance": 0.2563,
    "threshold": 0.3
  },
  "message": "The visible registered person is KOT."
}
外側の`trigger.type`はvision.person_recognized，vision.person_unknown，vision.person_enrolled，vision.person_disappearedのいずれか．
人物を検出しただけではイベントは送られない．登録人物を認識した場合はidentity.statusがrecognizedとなり，nameとperson_idが設定される．未登録人物として確定した場合はidentity.statusがunknownとなる．person_disappearedは認識結果を通知済みのトラックに対してのみ送られる．

ユーザー入力
{
  "text": "気分はどう？"
}
