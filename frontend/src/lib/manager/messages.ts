// 店長の画面に出す固定の文（API の例外の文面・アドレスは出さない）。
export const MGMSG = {
  forbidden: 'この画面を見る権限がありません',
  unreachable: 'API に接続できません。しばらくしてから、もう一度お試しください',
  generic: 'うまくいきませんでした。もう一度お試しください',
  dummy: 'この画面の数字は、すべてダミーです（架空の惑星ザーハードの、架空の店の数字。実在の店・人・売上とは関係がありません）。',
  customersOnlyManager: '顧客の分析は、全店の店長だけが見られます。',
  courier: '配達員のアカウントでは、分析は使えません。',
  purpose: '利用目的: 注文の履行・配達の連絡・購買履歴の分析による商品提案と店の改善。',
  minCell: '人数のセルは、5 人未満のとき出しません（個人が特定されないように）。',
} as const;

export const COMPARISON_REASONS: Record<string, string> = {
  previous_missing: '前の期間の集計が足りないため、比べられません。',
  weekday_mismatch: '曜日の構成が前の期間と違うため、比べられません。',
  open_days_mismatch: '営業日の数が前の期間と違う（休業があった）ため、比べられません。',
  previous_zero: '前の期間の売上が 0 のため、比べられません。',
};
