// Public API of the newsletter module. Other modules import from here only.
export { NewsletterModule, type NewsletterModuleDeps } from "./newsletter.module.js";
export { newsletterConfig, type NewsletterConfig } from "./config/newsletter.config.js";
export { UnsubscribeLinks } from "./services/unsubscribe-links.js";
export type { HotelDirectory, HotelInfo, Subscriber, SubscriberStatus } from "./types/newsletter.types.js";
