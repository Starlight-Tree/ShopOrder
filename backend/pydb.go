package main

// DB の入口。Python（psycopg の dict_row・`with connection() as conn:`）と同じ形で書けるようにした薄い層。
//   - withTx: 1 つのトランザクション。関数が正常に終われば commit、panic すれば rollback して panic を続ける（Python の with ブロックと同じ）
//   - row: dict_row 相当（列名 → 値）。数値は int64、時刻は time.Time、時刻（time 型）は文字列で受ける（SQL 側で ::text にする）
//   - SQL の失敗は panic(dbError)。経路の入口が受けて 500（本文は固定の文。例外の文字列は出さない）にする
//   - pgx は Exec モード（QueryExecModeExec。型の無いパラメーターを Postgres に推論させる。整数は int8 で渡るので、int4 を要る所は $1::int と書く）

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const dbTimeout = 15 * time.Second

var dbPool *pgxpool.Pool

type dbError struct{ err error }

func (e dbError) Error() string { return e.err.Error() }

func openPool(ctx context.Context, url string, maxConns int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL を読めません (%T)", err) // 例外の文字列には接続先が入りうる。型だけ
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	cfg.ConnConfig.ConnectTimeout = 15 * time.Second
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("DB の接続プールを作れませんでした (%T)", err)
	}
	return pool, nil
}

// tx は 1 つのトランザクション（Python の conn）。
type tx struct {
	ctx context.Context
	t   pgx.Tx
}

type row map[string]any

func (t *tx) query(sql string, args ...any) []row {
	rows, err := t.t.Query(t.ctx, sql, args...)
	if err != nil {
		panic(dbError{err})
	}
	defer rows.Close()
	names := rows.FieldDescriptions()
	var out []row
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			panic(dbError{err})
		}
		r := make(row, len(vals))
		for i, v := range vals {
			r[names[i].Name] = v
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		panic(dbError{err})
	}
	return out
}

// all は全行。one は先頭の 1 行（無ければ nil）。exec は影響した行数（Python の rowcount）。
func (t *tx) all(sql string, args ...any) []row { return t.query(sql, args...) }

func (t *tx) one(sql string, args ...any) row {
	rows := t.query(sql, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}

func (t *tx) exec(sql string, args ...any) int64 {
	tag, err := t.t.Exec(t.ctx, sql, args...)
	if err != nil {
		panic(dbError{err})
	}
	return tag.RowsAffected()
}

// withTx は 1 つのトランザクションを開いて fn を流す。
func withTx(fn func(t *tx)) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pgtx, err := dbPool.Begin(ctx)
	if err != nil {
		panic(dbError{err})
	}
	done := false
	defer func() {
		if !done {
			_ = pgtx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	fn(&tx{ctx: ctx, t: pgtx})
	if err := pgtx.Commit(ctx); err != nil {
		panic(dbError{err})
	}
	done = true
}

// inTx は withTx の戻り値つき。
func inTx[T any](fn func(t *tx) T) T {
	var out T
	withTx(func(t *tx) { out = fn(t) })
	return out
}

// isRetryable はデッドロック（40P01）・直列化失敗（40001）か。
func isRetryable(r any) bool {
	de, ok := r.(dbError)
	if !ok {
		return false
	}
	var pg *pgconn.PgError
	return errors.As(de.err, &pg) && (pg.Code == "40P01" || pg.Code == "40001")
}

// pgCode は dbError の SQLSTATE（無ければ空）。
func pgCode(r any) string {
	de, ok := r.(dbError)
	if !ok {
		return ""
	}
	var pg *pgconn.PgError
	if errors.As(de.err, &pg) {
		return pg.Code
	}
	return ""
}

// withRetry は fn をデッドロック・直列化失敗のときだけ数回やり直す（fn は、自分でトランザクションを開き、失敗したら全部巻き戻る操作に限る）。
func withRetry[T any](fn func() T) T {
	for attempt := 0; ; attempt++ {
		var out T
		var caught any
		func() {
			defer func() { caught = recover() }()
			out = fn()
		}()
		if caught == nil {
			return out
		}
		if !isRetryable(caught) || attempt >= txRetries-1 {
			panic(caught)
		}
		time.Sleep(time.Duration(50*(attempt+1)) * time.Millisecond)
	}
}

// ---- row の取り出し（dict_row の row["x"] 相当）----

func (r row) isNull(name string) bool { return r[name] == nil }

func toInt64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int32:
		return int64(x)
	case int16:
		return int64(x)
	case int:
		return int64(x)
	case pgtype.Numeric:
		bi := new(big.Int)
		f, err := x.Float64Value()
		if err == nil && f.Valid {
			bi.SetInt64(int64(f.Float64))
		}
		return bi.Int64()
	case float64:
		return int64(x)
	case string:
		n, _ := new(big.Int).SetString(x, 10)
		if n == nil {
			return 0
		}
		return n.Int64()
	}
	panic(fmt.Sprintf("整数でない値: %T", v))
}

func (r row) i(name string) int { return int(toInt64(r[name])) }

func (r row) i64(name string) int64 { return toInt64(r[name]) }

func (r row) iN(name string) *int {
	if r[name] == nil {
		return nil
	}
	n := r.i(name)
	return &n
}

func (r row) s(name string) string {
	switch x := r[name].(type) {
	case string:
		return x
	case nil:
		return ""
	case [16]byte:
		return uuidString(x)
	}
	panic(fmt.Sprintf("文字列でない値: %s %T", name, r[name]))
}

func (r row) sN(name string) *string {
	if r[name] == nil {
		return nil
	}
	s := r.s(name)
	return &s
}

func (r row) b(name string) bool {
	v, _ := r[name].(bool)
	return v
}

func (r row) t(name string) time.Time {
	switch x := r[name].(type) {
	case time.Time:
		return x
	case pgtype.Timestamptz:
		return x.Time
	}
	panic(fmt.Sprintf("時刻でない値: %s %T", name, r[name]))
}

func (r row) tN(name string) *time.Time {
	if r[name] == nil {
		return nil
	}
	t := r.t(name)
	return &t
}

// date は date 型の列（UTC の 0 時の time.Time で来る）。
func (r row) date(name string) dateOnly { return dateOf(r.t(name)) }

func (r row) dateN(name string) *dateOnly {
	if r[name] == nil {
		return nil
	}
	d := r.date(name)
	return &d
}

func (r row) strs(name string) []string {
	arr, _ := r[name].([]any)
	out := make([]string, 0, len(arr))
	for _, a := range arr {
		out = append(out, a.(string))
	}
	return out
}

func uuidString(b [16]byte) string {
	h := fmt.Sprintf("%x", b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ptr はリテラルのポインター化。
func ptr[T any](v T) *T { return &v }
