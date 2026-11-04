/** Thrown at boot when one or more env variables are missing or invalid. Lists all of them. */
export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid environment (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nCompare your .env with .env.example.",
    );
    this.name = "EnvValidationError";
  }
}
