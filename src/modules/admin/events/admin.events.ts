// Events the admin module emits. AdminModule writes each one to the audit log.
declare module "../../../shared/events/event-bus.js" {
  interface DomainEvents {
    "admin.login_denied": { email: string; reason: "not_listed" | "disabled" | "google_mismatch"; ip?: string };
    "admin.login_code_sent": { adminId: string; email: string; ip?: string };
    "admin.logged_in": { adminId: string; email: string; ip?: string };
  }
}

export {};
