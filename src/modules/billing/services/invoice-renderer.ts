import { PdfDocument, type Rgb } from "../../../shared/pdf/pdf-document.js";
import type { InvoiceParty, InvoiceRecord } from "../types/billing.types.js";
import { InvoiceBuilder } from "./invoice-builder.js";

const NAVY: Rgb = [0.082, 0.145, 0.278];
const MUTED: Rgb = [0.42, 0.45, 0.5];
const RULE: Rgb = [0.85, 0.87, 0.9];
const BAND: Rgb = [0.95, 0.96, 0.98];
const LEFT = 40;
const RIGHT = 555;

const money = (paise: number) =>
  (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date | null) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "-";

/** Lays an invoice out on an A4 page. Same data in, same PDF out. */
export class InvoiceRenderer {
  static render(invoice: InvoiceRecord): Buffer {
    const pdf = new PdfDocument();
    const isTaxInvoice = Boolean(invoice.seller.gstin);

    // header
    pdf.text(invoice.seller.name, LEFT, 56, { size: 16, bold: true, color: NAVY });
    pdf.text(isTaxInvoice ? "TAX INVOICE" : "INVOICE", RIGHT, 56, { size: 16, bold: true, color: NAVY, align: "right" });
    let y = InvoiceRenderer.party(pdf, invoice.seller, LEFT, 74, false);

    const meta: [string, string][] = [
      ["Invoice no.", invoice.number],
      ["Invoice date", day(invoice.issuedAt)],
      ["Payment ID", invoice.paymentId ?? "-"],
      ["Place of supply", invoice.placeOfSupply ?? "-"],
    ];
    meta.forEach(([label, value], i) => {
      pdf.text(label, 400, 80 + i * 14, { size: 9, color: MUTED });
      pdf.text(value, RIGHT, 80 + i * 14, { size: 9, bold: i === 0, align: "right" });
    });
    y = Math.max(y, 80 + meta.length * 14) + 14;

    // bill to
    pdf.line(LEFT, y, RIGHT, y, { color: RULE });
    y += 18;
    pdf.text("BILL TO", LEFT, y, { size: 8, bold: true, color: MUTED });
    y = InvoiceRenderer.party(pdf, invoice.buyer, LEFT, y + 14, true) + 12;

    // lines
    const cols = { no: LEFT + 8, desc: LEFT + 28, sac: 330, qty: 395, rate: 470, amount: RIGHT - 8 };
    pdf.rect(LEFT, y, RIGHT - LEFT, 22, { fill: BAND });
    const head = y + 14.5;
    pdf.text("#", cols.no, head, { size: 8, bold: true, color: MUTED });
    pdf.text("DESCRIPTION", cols.desc, head, { size: 8, bold: true, color: MUTED });
    pdf.text("SAC", cols.sac, head, { size: 8, bold: true, color: MUTED });
    pdf.text("MONTHS", cols.qty, head, { size: 8, bold: true, color: MUTED, align: "right" });
    pdf.text("RATE / MONTH", cols.rate, head, { size: 8, bold: true, color: MUTED, align: "right" });
    pdf.text("AMOUNT (INR)", cols.amount, head, { size: 8, bold: true, color: MUTED, align: "right" });
    y += 22;

    invoice.lines.forEach((line, i) => {
      const wrapped = PdfDocument.wrap(line.description, cols.sac - cols.desc - 10, 9);
      const top = y + 15;
      pdf.text(String(i + 1), cols.no, top, { size: 9 });
      pdf.lines(wrapped, cols.desc, top, { size: 9, lineHeight: 12 });
      pdf.text(line.sac ?? "-", cols.sac, top, { size: 9 });
      pdf.text(String(line.quantity), cols.qty, top, { size: 9, align: "right" });
      pdf.text(money(line.unitPaise), cols.rate, top, { size: 9, align: "right" });
      pdf.text(money(line.amountPaise), cols.amount, top, { size: 9, align: "right" });
      y += Math.max(24, wrapped.length * 12 + 12);
      pdf.line(LEFT, y, RIGHT, y, { color: RULE });
    });

    // totals
    y += 16;
    const label = 400;
    const row = (text: string, value: string, bold = false) => {
      pdf.text(text, label, y, { size: 9, bold, color: bold ? NAVY : MUTED, align: "right" });
      pdf.text(value, cols.amount, y, { size: 9, bold, align: "right" });
      y += 15;
    };
    const subtotal = invoice.lines.reduce((sum, l) => sum + l.amountPaise, 0);
    if (invoice.adjustments.length) {
      row("Subtotal", money(subtotal));
      for (const a of invoice.adjustments) row(a.label, `- ${money(-a.amountPaise)}`);
    }
    row("Taxable value", money(invoice.taxablePaise), true);
    for (const t of invoice.taxes) row(`${t.label} @ ${t.percent}%`, money(t.amountPaise));
    y += 4;
    pdf.rect(330, y - 11, RIGHT - 330, 24, { fill: BAND });
    pdf.text("Total", label, y + 4, { size: 11, bold: true, color: NAVY, align: "right" });
    pdf.text(`INR ${money(invoice.totalPaise)}`, cols.amount, y + 4, { size: 11, bold: true, align: "right" });
    y += 30;

    const words = PdfDocument.wrap(InvoiceBuilder.amountInWords(invoice.totalPaise), RIGHT - LEFT, 9);
    pdf.text("Amount in words", LEFT, y, { size: 8, bold: true, color: MUTED });
    y = pdf.lines(words, LEFT, y + 13, { size: 9 }) + 8;
    pdf.text(
      `Paid online through Razorpay${invoice.paymentId ? ` (payment ${invoice.paymentId})` : ""}. Thank you for your business.`,
      LEFT,
      y,
      { size: 9, color: MUTED },
    );

    // footer
    pdf.line(LEFT, 790, RIGHT, 790, { color: RULE });
    pdf.text("This is a computer-generated invoice and does not need a signature.", LEFT, 806, { size: 8, color: MUTED });
    if (invoice.seller.email) pdf.text(invoice.seller.email, RIGHT, 806, { size: 8, color: MUTED, align: "right" });
    return pdf.toBuffer();
  }

  /** Name, address, state, GSTIN, contact; returns the y below. */
  private static party(pdf: PdfDocument, party: InvoiceParty, x: number, y: number, bold: boolean): number {
    if (bold) {
      pdf.text(party.name, x, y, { size: 10, bold: true });
      y += 14;
    }
    const rows = [
      ...party.addressLines,
      ...(party.state ? [`State: ${party.state}`] : []),
      ...(party.gstin ? [`GSTIN: ${party.gstin}`] : []),
      ...(party.pan ? [`PAN: ${party.pan}`] : []),
      [party.email, party.phone].filter(Boolean).join("  |  "),
    ].filter(Boolean);
    return pdf.lines(rows.flatMap((r) => PdfDocument.wrap(r, 320, 9)), x, y, { size: 9, color: MUTED, lineHeight: 12.5 });
  }
}
