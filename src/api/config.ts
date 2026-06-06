// Shared API config constants, in their own module so route modules and
// index.tsx can both import them without a circular dependency.

import { getEnvOptional } from "../shared/env.ts";

export const PUBLIC_URL =
  getEnvOptional("BLURPADURP_PUBLIC_URL") ?? "http://localhost:3000";
