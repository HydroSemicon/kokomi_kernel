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



DeepSORT: 人間が現れました
@PERSON_EVENT@
{
  "event": {
    "source": "deepsort",
    "type": "person_appeared",
    "message": "A person has appeared."
  }
}

ユーザー入力
{
  "user_input": "気分はどう？"
}
