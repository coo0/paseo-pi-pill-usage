import { z } from "zod";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const pathSchema = z.string().regex(/^[A-Za-z0-9_-]+(?:\[\d+\]|\.[A-Za-z0-9_-]+)*$/);
const accountSchema = z.object({
  provider: z.string().min(1), baseUrl: z.string().url(), apiKey: z.string().refine(value => value.trim().length > 0),
  probe: z.object({ url: z.string().default("{{baseUrl}}/usage"), method: z.enum(["GET", "POST"]).default("GET"), headers: z.record(z.string(), z.string()).default({ Authorization: "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" }), extract: z.object({ isValid: pathSchema.default("isValid"), remaining: pathSchema.default("quota.remaining"), unit: pathSchema.default("unit"), total: pathSchema.default("total") }).prefault({}) }).prefault({}),
});
export const configSchema = z.object({ providers: z.array(accountSchema).default([]), accounts: z.array(accountSchema).default([]), timeoutMs: z.number().int().positive().max(30000).default(8000), cacheMs: z.number().int().positive().max(300000).default(15000) }).transform(({ providers, accounts, ...options }) => ({ ...options, providers: [...providers, ...accounts] }));
export type Config = z.infer<typeof configSchema>;
export type Account = z.infer<typeof accountSchema>;
export async function loadConfig(): Promise<Config> { const file = process.env.ACCOUNT_CONTEXT_CONFIG_FILE || path.join(homedir(), ".paseo", "account-context.config.json"); return configSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
export function providerOf(model: string | null): string | null { if (!model) return null; const slash = model.indexOf("/"); return slash > 0 ? model.slice(0, slash) : null; }
export function matchAccount(config: Config, provider: string | null): Account | undefined { const matches = config.providers.filter(account => account.provider === provider); return matches.length === 1 ? matches[0] : undefined; }
