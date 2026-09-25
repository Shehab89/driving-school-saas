import Link from "next/link";

/** Stripe success redirect. Deliberately does NOT mark anything paid: only the webhook does. */
export default function PaymentDone() {
  return (
    <main className="container narrow" style={{ paddingTop: 48 }}>
      <h1>Thank you!</h1>
      <p>Your payment is being processed. You will receive a confirmation e-mail as soon as it is confirmed.</p>
      <Link className="btn" href="/">Go to my dashboard</Link>
    </main>
  );
}
