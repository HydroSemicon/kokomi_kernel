from pathlib import Path
import json, re, hashlib, subprocess, html, math, sys
from reportlab.pdfgen import canvas
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak, Table, TableStyle, Flowable, KeepTogether, Preformatted)
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import stringWidth
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
TMP = ROOT / 'tmp' / 'pdfs' / 'kernel-guide'
TMP.mkdir(parents=True, exist_ok=True)
DATE = '2026-11-08'
BRANCH = subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip()
HEAD = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
pdfmetrics.registerFont(TTFont('JP', 'C:/Windows/Fonts/meiryo.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('JPB', 'C:/Windows/Fonts/meiryob.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('Mono', 'C:/Windows/Fonts/consola.ttf'))
pdfmetrics.registerFontFamily('JP', normal='JP', bold='JPB', italic='JP', boldItalic='JPB')

NAVY=colors.HexColor('#172C43'); TEAL=colors.HexColor('#087F8C'); INK=colors.HexColor('#233347')
MUTED=colors.HexColor('#637487'); LIGHT=colors.HexColor('#EDF5F6'); LINE=colors.HexColor('#D9E2E8')
W,H=A4; CW=W-94
ST={
 'body': ParagraphStyle('body',fontName='JP',fontSize=10.1,leading=17.1,textColor=INK,wordWrap='CJK',spaceAfter=9),
 'h2': ParagraphStyle('h2',fontName='JPB',fontSize=12.1,leading=19,textColor=NAVY,spaceBefore=10,spaceAfter=7,keepWithNext=True,wordWrap='CJK'),
 'title': ParagraphStyle('title',fontName='JPB',fontSize=20,leading=29,textColor=NAVY,spaceAfter=15,wordWrap='CJK'),
 'small': ParagraphStyle('small',fontName='JP',fontSize=8.1,leading=12.7,textColor=MUTED,wordWrap='CJK',spaceAfter=5),
 'cell': ParagraphStyle('cell',fontName='JP',fontSize=9,leading=14,textColor=INK,wordWrap='CJK'),
 'thead': ParagraphStyle('thead',fontName='JPB',fontSize=9,leading=14,textColor=colors.white,wordWrap='CJK'),
 'callout': ParagraphStyle('callout',fontName='JP',fontSize=10,leading=17,textColor=NAVY,wordWrap='CJK'),
 'code': ParagraphStyle('code',fontName='JP',fontSize=8.3,leading=12.5,textColor=INK,wordWrap='CJK'),
}

def inline(t):
    t=html.escape(t)
    t=re.sub(r'\*\*(.*?)\*\*',r'<b>\1</b>',t)
    t=re.sub(r'`([^`]+)`',r'<font color="#087F8C">\1</font>',t)
    t=re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)',r'<link href="\2" color="#087F8C">\1</link>',t)
    return t

def p(t,style='body'): return Paragraph(inline(t),ST[style])

