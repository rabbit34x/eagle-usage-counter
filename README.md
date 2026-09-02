# Eagle Usage Counter

Eagleで選択した画像の使用履歴をローカルSQLiteに記録するプラグインです。日常操作はインスペクター、集計の閲覧は独立ウィンドウで行います。

## 現在の機能

- Eagle右側のインスペクターから使用回数を `＋` / `−`
- 複数選択した画像の使用回数を一括更新
- 画像ごとの使用回数を表示する
- `−` 操作後も履歴を論理的に保持
- Eagleライブラリごとにデータベースを分離
- 閲覧専用ウィンドウで期間別ランキングと集計を表示

すべてのデータはローカルに保存され、外部へ送信されません。

## 開発

```bash
npm install
npm test
npm run check
```

Eagleの「プラグイン → 開発者オプション」から、このディレクトリを開発用プラグインとして読み込んでください。画像を選択すると、右側のインスペクターにカウンターが表示されます（Eagle 4.0 Beta 17以降）。プラグイン一覧から開く独立ウィンドウはランキングと集計の閲覧専用です。

## データ保存先

Eagleライブラリ自体を変更しないように、ライブラリと同じ親ディレクトリへサイドカーフォルダーを作成します。

```text
<library parent>/<library name>.plugin-data/sqlite/usage-counter/usage.sqlite
```

例：

```text
\\NAS\share\Pictures.library
\\NAS\share\Pictures.library.plugin-data\sqlite\usage-counter\usage.sqlite
```

共通の `plugin-data` 以下へ、データ形式とプラグイン名で分けて保存します。画像本体やEagleの `metadata.json` は変更しません。画像を再登録してEagle item IDが変わった場合は、旧履歴とは自動で結合されません。

## 技術構成

ネイティブバイナリの配布を避けるため、SQLiteにはWASM版の [`sql.js`](https://github.com/sql-js/sql.js/) を使用しています。書き込みのたびにSQLiteファイルへ永続化します。
