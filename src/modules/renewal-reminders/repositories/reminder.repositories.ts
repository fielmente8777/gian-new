import mongoose, { Types } from "mongoose";

import {
  DEFAULT_REMINDER_SETTINGS,
  type NewReminderLogEntry,
  type ReminderLogEntry,
  type ReminderLogStore,
  type ReminderSettings,
  type ReminderSettingsInput,
  type ReminderSettingsStore,
} from "../types/reminders.types.js";

const SETTINGS_ID = "default";

/** reminder_settings: one document. A missing document or field falls back to the defaults. */
export class ReminderSettingsRepository implements ReminderSettingsStore {
  private get collection() {
    return mongoose.connection.collection<{ _id: string } & Partial<ReminderSettings>>("reminder_settings");
  }

  async get(): Promise<ReminderSettings> {
    const doc = await this.collection.findOne({ _id: SETTINGS_ID });
    if (!doc) return { ...DEFAULT_REMINDER_SETTINGS };
    const { _id, ...saved } = doc;
    return {
      ...DEFAULT_REMINDER_SETTINGS,
      ...saved,
      channels: { ...DEFAULT_REMINDER_SETTINGS.channels, ...saved.channels },
      whatsappTemplate: { ...DEFAULT_REMINDER_SETTINGS.whatsappTemplate, ...saved.whatsappTemplate },
    };
  }

  async save(input: ReminderSettingsInput, by: string, now: Date): Promise<ReminderSettings> {
    await this.collection.updateOne(
      { _id: SETTINGS_ID },
      { $set: { ...input, updatedAt: now, updatedBy: by } },
      { upsert: true },
    );
    return this.get();
  }
}

type LogDocument = Omit<ReminderLogEntry, "id"> & { _id: Types.ObjectId };

/** reminder_log: one document per reminder, unique by key. */
export class ReminderLogRepository implements ReminderLogStore {
  private get collection() {
    return mongoose.connection.collection<LogDocument>("reminder_log");
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ key: 1 }, { unique: true });
    await this.collection.createIndex({ sentAt: -1 });
    await this.collection.createIndex({ ndid: 1, sentAt: -1 });
  }

  async claim(entry: NewReminderLogEntry): Promise<boolean> {
    try {
      await this.collection.insertOne({ _id: new Types.ObjectId(), ...entry });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  async finish(key: string, result: Pick<ReminderLogEntry, "email" | "whatsapp" | "sentAt">): Promise<void> {
    await this.collection.updateOne({ key }, { $set: result });
  }

  async list({ limit, ndid, before }: { limit: number; ndid?: string; before?: Date }): Promise<ReminderLogEntry[]> {
    const docs = await this.collection
      .find({ ...(ndid ? { ndid } : {}), ...(before ? { sentAt: { $lt: before } } : {}) })
      .sort({ sentAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id.toHexString(), ...rest }));
  }
}
