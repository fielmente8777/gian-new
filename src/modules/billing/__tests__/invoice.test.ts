import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PdfDocument } from "../../../shared/pdf/pdf-document.js";
import { DEFAULT_BILLING_SETTINGS } from "../constants/billing.constants.js";
import { InvoiceBuilder } from "../services/invoice-builder.js";
import { InvoiceRenderer } from "../services/invoice-renderer.js";
import { PriceCalculator } from "../services/price-calculator.js";
import type { InvoiceParty, PaymentRecord } from "../types/billing.types.js";
import { CAT_APPS, planByCode } from "./fakes.js";

const NOW = new Date("2026-11-06T10:00:00Z");
const settings = {
  ...DEFAULT_BILLING_SETTINGS,
  invoice: { ...DEFAULT_BILLING_SETTINGS.invoice, state: "Rajasthan", gstin: "08ABCDE1234F1Z5", sac: "998314", address: "Plot 1\nJaipur" },
  updatedAt: null,
  updatedBy: null,
};
const buyer = (state: string): InvoiceParty => ({
  name: "Hotel Amaltas Pvt Ltd",
  addressLines: ["MG Road", "Jaipur - 302001"],
  state,
  gstin: "08AAACH1234K1Z2",
  email: "accounts@amaltas.test",
  phone: null,
});

const quote = PriceCalculator.quote({
  settings,
  plan: planByCode("PRO"),
  catalogue: CAT_APPS,
  cycleMonths: 12,
  addonCodes: ["exotel"],
  seats: 1,
  kind: "new",
  periodStart: NOW,
  creditPaise: 0,
  offer: null,
  offerError: null,
});

const payment = (extra: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: "p1",
  ndid: "h1",
  orderId: "order_1",
  paymentId: "pay_1",
  planId: planByCode("PRO").id,
  amount: quote.totalPaise,
  currency: "INR",
  status: "SUCCESS",
  method: "upi",
  paidAt: NOW,
  createdAt: NOW,
  source: "gian-new",
  kind: "new",
  terms: { planId: planByCode("PRO").id, planCode: "PRO", cycleMonths: 12, addonCodes: ["exotel"], seats: 1 },
  quote,
  offerCode: null,
  periodStart: quote.periodStart,
  periodEnd: quote.periodEnd,
  appliedAt: NOW,
  autoRenewRequested: false,
  failureReason: null,
  createdBy: "owner@hotel.test",
  ...extra,
});

describe("InvoiceBuilder", () => {
  it("itemises a payment and splits GST into CGST + SGST within the same state", () => {
    const inv = InvoiceBuilder.build({ payment: payment(), settings, buyer: buyer("rajasthan"), planName: "Pro", issuedAt: NOW });
    assert.equal(inv.lines.length, 3, "plan, add-on, seats");
    assert.equal(inv.lines[0]!.quantity, 12);
    assert.equal(inv.lines[0]!.sac, "998314");
    assert.equal(inv.adjustments[0]!.amountPaise, -quote.cycleDiscountPaise);
    assert.deepEqual(inv.taxes.map((t) => [t.label, t.percent]), [["CGST", 9], ["SGST", 9]]);
    assert.equal(inv.taxes[0]!.amountPaise + inv.taxes[1]!.amountPaise, quote.gstPaise);
    assert.equal(inv.totalPaise, quote.totalPaise);
    const lineTotal = inv.lines.reduce((s, l) => s + l.amountPaise, 0) + inv.adjustments.reduce((s, a) => s + a.amountPaise, 0);
    assert.equal(lineTotal, inv.taxablePaise, "lines minus discounts = taxable value");
  });

  it("charges IGST to a hotel in another state", () => {
    const inv = InvoiceBuilder.build({ payment: payment(), settings, buyer: buyer("Maharashtra"), planName: "Pro", issuedAt: NOW });
    assert.deepEqual(inv.taxes.map((t) => [t.label, t.percent, t.amountPaise]), [["IGST", 18, quote.gstPaise]]);
    assert.equal(inv.placeOfSupply, "Maharashtra");
  });

  it("works an older payment or an auto-renewal back from the amount paid", () => {
    const inv = InvoiceBuilder.build({
      payment: payment({ quote: null, amount: 118_000, kind: "auto_renew" }),
      settings,
      buyer: buyer("Delhi"),
      planName: "Pro",
      issuedAt: NOW,
    });
    assert.equal(inv.taxablePaise, 100_000);
    assert.equal(inv.taxes[0]!.amountPaise, 18_000);
    assert.match(inv.lines[0]!.description, /auto-renewal/);
  });

  it("numbers per Indian financial year", () => {
    assert.equal(InvoiceBuilder.financialYear(new Date("2026-11-06T00:00:00Z")), "26-27");
    assert.equal(InvoiceBuilder.financialYear(new Date("2027-03-31T18:00:00Z")), "26-27", "still 31 March in India");
    assert.equal(InvoiceBuilder.financialYear(new Date("2027-03-31T19:00:00Z")), "27-28", "1 April 00:30 in India");
    assert.equal(InvoiceBuilder.number("EZ", "26-27", 42), "EZ/26-27/00042");
  });

  it("writes the amount in words, Indian style", () => {
    assert.equal(InvoiceBuilder.amountInWords(125_669), "Indian Rupees One Thousand Two Hundred Fifty Six and Sixty Nine Paise Only");
    assert.equal(InvoiceBuilder.amountInWords(1_23_45_678_00), "Indian Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only");
    assert.equal(InvoiceBuilder.amountInWords(118), "Indian Rupees One and Eighteen Paise Only");
  });
});

describe("InvoiceRenderer", () => {
  it("makes a valid PDF with the invoice's details", () => {
    const inv = InvoiceBuilder.build({ payment: payment(), settings, buyer: buyer("Rajasthan"), planName: "Pro", issuedAt: NOW });
    const pdf = InvoiceRenderer.render({ ...inv, id: "i1", number: "EZ/26-27/00001", emailedTo: [], lastEmailedAt: null });
    const text = pdf.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4"));
    assert.ok(text.trimEnd().endsWith("%%EOF"));
    assert.match(text, /TAX INVOICE/);
    assert.match(text, /EZ\/26-27\/00001/);
    assert.match(text, /CGST @ 9%/);
    assert.match(text, /GSTIN: 08AAACH1234K1Z2/);
    // the cross-reference table points at real objects
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    assert.equal(text.slice(xref, xref + 4), "xref");
  });

  it("simplifies characters the built-in fonts can't draw", () => {
    assert.equal(PdfDocument.clean("₹1,000 – Café ‘Ōm’"), "Rs. 1,000 - Cafe 'Om'");
  });
});
