/**
 * A small PDF writer for documents made of text, lines and boxes (invoices, receipts), with no
 * dependency. Uses the two fonts every PDF reader has built in (Helvetica, Helvetica-Bold), so
 * text is limited to Latin characters: anything else is simplified (accents dropped, "₹" written
 * as "Rs.", dashes and quotes made plain).
 *
 *   const pdf = new PdfDocument();
 *   pdf.text("Invoice", 40, 50, { size: 18, bold: true });
 *   pdf.line(40, 60, 555, 60);
 *   const bytes = pdf.toBuffer();
 *
 * Coordinates are points (1/72 inch) from the TOP-LEFT of an A4 page (595 × 842).
 */

export type Rgb = readonly [number, number, number];

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: Rgb;
  /** `x` is the left edge, the right edge or the centre */
  align?: "left" | "right" | "center";
}

// Character widths (1/1000 em) of the standard fonts, ASCII 32–126, from Adobe's AFM files.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const BLACK: Rgb = [0, 0, 0];
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export class PdfDocument {
  static readonly WIDTH = 595.28;
  static readonly HEIGHT = 841.89;

  private readonly pages: string[][] = [[]];

  private get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  addPage(): void {
    this.pages.push([]);
  }

  /** Text the built-in fonts can draw. */
  static clean(text: string): string {
    return text
      .replace(/₹\s?/g, "Rs. ")
      .replace(/[–—−]/g, "-")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/•/g, "-")
      .replace(/ /g, " ")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\x20-\x7E]/g, "?");
  }

  static textWidth(text: string, size = 10, bold = false): number {
    const widths = bold ? HELVETICA_BOLD : HELVETICA;
    let total = 0;
    for (const ch of PdfDocument.clean(text)) total += widths[ch.charCodeAt(0) - 32] ?? 556;
    return (total * size) / 1000;
  }

  /** Splits text into lines no wider than `maxWidth`, breaking at spaces. */
  static wrap(text: string, maxWidth: number, size = 10, bold = false): string[] {
    const lines: string[] = [];
    for (const paragraph of PdfDocument.clean(text).split(/\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && PdfDocument.textWidth(next, size, bold) > maxWidth) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(text: string, x: number, y: number, { size = 10, bold = false, color = BLACK, align = "left" }: TextOptions = {}): void {
    const clean = PdfDocument.clean(text);
    const width = PdfDocument.textWidth(clean, size, bold);
    const left = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
    const escaped = clean.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    this.ops.push(
      `BT ${color.map(num).join(" ")} rg /${bold ? "F2" : "F1"} ${num(size)} Tf ${num(left)} ${num(PdfDocument.HEIGHT - y)} Td (${escaped}) Tj ET`,
    );
  }

  /** Several lines, `lineHeight` apart; returns the y below the last one. */
  lines(lines: string[], x: number, y: number, options: TextOptions & { lineHeight?: number } = {}): number {
    const step = options.lineHeight ?? (options.size ?? 10) * 1.4;
    lines.forEach((line, i) => this.text(line, x, y + i * step, options));
    return y + lines.length * step;
  }

  line(x1: number, y1: number, x2: number, y2: number, { color = BLACK, width = 0.5 }: { color?: Rgb; width?: number } = {}): void {
    const h = PdfDocument.HEIGHT;
    this.ops.push(`${color.map(num).join(" ")} RG ${num(width)} w ${num(x1)} ${num(h - y1)} m ${num(x2)} ${num(h - y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, { fill, stroke }: { fill?: Rgb; stroke?: Rgb } = {}): void {
    const top = PdfDocument.HEIGHT - y - h;
    const paint = fill && stroke ? "B" : fill ? "f" : "S";
    this.ops.push(
      `${fill ? `${fill.map(num).join(" ")} rg ` : ""}${stroke ? `${stroke.map(num).join(" ")} RG 0.5 w ` : ""}${num(x)} ${num(top)} ${num(w)} ${num(h)} re ${paint}`,
    );
  }

  /** The finished file. */
  toBuffer(): Buffer {
    const objects: string[] = [];
    // push returns the new length, which is the object number (they start at 1)
    const add = (body: string) => objects.push(body);
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add("PAGES"); // filled in below, once the page numbers are known
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join("\n");
      const contentId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
      pageIds.push(
        add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PdfDocument.WIDTH)} ${num(PdfDocument.HEIGHT)}] ` +
            `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
