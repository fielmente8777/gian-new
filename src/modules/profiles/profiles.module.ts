import type { AppModule } from "../../shared/module/app-module.js";
import { ProfileRepository } from "./repositories/profile.repository.js";
import type { ProfilesPort } from "./types/profiles.types.js";

/**
 * Client profiles (Zucks_profile): the hotel group and its properties. For now the data
 * layer the admin console needs; the hotel dashboard's own profile routes land here later.
 */
export class ProfilesModule implements AppModule {
  readonly name = "profiles";
  readonly port: ProfilesPort = new ProfileRepository();
}
