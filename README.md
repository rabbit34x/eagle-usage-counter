# Eagle Usage Counter

Eagleで選択した画像の使用履歴をローカルSQLiteに記録し、使用回数とランキングを表示するウィンドウプラグインです。

## 現在の機能

- 選択中の画像を一括で使用済みにする
- 画像ごとの使用回数を表示する
- 直前の一括記録を取り消す（履歴は論理的に保持）
- 全期間・過去30日・過去7日・今日のランキング
- SQLiteデータベースのバックアップと復元
- Eagleライブラリごとにデータベースを分離

すべてのデータはローカルに保存され、外部へ送信されません。

## 開発

```bash
npm install
npm test
npm run check
```

Eagleの「プラグイン → 開発者オプション」から、このディレクトリを開発用プラグインとして読み込んでください。

## データ保存先

可能ならEagle (Electron) の `userData` 配下、取得できない環境ではOSのユーザーデータディレクトリ配下に保存します。ライブラリパスのSHA-256を使ってライブラリ別のディレクトリを作成します。

```text
<userData>/eagle-usage-counter/libraries/<library hash>/usage.sqlite
```

画像本体やEagleの `metadata.json` は変更しません。画像を再登録してEagle item IDが変わった場合は、旧履歴とは自動で結合されません。

## 技術構成

ネイティブバイナリの配布を避けるため、SQLiteにはWASM版の [`sql.js`](https://github.com/sql-js/sql.js/) を使用しています。書き込みのたびにSQLiteファイルへ永続化します。
