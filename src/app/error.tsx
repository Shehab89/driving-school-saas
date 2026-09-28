"use client";
/** Friendly fallback instead of Next's bare "Application error" screen. The digest links it to the server log. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="container narrow" style={{ paddingTop: 64, maxWidth: 440, textAlign: "center" }}>
      <h1>Something went wrong</h1>
      <p className="muted">Er ging iets mis · حدث خطأ ما</p>
      <p>Please try again in a moment. If it keeps happening, contact your driving school.</p>
      <button className="primary" onClick={reset}>Try again</button>
      {error.digest && <p className="muted small" style={{ marginTop: 24 }}>Reference: {error.digest}</p>}
    </main>
  );
}
