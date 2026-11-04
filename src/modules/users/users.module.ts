import type { AppModule } from "../../shared/module/app-module.js";
import { UserRepository } from "./repositories/user.repository.js";
import { UsersService } from "./services/users.service.js";
import type { UsersPort } from "./types/users.types.js";

/**
 * Dashboard users (Zucks_users). For now it is the data layer auth needs; team
 * management (/user/create, /user/edit, roles, invites) lands here next, with routes.
 */
export class UsersModule implements AppModule {
  readonly name = "users";
  readonly port: UsersPort;

  constructor() {
    this.port = new UsersService(new UserRepository());
  }
}
