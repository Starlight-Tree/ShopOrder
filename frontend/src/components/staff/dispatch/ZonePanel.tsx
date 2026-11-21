'use client';
import { useState } from 'react';
import type { Zone } from '../../../lib/staff/delivery-types';
import { zoneSummary } from '../../../lib/staff/dispatch';

type Props = {
  /** null = 読み込めなかった */
  zones: readonly Zone[] | null;
  /** 警報の操作を出す（店長だけ。staff・courier には出さない。権限は API が毎回決める） */
  canSuspend: boolean;
  busy: boolean;
  /** 警報を立てる・解除する。成功したら true */
  onSuspension: (zone: Zone, suspended: boolean) => Promise<boolean>;
};

/** 砂嵐の警報（区画の停止）。状態は全員に見せ、操作は店長だけ。立てるときは、影響を示して確かめる */
export function ZonePanel({ zones, canSuspend, busy, onSuspension }: Props) {
  const [confirmId, setConfirmId] = useState<number | null>(null);
  return (
    <section className="st-panel" aria-labelledby="st-zones-title">
      <h2 id="st-zones-title" className="st-panel-title">
        砂嵐の警報
      </h2>
      <p className="muted">警報は区画ごとに、全店へ効きます。立っている間、その区画の宅配は受け付けません。</p>
      {zones === null ? (
        <p className="st-empty muted">区画の状態を読み込めませんでした。自動で再試行します。</p>
      ) : zones.length === 0 ? (
        <p className="st-empty muted">届ける区画がありません</p>
      ) : (
        <ul className="st-zone-list">
          {zones.map((z) => (
            <li key={z.id} className={`st-zone${z.is_suspended ? ' is-suspended' : ''}`}>
              <p className="st-zone-head">
                <span className="st-zone-name">{z.name}</span>
                <span className={z.is_suspended ? 'tag tag-danger' : 'tag tag-ok'}>{z.is_suspended ? '警報中（受付停止）' : '受付中'}</span>
              </p>
              <p className="muted st-zone-summary">{zoneSummary(z)}</p>
              {canSuspend ? (
                z.is_suspended ? (
                  <button
                    type="button"
                    className="st-btn st-btn-secondary"
                    disabled={busy}
                    aria-label={`${z.name}の警報を解除する`}
                    onClick={() => void onSuspension(z, false)}
                  >
                    警報を解除する
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="st-btn st-btn-danger-outline"
                      disabled={busy}
                      aria-expanded={confirmId === z.id}
                      aria-label={`${z.name}の警報を立てる`}
                      onClick={() => setConfirmId(confirmId === z.id ? null : z.id)}
                    >
                      警報を立てる
                    </button>
                    {confirmId === z.id ? (
                      <div className="st-confirm" role="group" aria-label={`${z.name}の警報の確認`}>
                        <p>{z.name}の警報を立てると、全店で、この区画への宅配を受け付けなくなります（枠を確保済みの注文は、そのまま届けます）。</p>
                        <div className="st-actions">
                          <button
                            type="button"
                            className="st-btn st-btn-danger"
                            disabled={busy}
                            onClick={async () => {
                              if (await onSuspension(z, true)) setConfirmId(null);
                            }}
                          >
                            警報を立てて受付を止める
                          </button>
                          <button type="button" className="st-btn st-btn-secondary" disabled={busy} onClick={() => setConfirmId(null)}>
                            やめる
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canSuspend ? null : <p className="muted">警報を立てる・解除する操作は、店長だけができます。</p>}
    </section>
  );
}