class Diagram(Flowable):
    def __init__(self,kind):
        super().__init__(); self.kind=kind; self.width=CW
        self.height={'overview':255,'delegation':268,'sync':215,'action':250,'memory':260,'restart':210,'startup':268,'lanes':224,'camera':235,'search':220,'environment':210,'retry':215}.get(kind,220)
    def draw(self):
        c=self.canv; h=self.height
        def box(x,y,w,hh,title,sub='',fill=LIGHT):
            c.setFillColor(fill); c.setStrokeColor(LINE); c.roundRect(x,y,w,hh,7,fill=1,stroke=1)
            q=Paragraph(inline(title),ParagraphStyle('dt',fontName='JPB',fontSize=9.7,leading=14,textColor=NAVY,alignment=1,wordWrap='CJK'))
            _,qh=q.wrap(w-12,hh); q.drawOn(c,x+6,y+hh-qh-9)
            if sub:
                q=Paragraph(inline(sub),ParagraphStyle('ds',fontName='JP',fontSize=8,leading=12,textColor=MUTED,alignment=1,wordWrap='CJK'))
                _,qh=q.wrap(w-12,hh); q.drawOn(c,x+6,y+7)
        def arrow(x1,y1,x2,y2,label='',bend=False):
            c.setStrokeColor(TEAL); c.setFillColor(TEAL); c.setLineWidth(1.3)
            c.line(x1,y1,x2,y2)
            a=math.atan2(y2-y1,x2-x1); z=5
            c.line(x2,y2,x2-z*math.cos(a-.5),y2-z*math.sin(a-.5)); c.line(x2,y2,x2-z*math.cos(a+.5),y2-z*math.sin(a+.5))
            if label:
                c.setFont('JP',7.7); c.setFillColor(MUTED); c.drawCentredString((x1+x2)/2,(y1+y2)/2+5,label)
        if self.kind=='overview':
            box(0,181,130,58,'人・部屋・身体','発話／温度／人物／接触')
            box(181,181,144,58,'ブラウザ + GPT-Live','WebRTC音声・自然な会話')
            box(371,181,130,58,'会話ログ','文字起こし・処理位置')
            arrow(130,210,181,210,'音声'); arrow(325,210,371,210,'断片')
            box(0,78,130,67,'観測 → 状態 → 世界','鮮度・根拠・ドライブ')
            box(181,78,144,67,'Kernel + 行動ゲート','照会・権限・実行・結果')
            box(371,78,130,67,'Responses API','判断／画像／検索／記憶')
            arrow(65,181,65,145,'センサー'); arrow(253,181,253,145,'委譲')
            arrow(130,112,181,112,'文脈'); arrow(325,125,371,125,'依頼'); arrow(371,95,325,95,'JSON')
            box(0,0,130,48,'保存ストア','観測・記憶・社会状態'); box(181,0,144,48,'機体・外部サービス','LED／涙／SNS／人物登録')
            arrow(65,78,65,48); arrow(253,78,253,48); arrow(280,48,280,78)
            c.setFont('JP',8); c.setFillColor(MUTED); c.drawString(343,24,'矢印は主要な情報経路')
        elif self.kind in ['delegation','startup']:
            if self.kind=='delegation':
                names=['ユーザー／Live','Kernel','Responses','機体']; rows=[(0,1,'① 委譲イベント + 文字起こし'),(1,2,'② 状態と依頼をJSONで送信'),(2,1,'③ actions / requests / result'),(1,3,'④ ゲート通過後に実行'),(3,1,'⑤ 受理結果・エラー'),(1,0,'⑥ 確認結果を会話へ戻す')]
            else:
                names=['画面','Kernel','Live API','sideband']; rows=[(0,1,'① マイク取得・SDP offer'),(1,2,'② 共有方針・参考記録を送信'),(2,1,'③ セッションID・SDP answer'),(1,3,'④ 監視WebSocketを接続'),(1,0,'⑤ SDP answer・所有トークン'),(2,0,'⑥ session.started → 会話開始')]
            xs=[58,184,310,439]
            for x,n in zip(xs,names):
                box(x-55,h-43,110,35,n)
                c.setStrokeColor(LINE); c.line(x,8,x,h-48)
            for i,(a,b,t) in enumerate(rows):
                y=h-76-i*31
                arrow(xs[a],y,xs[b],y)
                c.setFont('JP',8.1); c.setFillColor(INK); c.drawCentredString((xs[a]+xs[b])/2,y+7,t)
        elif self.kind=='lanes':
            box(0,157,CW,53,'Liveの音声・文字起こし','会話の進行とログ保存はAPI処理の完了を待たない')
            box(0,64,230,58,'制御キュー','操作／通常照会／画像確認／検索')
            box(CW-230,64,230,58,'記憶キュー','抽出 → 根拠復元 → 別依頼で照合')
            arrow(115,157,115,122);arrow(CW-115,157,CW-115,122)
            box(0,0,CW,37,'Responses APIへ、それぞれ独立にリクエスト')
            arrow(115,64,115,37);arrow(CW-115,64,CW-115,37)
        else:
            flows={
                'sync':[('身体の観測','State / World / Drives'),('定性的な状態を選ぶ','hot／dark／在室／接触／人物'),('変化した内容だけ送信','thinking＝事実、instructions＝話し方'),('GPT-Liveの会話に反映','関連記憶も必要時に追加')],
                'action':[('LLMの操作案','turn_id / action / params'),('形式監査 + 行動ゲート','対応・権限・重複・クールダウン'),('intentionを保存 → 実行先へ','実行前に「何をするつもりか」を記録'),('outcomeを保存 → Liveへ','succeeded / failed / denied / unknown')],
                'memory':[('会話原文を保存 → 短い参照u1などを付ける','同一セッション・最大16グループ'),('候補抽出 → カーネルが原文とIDを復元','モデルに長い断片IDを生成させない'),('別依頼で本文を照合 → preparedを保存','根拠・支持番号・適用対象を固定'),('候補保存・採否 → 処理位置を前進','失敗なら準備済みの内容から再開')],
                'restart':[('観測ログ・各ストアを読み込む','過去の観測を最大20,000件再適用'),('状態を再構成・鮮度を再評価','古い自発候補は再生成しない'),('未完了の操作を整理','再起動で不明になった結果を明示'),('未処理会話を記憶抽出へ','音声接続は開始操作で作る')],
                'camera':[('カメラ質問を確定','Liveの委譲、または安定した文字起こし'),('同じ発言の撮影をまとめる','根拠IDの対応表を照合'),('画像を取得 → 読み取り専用のAPI依頼','task=live_vision／画像を同時に入力'),('確認できた内容をLiveへ返す','resultだけを許可し、機体操作は含めない')],
                'search':[('ユーザー依頼から公開クエリを選ぶ','web_searchを単独のrequestにする'),('検索専用Responsesを呼ぶ','ツールをweb_searchに固定／最大2回'),('検索完了と引用URLを確認','http(s)と認証情報なしのURLを採用'),('回答はLiveへ、出典は画面へ','検索結果から機体操作へは戻さない')],
                'environment':[('センサーの数値を内部に保持','温度・湿度・気圧・明るさと鮮度'),('世界モデルを規則で計算','cold／comfortable／warm／hot、明暗'),('モデルへは定性的な状態を投影','数値の環境描写を履歴・記憶からも選別'),('ダッシュボードでは数値を確認','運用者の測定確認と会話の情報を区別')],
                'retry':[('最初の処理が失敗','処理済み位置を進めず、30秒後を予約'),('再試行も失敗','連続2回目、60秒後を予約'),('連続3回で失敗','自動再試行・flushを保留'),('再起動後に再開できる','ログとpreparedを使い、記録を失わない')],
            }
            items=flows[self.kind]; bh=43; gap=(h-4*bh)/3
            for i,(t,s) in enumerate(items):
                y=h-(i+1)*bh-i*gap
                box(45,y,CW-90,bh,t,s)
                if i<3: arrow(CW/2,y,CW/2,y-gap)

