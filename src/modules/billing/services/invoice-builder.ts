import type { BillingSettings, InvoiceLine, InvoiceParty, NewInvoice, PaymentRecord } from "../types/billing.types.js";

const IST_OFFSET_MS = 330 * 60_000;
const day = (d: Date) =>
  d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/**
 * Turns a successful payment into a GST invoice. Pure, so the tax rules are unit-tested:
 * - same state for Eazotel and the hotel: CGST + SGST, half the rate each; otherwise IGST;
 * - numbers run per Indian financial year (April–March): EZ/26-27/00001;
 * - payments from this checkout itemise the plan, add-ons, seats, discounts and credit; older
 *   payments and auto-renewals show one line, worked back from the amount paid.
 */
export class InvoiceBuilder {
  static build(input: {
    payment: PaymentRecord;
    settings: BillingSettings;
    buyer: InvoiceParty;
    planName: string;
    issuedAt: Date;
  }): NewInvoice {
    const { payment, settings, buyer, planName, issuedAt } = input;
    const seller = settings.invoice;
    const sac = seller.sac || null;
    const quote = payment.quote;
    const gstPercent = quote?.gstPercent ?? settings.gstPercent;

    let lines: InvoiceLine[];
    let adjustments: NewInvoice["adjustments"] = [];
    let taxablePaise: number;
    let gstPaise: number;
    const periodStart = payment.periodStart ?? quote?.periodStart ?? null;
    const periodEnd = payment.periodEnd ?? quote?.periodEnd ?? null;
    const period = periodStart && periodEnd ? ` (${day(new Date(periodStart))} - ${day(new Date(periodEnd))})` : "";

    if (quote) {
      lines = quote.lines.map((l, i) => ({
        description: `${l.label}${i === 0 ? `, ${quote.cycleLabel.toLowerCase()} billing${period}` : ""}`,
        sac,
        quantity: quote.cycleMonths,
        unitPaise: l.monthlyPaise,
        amountPaise: l.monthlyPaise * quote.cycleMonths,
      }));
      adjustments = [
        ...(quote.cycleDiscountPaise ? [{ label: `${quote.cycleLabel} discount (${quote.cycleDiscountPercent}%)`, amountPaise: -quote.cycleDiscountPaise }] : []),
        ...(quote.offer ? [{ label: `Offer ${quote.offer.code}`, amountPaise: -quote.offer.discountPaise }] : []),
        ...(quote.creditPaise ? [{ label: "Credit for unused time on the previous plan", amountPaise: -quote.creditPaise }] : []),
      ];
      taxablePaise = quote.taxablePaise;
      gstPaise = quote.gstPaise;
    } else {
      // older payments and auto-renewals: work the taxable value back from what was paid
      taxablePaise = Math.round(payment.amount / (1 + gstPercent / 100));
      gstPaise = payment.amount - taxablePaise;
      const months = payment.terms?.cycleMonths ?? 1;
      lines = [
        {
          description: `${planName} plan${payment.kind === "auto_renew" ? " (auto-renewal)" : ""}${period}`,
          sac,
          quantity: months,
          unitPaise: Math.round(taxablePaise / months),
          amountPaise: taxablePaise,
        },
      ];
    }

    const sameState = InvoiceBuilder.sameState(seller.state, buyer.state);
    const half = Math.floor(gstPaise / 2);
    const taxes = sameState
      ? [
          { label: "CGST", percent: gstPercent / 2, amountPaise: half },
          { label: "SGST", percent: gstPercent / 2, amountPaise: gstPaise - half },
        ]
      : [{ label: "IGST", percent: gstPercent, amountPaise: gstPaise }];

    return {
      ndid: payment.ndid,
      orderId: payment.orderId,
      paymentId: payment.paymentId,
      issuedAt,
      seller: {
        name: seller.name,
        addressLines: seller.address.split("\n").map((l) => l.trim()).filter(Boolean),
        state: seller.state || null,
        gstin: seller.gstin || null,
        email: seller.email || null,
        phone: seller.phone || null,
        pan: seller.pan || null,
      },
      buyer,
      placeOfSupply: buyer.state,
      lines,
      adjustments,
      taxablePaise,
      taxes,
      totalPaise: taxablePaise + gstPaise,
      currency: payment.currency || settings.currency,
      periodStart: periodStart ? new Date(periodStart) : null,
      periodEnd: periodEnd ? new Date(periodEnd) : null,
    };
  }

  static sameState(a: string | null | undefined, b: string | null | undefined): boolean {
    const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
    return Boolean(norm(a)) && norm(a) === norm(b);
  }

  /** "26-27" for any day from 1 April 2026 to 31 March 2027, India time. */
  static financialYear(at: Date): string {
    const ist = new Date(at.getTime() + IST_OFFSET_MS);
    const year = ist.getUTCFullYear() % 100;
    const start = ist.getUTCMonth() >= 3 ? year : year - 1;
    const pad = (n: number) => String((n + 100) % 100).padStart(2, "0");
    return `${pad(start)}-${pad(start + 1)}`;
  }

  static number(prefix: string, yearKey: string, seq: number): string {
    return `${prefix || "EZ"}/${yearKey}/${String(seq).padStart(5, "0")}`;
  }

  /** "Indian Rupees One Thousand Two Hundred Fifty Six and Sixty Nine Paise Only" (lakh/crore). */
  static amountInWords(paise: number): string {
    const rupees = Math.floor(paise / 100);
    const rest = paise % 100;
    const words = `Indian Rupees ${InvoiceBuilder.words(rupees) || "Zero"}`;
    return `${words}${rest ? ` and ${InvoiceBuilder.words(rest)} Paise` : ""} Only`;
  }

  private static words(n: number): string {
    const below100 = (x: number) => (x < 20 ? ONES[x]! : `${TENS[Math.floor(x / 10)]}${x % 10 ? ` ${ONES[x % 10]}` : ""}`);
    const below1000 = (x: number) =>
      [x >= 100 ? `${ONES[Math.floor(x / 100)]} Hundred` : "", below100(x % 100)].filter(Boolean).join(" ");
    const parts: string[] = [];
    const crore = Math.floor(n / 10_000_000);
    const lakh = Math.floor((n % 10_000_000) / 100_000);
    const thousand = Math.floor((n % 100_000) / 1000);
    const rest = n % 1000;
    if (crore) parts.push(`${InvoiceBuilder.words(crore)} Crore`);
    if (lakh) parts.push(`${below100(lakh)} Lakh`);
    if (thousand) parts.push(`${below100(thousand)} Thousand`);
    if (rest) parts.push(below1000(rest));
    return parts.join(" ");
  }
}
