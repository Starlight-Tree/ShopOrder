package main

// 番号付き SQL のマイグレーション実行器（backend/app/migrate.py の移植）。
//
//	api migrate --status     適用状況の表示だけ（DB を変えない）
//	api migrate --dry-run    適用するものの一覧と事前の検査だけ（DB を変えない）
//	api migrate              未適用のものを順に適用する
//
//   - migrations/NNNN_名前.sql（バイナリに埋め込む）を、0001 から連続した番号の順に流す。1 ファイルを 1 トランザクションで流し、成功したときだけ記録する
//     （lock_timeout 5 秒。ロックが取れなければ失敗して何も変えない）
//   - 記録にはファイルの sha256 を残し、適用済みのファイルが書き換わっていたら止まる。直すときは新しい番号のファイルを足す
//   - 同時に 2 つ動かないよう、アドバイザリーロックを取る。DROP / TRUNCATE を含むファイルは、このリポジトリでは足さない（実行器も拒否する）

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations
var migrationsFS embed.FS

// migrationSource は読むマイグレーション（既定は埋め込み。テストが、番号や中身を変えた版に差し替える）。
var migrationSource fs.FS = migrationsFS

const migrationLockKey = 7_204_002

var (
	migrationFile      = regexp.MustCompile(`^(\d{4})_[a-z0-9_]+\.sql$`)
	migrationForbidden = regexp.MustCompile(`(?i)\b(DROP|TRUNCATE)\b`)
	sqlLineComment     = regexp.MustCompile(`--[^\n]*`)
)

// migrationError は続行してはいけない状態（番号の乱れ、チェックサムの不一致など）。メッセージは固定の説明だけで、接続情報を含めない。
type migrationError struct{ msg string }

func (e *migrationError) Error() string { return e.msg }

type migration struct {
	version, name string
	sql           []byte
}

// migrationFiles は番号順。番号の重複・欠番・規則に合わない名前は migrationError。
func migrationFiles() ([]migration, error) {
	entries, err := fs.ReadDir(migrationSource, "migrations")
	if err != nil {
		return nil, err
	}
	var found []migration
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		m := migrationFile.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, &migrationError{"マイグレーションのファイル名が規則に合いません: " + e.Name()}
		}
		data, err := fs.ReadFile(migrationSource, "migrations/"+e.Name())
		if err != nil {
			return nil, err
		}
		found = append(found, migration{version: m[1], name: strings.TrimSuffix(e.Name(), ".sql"), sql: data})
	}
	sort.Slice(found, func(i, j int) bool { return found[i].name < found[j].name })
	seen := map[string]bool{}
	for _, f := range found {
		if seen[f.version] {
			return nil, &migrationError{"同じ番号のマイグレーションが複数あります"}
		}
		seen[f.version] = true
	}
	for i, f := range found {
		if want := fmt.Sprintf("%04d", i+1); f.version != want {
			versions := make([]string, len(found))
			for k, x := range found {
				versions[k] = x.version
			}
			return nil, &migrationError{fmt.Sprintf("番号が 0001 から連続していません: %v", versions)}
		}
	}
	return found, nil
}

type appliedMigration struct{ name, checksum string }

type migrationPlan struct {
	pending  []migration
	problems []string
	applied  []string
}

func planMigrations(ctx context.Context, conn *pgx.Conn) (migrationPlan, error) {
	var p migrationPlan
	applied := map[string]appliedMigration{}
	var reg *string
	if err := conn.QueryRow(ctx, "SELECT to_regclass('public.schema_migrations')::text").Scan(&reg); err != nil {
		return p, err
	}
	if reg != nil {
		rows, err := conn.Query(ctx, "SELECT version, name, checksum FROM schema_migrations")
		if err != nil {
			return p, err
		}
		for rows.Next() {
			var v, n, c string
			if err := rows.Scan(&v, &n, &c); err != nil {
				rows.Close()
				return p, err
			}
			applied[v] = appliedMigration{n, c}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return p, err
		}
	}
	files, err := migrationFiles()
	if err != nil {
		return p, err
	}
	known := map[string]bool{}
	for _, f := range files {
		known[f.version] = true
		if migrationForbidden.MatchString(sqlLineComment.ReplaceAllString(string(f.sql), "")) {
			p.problems = append(p.problems, fmt.Sprintf("マイグレーション %s に DROP / TRUNCATE が含まれます（このリポジトリでは足さない決まりです）。", f.name))
		}
		if a, ok := applied[f.version]; ok && a.checksum != sha256Hex(f.sql) {
			p.problems = append(p.problems, fmt.Sprintf("適用済みのマイグレーション %s が書き換えられています（記録したチェックサムと違います）。", f.name))
		}
	}
	for v := range applied {
		p.applied = append(p.applied, v)
		if !known[v] {
			p.problems = append(p.problems, fmt.Sprintf("記録にあるマイグレーション %s のファイルがありません。", v))
		}
	}
	sort.Strings(p.applied)
	for _, f := range files {
		if _, ok := applied[f.version]; !ok {
			p.pending = append(p.pending, f)
		}
	}
	return p, nil
}

