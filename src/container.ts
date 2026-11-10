import type { Config } from "./config/index.js";
import { MailerFactory } from "./integrations/mail/mailer.js";
import { AdminModule } from "./modules/admin/index.js";
import { AuthModule } from "./modules/auth/index.js";
import { BillingModule } from "./modules/billing/index.js";
import { HealthModule } from "./modules/health/index.js";
import { ClientArchiveModule } from "./modules/client-archive/index.js";
import { ClientServicesModule } from "./modules/client-services/index.js";
import { HotelNotificationsModule } from "./modules/hotel-notifications/index.js";
import { MetaPagesModule } from "./modules/meta-pages/index.js";
import { ProfilesModule } from "./modules/profiles/index.js";
import { SubscriptionsModule } from "./modules/subscriptions/index.js";
import { UsersModule } from "./modules/users/index.js";
import { Database } from "./shared/database/database.js";
import { EventBus } from "./shared/events/event-bus.js";
import { LoggerFactory, type Logger } from "./shared/logger/logger.js";
import type { AppModule } from "./shared/module/app-module.js";

/**
 * Composition root: builds the shared infrastructure, then each module in dependency
 * order, handing each one only what it needs from the others. Nothing else lives here;
 * every module wires its own classes in its *.module.ts.
 */
export class Container {
  readonly logger: Logger;
  readonly database: Database;
  readonly events: EventBus;
  readonly modules: readonly AppModule[];

  constructor(readonly config: Config) {
    this.logger = LoggerFactory.create(config.app);
    this.database = new Database(config.database, this.logger);
    this.events = new EventBus(this.logger);

    const health = new HealthModule({ database: this.database });
    const users = new UsersModule();
    const profiles = new ProfilesModule();
    const subscriptions = new SubscriptionsModule();
    const clientArchive = new ClientArchiveModule();
    const hotelNotifications = new HotelNotificationsModule();
    const metaPages = new MetaPagesModule();
    const mailer = MailerFactory.create(config.mail, config.app.APP_ENV, this.logger);
    const clientServices = new ClientServicesModule({
      config: config.clientServices,
      subscriptions: subscriptions.port,
      mailer,
      logger: this.logger,
      // the catch-up email goes to the hotel's email, else to whoever holds its account
      recipients: async (ndid) => {
        const profile = await profiles.port.findByNdid(ndid);
        const to = profile?.hotelEmail ?? (await users.port.findOwnerByNdid(ndid))?.email;
        return { to: to ? [to] : [], hotelName: profile?.hotelName ?? null };
      },
    });
    const auth = new AuthModule({ config: config.auth, logger: this.logger, events: this.events, users: users.port });
    const billing = new BillingModule({
      logger: this.logger,
      mailer,
      razorpay: config.razorpay,
      auth: auth.authenticate,
      subscriptions: subscriptions.billing,
      // a paid period turns the chatbot and lead alerts back on and releases held leads
      afterActivation: async (ndid) => {
        await clientServices.enforcer.apply(ndid);
      },
      recipients: async (ndid) => {
        const profile = await profiles.port.findByNdid(ndid);
        const owner = await users.port.findOwnerByNdid(ndid);
        const to = [...new Set([owner?.email, profile?.hotelEmail].filter((e): e is string => Boolean(e)))];
        return { to, hotelName: profile?.hotelName ?? null };
      },
      // name, emails and the first property's address, for checkout and invoices
      hotel: async (ndid) => {
        const [profile, owner] = await Promise.all([profiles.port.findByNdid(ndid), users.port.findOwnerByNdid(ndid)]);
        const property = profile?.properties[0];
        return {
          hotelName: profile?.hotelName ?? null,
          hotelEmail: profile?.hotelEmail ?? null,
          hotelPhone: profile?.hotelPhone ?? null,
          ownerEmail: owner?.email ?? null,
          city: property?.city ?? null,
          state: property?.state ?? null,
          pinCode: property?.pinCode ?? null,
        };
      },
    });
    const admin = new AdminModule({
      config: config.admin,
      authConfig: config.auth,
      logger: this.logger,
      events: this.events,
      mailer,
      profiles: profiles.port,
      users: users.port,
      clientAccounts: auth.clientAccountTokens,
      serviceControl: { store: clientServices.port, enforcer: clientServices.enforcer },
      subscriptions: subscriptions.port,
      clientArchive: clientArchive.port,
      hotelNotifications: hotelNotifications.port,
      billing: billing.port,
      metaPages: metaPages.port,
    });

    this.modules = [
      health,
      users,
      profiles,
      subscriptions,
      clientServices,
      clientArchive,
      hotelNotifications,
      metaPages,
      auth,
      billing,
      admin,
    ];
  }
}