def make_table(lines,compact=False):
    rows=[[x.strip() for x in line.strip().strip('|').split('|')] for line in lines]
    rows=[r for r in rows if not all(re.fullmatch(r':?-{2,}:?',x or '-') for x in r)]
    n=len(rows[0]); widths=[CW/n]*n
    if n==2: widths=[CW*.32,CW*.68]
    elif n==3: widths=[CW*.25,CW*.24,CW*.51]
    elif n==4: widths=[CW*.20,CW*.21,CW*.25,CW*.34]
    if compact=='reference' and n==3: widths=[CW*.36,CW*.34,CW*.30]
    cellstyle=ParagraphStyle('compactcell',parent=ST['cell'],fontSize=8.7,leading=12.6)
    data=[[p(x,'thead') if i==0 else Paragraph(inline(x),cellstyle if compact else ST['cell']) for x in r] for i,r in enumerate(rows)]
    t=Table(data,colWidths=widths,hAlign='LEFT',repeatRows=1)
    pad=4.5 if compact else 7
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F4F7F9')]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),pad),('BOTTOMPADDING',(0,0),(-1,-1),pad),('LINEBELOW',(0,0),(-1,0),.5,NAVY),('LINEBELOW',(0,1),(-1,-1),.3,LINE)]))
    return [t,Spacer(1,9)]

