/** Shared by scalar and component-wise vector arithmetic definitions. */
export const ARITHMETIC_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "+": ["+", "a + b", "plus", "sum"],
  "-": ["-", "−", "a - b", "minus"],
  "*": ["*", "×", "·", "a * b", "a × b", "product"],
  "/": ["/", "÷", "a / b", "quotient"],
  "%": ["%", "a % b", "mod", "remainder"],
};
