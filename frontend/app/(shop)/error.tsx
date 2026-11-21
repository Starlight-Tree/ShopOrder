'use client';

// 想定外の失敗。例外の文字列は画面に出さない（固定の文だけ）
export default function ShopError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <h1>うまくいきませんでした</h1>
      <div className="notice" role="alert">
        <p>画面を表示できませんでした。しばらくしてから、もう一度お試しください。</p>
        <p>
          <button type="button" className="shop-btn shop-btn-primary" onClick={() => reset()}>
            もう一度読み込む
          </button>
        </p>
      </div>
    </>
  );
}