func pendingNames(p migrationPlan) string {
	if len(p.pending) == 0 {
		return "なし"
	}
	names := make([]string, len(p.pending))
	for i, m := range p.pending {
		names[i] = m.name
	}
	return strings.Join(names, ", ")
}

// applyMigrations は終了コード（0 = 成功、1 = 止まった）。dryRun では DB を変えない。
func applyMigrations(ctx context.Context, url string, dryRun bool, out io.Writer) (int, error) {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return 1, err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(migrationLockKey)); err != nil {
		return 1, err
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", int64(migrationLockKey))
	}()
	state, err := planMigrations(ctx, conn)
	if err != nil {
		return 1, err
	}
	for _, line := range state.problems {
		fmt.Fprintln(out, line)
	}
	if len(state.problems) > 0 {
		return 1, nil
	}
	fmt.Fprintln(out, "未適用: "+pendingNames(state))
	if dryRun {
		return 0, nil
	}
	if _, err := conn.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, "+
		"checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return 1, err
	}
	for _, m := range state.pending {
		tx, err := conn.Begin(ctx)
		if err != nil {
			return 1, err
		}
		if _, err := tx.Exec(ctx, "SET LOCAL lock_timeout = '5s'"); err != nil {
			_ = tx.Rollback(ctx)
			return 1, err
		}
		// 1 ファイルに複数の文があるので、simple プロトコルで流す（同じトランザクションの中）
		if _, err := conn.PgConn().Exec(ctx, string(m.sql)).ReadAll(); err != nil {
			_ = tx.Rollback(ctx)
			return 1, err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", m.version, m.name, sha256Hex(m.sql)); err != nil {
			_ = tx.Rollback(ctx)
			return 1, err
		}
		if err := tx.Commit(ctx); err != nil {
			return 1, err
		}
		fmt.Fprintln(out, "適用: "+m.name)
	}
	return 0, nil
}

func migrateMain(args []string) int {
	url := envGet("DATABASE_URL", "")
	if url == "" {
		fmt.Println("失敗しました（RuntimeError）。DATABASE_URL が未設定です")
		return 1
	}
	ctx := context.Background()
	has := func(flag string) bool {
		for _, a := range args {
			if a == flag {
				return true
			}
		}
		return false
	}
	report := func(err error) int {
		var me *migrationError
		if errors.As(err, &me) {
			fmt.Printf("失敗しました（MigrationError）。%s\n", me.msg)
		} else {
			// 接続情報を含みうる例外の本文は出さず、種類だけ出す
			fmt.Printf("失敗しました（%T）。DB への接続か SQL の実行でエラーです\n", err)
		}
		return 1
	}
	if has("--status") {
		conn, err := pgx.Connect(ctx, url)
		if err != nil {
			return report(err)
		}
		defer conn.Close(ctx)
		state, err := planMigrations(ctx, conn)
		if err != nil {
			return report(err)
		}
		fmt.Println("適用済み:", orNone(strings.Join(state.applied, ", ")))
		fmt.Println("未適用:", pendingNames(state))
		for _, line := range state.problems {
			fmt.Println(line)
		}
		if len(state.problems) > 0 {
			return 1
		}
		return 0
	}
	code, err := applyMigrations(ctx, url, has("--dry-run"), os.Stdout)
	if err != nil {
		return report(err)
	}
	return code
}

func orNone(s string) string {
	if s == "" {
		return "なし"
	}
	return s
}
