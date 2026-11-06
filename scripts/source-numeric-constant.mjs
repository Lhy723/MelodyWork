const integerLiteral = "\\d(?:_?\\d)*";
const integerProduct = new RegExp(
  "^" + integerLiteral + "(?:\\s*\\*\\s*" + integerLiteral + ")*$",
  "u",
);

/**
 * Read a bounded integer product from a TypeScript or Rust const declaration.
 * Unsupported expressions return undefined so callers can report contract drift.
 */
export const readNumericSourceConstant = (source, name) => {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) return undefined;

  const declaration = new RegExp(
    "(?:^|\\n)\\s*(?:(?:export|pub(?:\\([^)]*\\))?)\\s+)?const\\s+" +
      name +
      "\\b(?:\\s*:\\s*[^=;]+)?\\s*=\\s*([^;]+);",
    "u",
  );
  const match = source.match(declaration);
  if (!match) return undefined;

  const expression = match[1].trim();
  if (!integerProduct.test(expression)) return undefined;

  let result = 1;
  for (const term of expression.split("*")) {
    const factor = Number(term.trim().replaceAll("_", ""));
    if (!Number.isSafeInteger(factor)) return undefined;
    result *= factor;
    if (!Number.isSafeInteger(result)) return undefined;
  }
  return result;
};
