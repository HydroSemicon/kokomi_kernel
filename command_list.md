LLMが出すコマンド
LLMはJSON構造のみで入出力するものとする．
全てのコマンドとJSON構造は1対1対応しており，他の構造で代替できるものではない．

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
LLMに入れるコマンド
Sensor | Temp: 24.31 C Hum: 51.22% Press: 1008.14 hPa 
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
  "vision": {
    "task": "describe_scene",
    "query": "describe the scene",
    "input": "attached_image"
  }
}



DeepSORT: 人物追跡イベント
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
typeはperson_recognized，person_unknown，person_enrolled，person_disappearedのいずれか．
人物を検出しただけではイベントは送られない．登録人物を認識した場合はidentity.statusがrecognizedとなり，nameとperson_idが設定される．未登録人物として確定した場合はidentity.statusがunknownとなる．person_disappearedは認識結果を通知済みのトラックに対してのみ送られる．

ユーザー入力
{
  "user_input": "気分はどう？"
}
