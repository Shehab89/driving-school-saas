import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="container narrow" style={{ paddingTop: 48 }}>
      <h1>Not allowed</h1>
      <p className="muted">Your account doesn&apos;t have access to this page.</p>
      <Link className="btn" href="/">Go to my dashboard</Link>
    </main>
  );
}
