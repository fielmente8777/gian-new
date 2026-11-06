// Public API of the client-services module. Other modules import from here only.
export { ClientServicesModule, type ClientServicesModuleDeps } from "./client-services.module.js";
export { clientServicesConfig, type ClientServicesConfig } from "./config/client-services.config.js";
export {
  ServiceEnforcer,
  type ApplyResult,
  type DigestRecipients,
  type EffectiveServices,
} from "./services/service-enforcer.js";
export {
  CLIENT_SERVICES,
  type ClientServiceName,
  type ClientServiceStates,
  type ClientServicesPort,
  type PendingLeadAlert,
  type ReleasedLeads,
  type ServiceState,
} from "./types/client-services.types.js";
