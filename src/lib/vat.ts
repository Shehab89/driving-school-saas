/**
 * VAT arithmetic in integer cents. Rates are basis points (2100 = 21%).
 * With VAT-inclusive prices the gross amount is what the customer pays and
 * the VAT is the part of it above the net amount, rounded half-up once on the
 * invoice total (not per line), which is how Dutch invoices are usually done.
 */
export interface VatSplit {
  netCents: number;
  vatCents: number;
  grossCents: number;
}

export function splitVat(amountCents: number, rateBps: number, pricesIncludeVat: boolean): VatSplit {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error("amount must be a non-negative integer");
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new Error("invalid VAT rate");
  if (pricesIncludeVat) {
    const net = Math.round((amountCents * 10000) / (10000 + rateBps));
    return { netCents: net, vatCents: amountCents - net, grossCents: amountCents };
  }
  const vat = Math.round((amountCents * rateBps) / 10000);
  return { netCents: amountCents, vatCents: vat, grossCents: amountCents + vat };
}

export function formatVatRate(rateBps: number): string {
  return `${(rateBps / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;
}