def source_ref(raw):
    parts=[]
    for ref in raw.split(' | '):
        file,_,symbol=ref.partition('@')
        fp=ROOT/file
        if not fp.exists(): raise ValueError(f'Unknown reference {file}')
        line=''
        if symbol:
            hits=[i for i,s in enumerate(fp.read_text(encoding='utf-8-sig').splitlines(),1) if symbol in s]
            if not hits: raise ValueError(f'Unknown symbol {ref}')
            line=f':{hits[0]}'
        parts.append(file+line)
    return '根拠（作業ツリー）: '+' / '.join(parts)

def parse_blocks(text,compact=False):
    blocks=[]; lines=text.strip().splitlines(); i=0
    while i<len(lines):
        line=lines[i].strip()
        if not line: i+=1; continue
        if line.startswith('@sources '):
            blocks.append(p(source_ref(line[9:]),'small')); i+=1; continue
        if line.startswith('@diagram '):
            blocks.extend([Diagram(line[9:]),Spacer(1,12)]); i+=1; continue
        if line.startswith('## '): blocks.append(p(line[3:],'h2')); i+=1; continue
        if line.startswith(('```','~~~')):
            i+=1; code=[]
            while i<len(lines) and not lines[i].strip().startswith(('```','~~~')):
                code.append(lines[i]); i+=1
            content=Paragraph('<br/>'.join(html.escape(z).replace(' ','&#160;') for z in code),ST['code'])
            t=Table([[content]],colWidths=[CW]); t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#F1F4F7')),('BOX',(0,0),(-1,-1),.5,LINE),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
            blocks.extend([t,Spacer(1,10)]); i+=1; continue
        if line.startswith('|'):
            table=[]
            while i<len(lines) and lines[i].strip().startswith('|'): table.append(lines[i]); i+=1
            blocks.extend(make_table(table,compact=compact)); continue
        if line.startswith('> '):
            content=p(line[2:],'callout'); t=Table([[content]],colWidths=[CW]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('LINEBEFORE',(0,0),(0,0),3,TEAL),('LEFTPADDING',(0,0),(-1,-1),12),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)])); blocks.extend([t,Spacer(1,10)]); i+=1;continue
        if line.startswith('- '): blocks.append(p('・ '+line[2:])); i+=1;continue
        paragraph=[line];i+=1
        while i<len(lines) and lines[i].strip() and not lines[i].startswith(('## ','@','|','> ','```','~~~','- ')):
            paragraph.append(lines[i].strip());i+=1
        blocks.append(p(''.join(paragraph)))
    return blocks

