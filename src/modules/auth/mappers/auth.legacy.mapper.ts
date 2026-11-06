import { z } from "zod";

// The exact response bodies nexon sends on its login paths (controller/eazotel.py,
// controller/users.py, controller/admin.py). Keys, casing and messages are part of the
// contract: the dashboard, onboarding app and Android app read them. Do not "fix" them.

export const legacyStatusSchema = z.object({
  Status: z.boolean(),
  Message: z.string().optional().meta({ example: "Login Successfully" }),
  Token: z.string().optional().meta({ description: 'nexon-style token, or "-" on failure' }),
});

export const legacyGoogleSchema = z.object({
  status: z.boolean(),
  message: z.string().meta({ example: "User logged in successfully" }),
  token: z.string().nullable(),
  onboarding: z.boolean(),
});

export type LegacyStatusBody = z.infer<typeof legacyStatusSchema>;
export type LegacyGoogleBody = z.infer<typeof legacyGoogleSchema>;

export class AuthLegacyMapper {
  static loginOk(token: string): LegacyStatusBody {
    return { Status: true, Message: "Login Successfully", Token: token };
  }

  static loginFailed(): LegacyStatusBody {
    return { Status: false, Message: "Invalid Combinations", Token: "-" };
  }

  static registered(token: string): LegacyStatusBody {
    return { Status: true, Message: "Registered Successfully", Token: token };
  }

  static alreadyRegistered(): LegacyStatusBody {
    return { Status: false, Message: "User Already Registered", Token: "-" };
  }

  static passwordChanged(): LegacyStatusBody {
    return { Status: true, Message: "Password Changed Successfully" };
  }

  static passwordNotChanged(): LegacyStatusBody {
    return { Status: false, Message: "Invalid Combination" };
  }

  /** nexon's catch-all `except: return {"Status": False}` */
  static failure(): LegacyStatusBody {
    return { Status: false };
  }

  static googleOk(token: string, created: boolean, onboarding: boolean): LegacyGoogleBody {
    return created
      ? { status: true, message: "Registered Successfully", token, onboarding: false }
      : { status: true, message: "User logged in successfully", token, onboarding };
  }

  static googleInactive(): LegacyGoogleBody {
    return { status: false, message: "Account inactive. Please contact admin.", token: null, onboarding: false };
  }

  /** nexon answers a bad or missing Google token with HTTP 500 and this shape */
  static googleError(message: string): { Message: string; Status: false } {
    return { Message: message, Status: false };
  }
}
