import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const piBalanceRpc = defineRpc({
  name: "pi-usage.balance",
  input: z.object({ agent: z.string(), refresh: z.boolean().default(false) }),
  output: z.object({ balance: z.number().nullable(), unit: z.string().nullable(), total: z.number().nullable().optional() }),
});
export type PiBalance = z.infer<typeof piBalanceRpc.output>;
