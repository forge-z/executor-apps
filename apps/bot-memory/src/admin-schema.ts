import { array, jsonSchema, number, object, string, type Infer, type Schema } from "apps";

export function choice<const T extends string>(values: readonly T[]): Schema<T> {
  return jsonSchema({ type: "string", enum: values }) as Schema<T>;
}

const listedFact = object({ key: string(), text: string(), revision: number() });
export type ListedFact = Infer<typeof listedFact>;

export const listOutput = object({
  status: choice(["ok", "invalid_input"]),
  rows: array(listedFact),
  nextCursor: jsonSchema({ type: ["string", "null"] }) as Schema<string | null>,
});

export const forgetOutput = object({
  status: choice(["forgotten", "already_forgotten", "stale_revision", "not_found", "invalid_input"]),
});