class GuideDoc(BaseDocTemplate):
    def __init__(self,path,**kw):
        super().__init__(str(path),pagesize=A4,leftMargin=47,rightMargin=47,topMargin=62,bottomMargin=49,title='Kokomi Kernel 構造と動作の詳解',author='Codex / repository-based documentation',**kw)
        self.addPageTemplates(PageTemplate(id='main',frames=[Frame(47,49,CW,H-111,id='normal',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)],onPage=self.decorate))
        self.current_section=''; self.locations={}; self.current_part=''
    def decorate(self,c,doc):
        if doc.page==1: return
        c.setFillColor(MUTED);c.setFont('JP',7.7);c.drawString(47,H-30,'KOKOMI KERNEL  /  構造と動作の詳解')
        c.drawRightString(W-47,H-30,DATE+'  /  working tree')
        c.setStrokeColor(LINE);c.line(47,H-40,W-47,H-40);c.line(47,36,W-47,36)
        c.setFont('JP',7.5);c.drawString(47,23,BRANCH);c.drawRightString(W-47,23,str(doc.page))
    def afterFlowable(self,f):
        if getattr(f,'guide_heading',None):
            title=f.guide_heading; self.locations[title]=self.page
            key='section_'+str(len(self.locations));self.canv.bookmarkPage(key);self.canv.addOutlineEntry(title,key,level=0,closed=False)

class Cover(Flowable):
    def __init__(self):
        super().__init__()
        self.width=CW; self.height=690
    def draw(self):
        c=self.canv
        c.setFillColor(NAVY);c.rect(-W,-H,3*W,3*H,fill=1,stroke=0)
        c.setFillColor(TEAL);c.rect(-47,478,8,165,fill=1,stroke=0)
        c.setFont('JPB',11);c.setFillColor(colors.HexColor('#87D1D3'));c.drawString(0,632,'CODE READING GUIDE  /  '+DATE.replace('-','.'))
        c.setFillColor(colors.white);c.setFont('JPB',32);c.drawString(0,545,'Kokomi Kernel')
        c.setFont('JPB',26);c.drawString(0,495,'構造と動作の詳解')
        c.setFont('JP',13);c.drawString(0,452,'Live会話から、身体・世界モデル・記憶まで')
        text='何が起きると、どの部品が動くのか。\nなぜ、その機能が必要なのか。\n現在の実装を、コードの根拠とともに読み解く。'
        for i,line in enumerate(text.splitlines()): c.setFont('JP',12);c.drawString(0,359-i*28,line)
        c.setStrokeColor(colors.HexColor('#446178'));c.line(0,207,CW,207)
        c.setFillColor(colors.HexColor('#C9D5DF'));c.setFont('JP',9.4)
        for i,line in enumerate(['対象: '+BRANCH+' の作業ツリー','HEAD: '+HEAD,'未コミット変更を含む、現在の構造を読む資料','日本語 / 図解・動作例・用語集・実装参照付き']): c.drawString(0,177-i*23,line)

