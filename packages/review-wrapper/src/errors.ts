/** Exit codes of `orchestra-review` (design.md §9.8, GOT.40 contract). */
export const ExitCode = {
  clean: 0,
  findings: 1,
  ask_user: 2,
  error: 3,
} as const;

/** Any failure that ends the run with exit 3. `message` goes to stderr. */
export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

export const USAGE = "usage: orchestra-review --round <n>   (n is an integer >= 1)";
