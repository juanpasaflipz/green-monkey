import { z } from "zod";
import { id } from "./domain.js";
export const restaurantSettings = z
  .object({
    operationId: id,
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    currency: z
      .string()
      .refine((value) => Intl.supportedValuesOf("currency").includes(value)),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return !/^[+-]/.test(value);
      } catch {
        return false;
      }
    }),
    cutoff: z.number().int().min(0).max(1439),
    openingDays: z
      .array(z.number().int().min(1).max(7))
      .max(7)
      .refine((days) => new Set(days).size === days.length),
  })
  .strict();
