const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === "string",
  integer: Number.isInteger,
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean"
};

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateValue(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type) {
    const check = TYPE_CHECKS[schema.type];
    if (!check) {
      errors.push(`${path} 使用了不支持的参数类型 ${schema.type}`);
      return;
    }
    if (!check(value)) {
      errors.push(`${path} 应为 ${schema.type}，实际为 ${describeValue(value)}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join("、")} 之一`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} 不能大于 ${schema.maximum}`);
    }
  }

  if (schema.type === "object") {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) {
        errors.push(`缺少必填参数 ${key}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) {
          errors.push(`不支持参数 ${key}`);
        }
        continue;
      }
      validateValue(properties[key], child, key, errors);
    }
  }

  if (schema.type === "array" && schema.items) {
    value.forEach((item, index) => {
      validateValue(schema.items, item, `${path}[${index}]`, errors);
    });
  }
}

export function validateToolArguments(schema, args) {
  const errors = [];
  validateValue(schema || { type: "object" }, args, "工具参数", errors);
  if (!errors.length) return;

  const error = new Error(`工具参数不合法：${errors[0]}`);
  error.status = 400;
  error.code = "TOOL_ARGUMENTS_INVALID";
  error.details = errors;
  throw error;
}
