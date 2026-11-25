package main

// テストが DB を作り直す（DROP DATABASE → CREATE）前の、対象の検査（backend/tests/guards.py の移植）。
//
// TEST_DATABASE_URL を開発用の DB（db）や本番へ向け間違えても、消さないための最後の砦。
// 通すのは、使い捨てのサーバーのホスト名と、テスト用の DB 名だけ（どちらも完全一致）。

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// allowedTestHosts は作り直してよいサーバーのホスト名。test-db は、開発コンテナの使い捨ての Postgres（.devcontainer/docker-compose.yml）。
// 増やすときは、そのサーバーが使い捨てであること（データを失ってよいこと）を確かめる。
var allowedTestHosts = []string{"test-db", "localhost", "127.0.0.1", "::1"}

// testDBName は作り直してよい DB 名。開発用の DB（shoporder）・postgres・テンプレートは、この形に当たらない。
var testDBName = regexp.MustCompile(`^shop_order_[a-z0-9_]+$`)

// 接続先を上書きできる URL の問い合わせ項目（libpq）。ホストの検査をすり抜けるので、付いていたら拒否する。
var urlOverrides = map[string]bool{"host": true, "hostaddr": true, "service": true, "port": true, "dbname": true, "passfile": true, "sslrootcert": true}

// assertDisposableTarget は作り直してよい対象でなければ error。メッセージにはホスト名と DB 名だけを入れる（URL 全体は、パスワードを含みうる）。
func assertDisposableTarget(adminURL, name string) error {
	if adminURL == "" {
		return fmt.Errorf("TEST_DATABASE_URL が未設定のまま、DB を作り直そうとしました")
	}
	u, err := url.Parse(adminURL)
	if err != nil || (u.Scheme != "postgresql" && u.Scheme != "postgres") {
		return fmt.Errorf("TEST_DATABASE_URL は postgresql:// の URL だけを受け付けます")
	}
	host := u.Hostname()
	ok := false
	for _, h := range allowedTestHosts {
		if h == host {
			ok = true
		}
	}
	if !ok {
		hosts := append([]string(nil), allowedTestHosts...)
		sort.Strings(hosts)
		return fmt.Errorf("テストが DB を作り直せるのは、使い捨てのサーバー（%s）だけです。指定: %q", strings.Join(hosts, ", "), host)
	}
	var bad []string
	for k := range u.Query() {
		if urlOverrides[k] {
			bad = append(bad, k)
		}
	}
	if len(bad) > 0 {
		sort.Strings(bad)
		return fmt.Errorf("TEST_DATABASE_URL の問い合わせ部で、接続先を変える項目は使えません: %v", bad)
	}
	if !testDBName.MatchString(name) {
		return fmt.Errorf("テストが作り直せる DB 名は shop_order_* （小文字・数字・_）だけです。指定: %q", name)
	}
	return nil
}

// urlWithDatabase は URL のパスだけを差し替える（文字列の分割では、問い合わせ部やパスの形によって、検査した DB とずれうる）。
func urlWithDatabase(adminURL, name string) (string, error) {
	u, err := url.Parse(adminURL)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	u.RawPath = ""
	if u.Path != "/"+name {
		return "", fmt.Errorf("接続先の組み立てに失敗しました")
	}
	return u.String(), nil
}
