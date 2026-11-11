const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches an email address on any of these domains, any letter case: ["eazotel.com"] → /@(eazotel\.com)$/i */
export function emailDomainPattern(domains: string[]): RegExp {
  return new RegExp(`@(${domains.map((d) => escapeRegex(d.trim().replace(/^@/, ""))).join("|")})$`, "i");
}
