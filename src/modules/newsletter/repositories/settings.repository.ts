import mongoose from "mongoose";

import type { NewsletterSettings, SettingsStore } from "../types/newsletter.types.js";

interface SettingsDoc extends Omit<NewsletterSettings, "updatedAt"> {
  _id: string; // the ndid
  updatedAt: Date;
}

/** `newsletter_settings`: one document per client, keyed by ndid. Owned by newsletter. */
export class SettingsRepository implements SettingsStore {
  private get collection() {
    return mongoose.connection.collection<SettingsDoc>("newsletter_settings");
  }

  async get(ndid: string): Promise<NewsletterSettings | null> {
    const doc = await this.collection.findOne({ _id: ndid });
    return doc ? { welcome: doc.welcome, notifyOnSignup: doc.notifyOnSignup, updatedAt: doc.updatedAt } : null;
  }

  async save(ndid: string, settings: Omit<NewsletterSettings, "updatedAt">, now: Date): Promise<NewsletterSettings> {
    await this.collection.updateOne(
      { _id: ndid },
      { $set: { welcome: settings.welcome, notifyOnSignup: settings.notifyOnSignup, updatedAt: now } },
      { upsert: true },
    );
    return { ...settings, updatedAt: now };
  }
}
