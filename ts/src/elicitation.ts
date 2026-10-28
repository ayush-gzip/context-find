export interface FormField {
  key: string;
  question: string;
  required: boolean;
  type: string;
  options: { label: string; value: any }[];
  other: boolean;
  multi: boolean;
  secret: boolean;
}

/** Supported MCP form fields. Complex schemas stay explicit instead of accepting null. */
export function formFields(schema: any): FormField[] | undefined {
  if (!schema || (schema.type && schema.type !== "object") || !schema.properties) return;
  const fields: FormField[] = [];
  for (const [key, raw] of Object.entries(schema.properties)) {
    const p: any = raw;
    if (!p || typeof p !== "object") return;
    const type = p.type || "string", multi = type === "array", choices = multi ? p.items : p;
    if (!["string", "integer", "number", "boolean", "array"].includes(type)) return;
    let options: FormField["options"] = [];
    if (Array.isArray(choices?.enum))
      options = choices.enum.map((value: any, i: number) => ({ value, label: String(choices.enumNames?.[i] ?? value) }));
    else if (Array.isArray(choices?.oneOf)) {
      if (!choices.oneOf.every((v: any) => Object.hasOwn(v, "const"))) return;
      options = choices.oneOf.map((v: any) => ({ value: v.const, label: String(v.title ?? v.const) }));
    } else if (type === "boolean") options = [{ label: "Yes", value: true }, { label: "No", value: false }];
    if (multi && !options.length) return;
    fields.push({ key, question: String(p.title || p.description || key),
      required: schema.required?.includes(key) ?? false, type, options,
      other: !options.length, multi, secret: p.format === "password" });
  }
  return fields;
}

export function formContent(schema: any, values: any) {
  const fields = formFields(schema);
  if (!fields || !values || typeof values !== "object" || Array.isArray(values))
    throw new Error("This form cannot be answered here");
  const result: Record<string, any> = {};
  for (const field of fields) {
    const value = values[field.key], p = schema.properties[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new Error(`Answer required: ${field.question}`);
      continue;
    }
    if ((field.type === "string" && typeof value !== "string") ||
      (field.type === "boolean" && typeof value !== "boolean") ||
      (["integer", "number"].includes(field.type) && (typeof value !== "number" || !Number.isFinite(value))) ||
      (field.type === "integer" && !Number.isInteger(value)) ||
      (field.multi && !Array.isArray(value))) throw new Error(`Invalid answer: ${field.question}`);
    const selected = field.multi ? value : [value];
    if (field.options.length && selected.some((v: any) => !field.options.some(o => JSON.stringify(o.value) === JSON.stringify(v))))
      throw new Error(`Invalid choice: ${field.question}`);
    if (typeof value === "string" && ((p.minLength != null && value.length < p.minLength) || (p.maxLength != null && value.length > p.maxLength)))
      throw new Error(`Invalid answer length: ${field.question}`);
    if (typeof value === "number" && ((p.minimum != null && value < p.minimum) || (p.maximum != null && value > p.maximum)))
      throw new Error(`Answer out of range: ${field.question}`);
    if (Array.isArray(value) && ((p.minItems != null && value.length < p.minItems) || (p.maxItems != null && value.length > p.maxItems)))
      throw new Error(`Invalid number of choices: ${field.question}`);
    result[field.key] = value;
  }
  return result;
}
