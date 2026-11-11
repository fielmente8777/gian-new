import type {
  ProfileChanges,
  ProfileRecord,
  ProfileSearch,
  ProfilesPort,
  PropertyRecord,
} from "../types/profiles.types.js";

/** In-memory Zucks_profile, with the same filtering and paging as ProfileRepository. */
export class InMemoryProfiles implements ProfilesPort {
  readonly rows = new Map<string, ProfileRecord>();

  add(ndid: string, hotelName: string, properties: Partial<PropertyRecord>[] = [{}]): ProfileRecord {
    const record: ProfileRecord = {
      ndid,
      hotelName,
      hotelDescription: null,
      hotelEmail: `${ndid}@hotel.test`,
      hotelPhone: null,
      marketingEmail: null,
      domain: `${ndid}.eazotel.com`,
      currency: "INR",
      isVerified: false,
      plan: null,
      onboardedAt: null,
      properties: properties.map((p, i) => ({
        hid: `${ndid}-h${i + 1}`,
        name: `${hotelName} ${i + 1}`,
        city: null,
        state: null,
        country: null,
        pinCode: null,
        ...p,
      })),
    };
    this.rows.set(ndid, record);
    return record;
  }

  async list({ limit, after, search, ndids, excludeNdids, orNdids }: ProfileSearch) {
    const needle = search?.toLowerCase();
    const matching = [...this.rows.values()]
      .sort((a, b) => a.ndid.localeCompare(b.ndid))
      .filter((r) => !ndids || ndids.includes(r.ndid))
      .filter((r) => !excludeNdids?.includes(r.ndid))
      .filter((r) => !after || r.ndid > after)
      .filter(
        (r) =>
          !needle ||
          r.ndid === search ||
          Boolean(orNdids?.includes(r.ndid)) ||
          [r.hotelName, r.domain, r.hotelEmail].some((v) => v?.toLowerCase().includes(needle)),
      );
    const items = matching.slice(0, limit);
    return { items, nextCursor: matching.length > limit ? (items.at(-1)?.ndid ?? null) : null };
  }

  async findByNdid(ndid: string) {
    return this.rows.get(ndid) ?? null;
  }

  async update(ndid: string, { profile, properties }: ProfileChanges) {
    const current = this.rows.get(ndid);
    if (!current) return null;
    const updated: ProfileRecord = {
      ...current,
      ...profile,
      properties: current.properties.map((p) => ({ ...p, ...properties[p.hid] })),
    };
    this.rows.set(ndid, updated);
    return updated;
  }
}
