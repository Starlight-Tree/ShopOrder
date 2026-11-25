package main

// 掃除（worker から呼ぶ。backend/app/sweep.py の移植）。期限切れ・使用済みの行を消して、表が増え続けないようにする。ログには件数だけを出す。
//   - checkout_proposals: 期限を過ぎて 1 日たったもの、使用済みで 1 日たったもの（提案は 10 分で無効。照会・監査の猶予に 1 日）
//   - staff_login_attempts: 1 日より古い試行（制限の窓は 15 分）
//   - staff_sessions: 期限切れ

import "time"

const sweepKeep = 24 * time.Hour

// sweepRun は掃除を 1 回行い、消した行の合計を返す。
func sweepRun() int {
	now := utcNow()
	cutoff := now.Add(-sweepKeep)
	var proposals, attempts, sessions int64
	withTx(func(t *tx) {
		proposals = t.exec("DELETE FROM checkout_proposals WHERE (used_at IS NOT NULL AND used_at < $1) OR expires_at < $1", cutoff)
		attempts = t.exec("DELETE FROM staff_login_attempts WHERE at < $1", cutoff)
		sessions = t.exec("DELETE FROM staff_sessions WHERE expires_at < $1", now)
	})
	total := int(proposals + attempts + sessions)
	if total > 0 {
		logf("掃除: 提案 %d・ログイン試行 %d・セッション %d", proposals, attempts, sessions)
	}
	return total
}