def manifest():
    files=[ROOT/'alice.js',ROOT/'config.json',ROOT/'package.json',ROOT/'control_prompt.md',ROOT/'README.md']
    files+=sorted((ROOT/'src').rglob('*.js'))+sorted((ROOT/'dashboard').glob('*.js'))+sorted((ROOT/'test').glob('*.js'))
    files+=[ROOT/'docs/live-api-spec.md',ROOT/'tools/memory-list.js',ROOT/'.env.example',ROOT/'.gitignore',ROOT/'dashboard/index.html',ROOT/'dashboard/styles.css']
    return {str(f.relative_to(ROOT)).replace('\\','/'):{'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'lines':len(f.read_text(encoding='utf-8-sig').splitlines())} for f in files}

def main():
    baseline_path=TMP/'source-baseline.json'
    if '--capture-sources' in sys.argv:
        snapshot={'date':DATE,'branch':BRANCH,'head':HEAD,'scope':'current working tree including uncommitted changes','sources':manifest()}
        baseline_path.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
        print('Captured current source snapshot:',len(snapshot['sources']))
        return
    snapshot_path=baseline_path if baseline_path.exists() else OUT/'kernel_guide_sources.json'
    snapshot=json.loads(snapshot_path.read_text(encoding='utf-8'))
    if snapshot['sources']!=manifest() or snapshot['branch']!=BRANCH or snapshot['head']!=HEAD:
        raise ValueError('Implementation changed during documentation; review the changed sources before rebuilding')
    source=OUT/'kernel_guide_ja.md'
    text=source.read_text(encoding='utf-8')
    sections=[]
    for match in re.finditer(r'^# ([^\n]+)\n(.*?)(?=^# |\Z)',text,re.M|re.S): sections.append((match[1].strip(),match[2]))
    items=snapshot['sources']; (OUT/'kernel_guide_sources.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf-8')
    def story(toc=None):
        s=[Cover(),PageBreak()]
        s.append(p('この資料の使い方','title'))
        s.extend(parse_blocks('''全体の構造を自分の言葉で説明できるようになることを目的に、現在のコードを入力から出力まで追った資料です。最初から全ファイルを暗記する必要はありません。まず「会話」「身体状態」「操作」「記憶」の流れを分け、必要なときに参照先へ戻ってください。
## おすすめの読み順
1周目は01～03、07～11、27～29、34、39～43を読みます。全体像と、会話・身体・記憶の責任がつながります。2周目は15～26と38～49で、情報の形式と保存を追います。3周目は動作例51～54をコードと照らし、用語集60～62と実装参照表67～68を辞書として使います。
## 記述の意味
「実装」はコードで確認した動作、「設定」は同梱config.jsonの値、「例」は理解用に組み立てた架空の入力です。「理由」は責任分割や障害対策から読み取れる設計上の意図を説明します。実機で確かめた結果と、コードから分かる結果を混同しません。
## 対象と調査方法
2026年11月8日（日本時間）の作業フォルダーを調査しました。未コミット変更を含むソース・設定・共有制御プロンプト・既存テストが対象です。同梱Node.js 24.22.1で84テストの成功を確認しました。実APIの有料会話や実機を動かす検証は行っていません。個人の会話・記憶の内容や.envの秘密値も転載していません。
## 参照の使い方
各ページ末尾の「根拠」はリポジトリ内のファイル名と行番号です。未コミット変更の内容も固定できるよう、参照対象のSHA-256一覧を付属ファイルへ保存しています。目次のリンクとしおりから各話題へ移動できます。前提知識なしで読み始められるよう、現在の構成だけを説明します。
> 一番大切な区別は、観測・解釈・提案・実行結果です。この四つを分けると、複雑に見える実装をかなり読みやすくできます。'''))
        s.append(PageBreak())
        chunk=24
        for start in range(0,len(sections),chunk):
            s.append(p('目次'+('（続き）' if start else ''),'title'))
            for ix,(title,_) in enumerate(sections[start:start+chunk],start+1):
                pn=str(toc.get(title,'')) if toc else ''
                entry=Paragraph(f'<link href="#section_{ix}">{inline(title)}</link>',ST['body'])
                t=Table([[entry,p(pn,'body')]],colWidths=[CW-35,35]);t.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),0),('TOPPADDING',(0,0),(-1,-1),2),('BOTTOMPADDING',(0,0),(-1,-1),2),('LINEBELOW',(0,0),(-1,-1),.3,LINE)]));s.append(t)
            s.append(PageBreak())
        for title,body in sections:
            heading=p(title,'title');heading.guide_heading=title;s.append(heading)
            compact='reference' if title[:2] in ('67','68') else title[:2] in ('55','56','58','60','61','62','69')
            s.extend(parse_blocks(body,compact=compact));s.append(PageBreak())
        s.pop()
        return s
    target=OUT/'kokomi_kernel_architecture_ja.pdf'
    first=GuideDoc(TMP/'draft.pdf');first.build(story())
    final=GuideDoc(target);final.build(story(first.locations))
    if first.locations!=final.locations: raise ValueError('TOC layout changed between builds')
    reader=PdfReader(target)
    report={'pages':len(reader.pages),'sections':final.locations,'source_count':len(items),'characters':len(text),'output':str(target)}
    (TMP/'build_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='sections'},ensure_ascii=True))

if __name__=='__main__': main()
